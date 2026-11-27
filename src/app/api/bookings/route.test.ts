import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const supabaseMock = { from: vi.fn(), rpc: vi.fn() };
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => supabaseMock,
}));

const getClinicMock = vi.fn();
vi.mock("@/lib/clinics/context", () => ({
  getClinicFromRequest: () => getClinicMock(),
}));

const resolveMock = vi.fn();
const resolveExistingMock = vi.fn();
const getOrCreateMock = vi.fn();
vi.mock("@/lib/patients/identity", () => ({
  resolvePatientFromInitData: (...args: unknown[]) => resolveMock(...args),
  resolveExistingPatientFromInitData: (...args: unknown[]) => resolveExistingMock(...args),
  devIdentityAllowed: () => true,
  getOrCreateWebPatient: () => getOrCreateMock(),
}));
const onlineProfileMock = vi.fn();
vi.mock("@/lib/patients/online-identity", () => ({ onlineProfile: (...args: unknown[]) => onlineProfileMock(...args) }));

vi.mock("@/lib/rate-limit", () => ({
  rateLimit: () => ({ ok: true }),
  keyFromIp: () => "test-ip",
}));
vi.mock("@/lib/rate-limit-shared", () => ({ sharedRateLimit: async () => ({ ok: true, retryAfterSeconds: 0 }) }));

const escalateMock = vi.fn(async (..._args: unknown[]) => {});
vi.mock("@/lib/telegram/handlers", () => ({ escalateUrgentFromMiniApp: (...args: unknown[]) => escalateMock(...args) }));

vi.mock("@/lib/analytics", () => ({ trackAnalytics: vi.fn(async () => {}) }));
vi.mock("@/lib/notifications/jobs", () => ({ enqueueBookingNotifications: vi.fn(async () => {}) }));
const loggerMock = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock("@/lib/logger", () => ({ logger: loggerMock }));

import { POST } from "./route";
import { urgentMessage } from "@/lib/safety/policy";

const CLINIC = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Clinic A",
  timezone: "Asia/Tashkent",
  currency: "UZS",
  slug: "clinic-a",
};

function postReq(body: Record<string, unknown>): NextRequest {
  return new NextRequest("http://localhost/api/bookings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function stubSuccess() {
  getClinicMock.mockResolvedValue(CLINIC);
  resolveMock.mockResolvedValue({ patient: { id: "p-1" }, identity: { telegramUserId: 123 } });
  supabaseMock.from.mockImplementation((table: string) => {
    if (table === "patients") {
      return {
        update: vi.fn(() => ({ eq: vi.fn(() => ({ eq: vi.fn(async () => ({ data: null, error: null })) })) })),
        select: vi.fn(() => ({ eq: vi.fn(() => ({ eq: vi.fn(() => ({ single: vi.fn(async () => ({ data: { full_name: null, phone: null }, error: null })) })) })) })),
      };
    }
    return {
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          single: vi.fn(async () => ({
            data: { id: "a-1", status: "pending", patients: { full_name: "Ali Valiyev" } },
            error: null,
          })),
          maybeSingle: vi.fn(async () => ({
            data: table === "payments" ? { id: "pay-1", status: "unpaid", provider: "manual" } : null,
            error: null,
          })),
        })),
      })),
    };
  });
  supabaseMock.rpc.mockResolvedValue({
    data: { appointment_id: "a-1", amount: 80000, error_code: null, error_message: null },
    error: null,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("POST /api/bookings", () => {
  describe("clinic with identity required", () => {
    const booking = {
      doctorId: CLINIC.id,
      serviceId: CLINIC.id,
      startAt: "2030-01-07T05:00:00Z",
      patientName: "Test Bemor",
      phone: "+998900000000",
      consent: true,
    };
    beforeEach(() => {
      stubSuccess();
      getClinicMock.mockResolvedValue({ ...CLINIC, online_identity_required: true });
    });

    it.each([undefined, null, ""])("refuses web booking without a Telegram session (%s) before writing anything", async (initData) => {
      const res = await POST(postReq({ ...booking, initData }));
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ code: "identity_required" });
      expect(getOrCreateMock).not.toHaveBeenCalled();
      expect(resolveMock).not.toHaveBeenCalled();
      expect(resolveExistingMock).not.toHaveBeenCalled();
      expect(supabaseMock.from).not.toHaveBeenCalled();
      expect(supabaseMock.rpc).not.toHaveBeenCalled();
    });

    it("refuses invalid Telegram data without falling back to a website booking", async () => {
      resolveExistingMock.mockResolvedValue(null);
      const res = await POST(postReq({ ...booking, initData: "invalid" }));
      expect(res.status).toBe(401);
      expect(await res.json()).toMatchObject({ code: "invalid_init_data" });
      expect(resolveExistingMock).toHaveBeenCalledWith("invalid", CLINIC.id);
      expect(getOrCreateMock).not.toHaveBeenCalled();
      expect(supabaseMock.rpc).not.toHaveBeenCalled();
    });

    it.each([null, { id: "p-1" }])("refuses an absent or incomplete card before mutating it (%s)", async (patient) => {
      resolveExistingMock.mockResolvedValue({ patient });
      onlineProfileMock.mockResolvedValue({ complete: false });
      const res = await POST(postReq({ ...booking, initData: "signed" }));
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ code: "identity_required" });
      expect(resolveMock).not.toHaveBeenCalled();
      expect(supabaseMock.from).not.toHaveBeenCalled();
      expect(supabaseMock.rpc).not.toHaveBeenCalled();
    });

    it("books with a verified Telegram session and a completed card in that clinic", async () => {
      resolveExistingMock.mockResolvedValue({ patient: { id: "p-1" } });
      onlineProfileMock.mockResolvedValue({ complete: true });
      const res = await POST(postReq({ ...booking, initData: "signed" }));
      expect(res.status).toBe(201);
      expect(onlineProfileMock).toHaveBeenCalledWith(CLINIC.id, "p-1");
      expect(supabaseMock.rpc).toHaveBeenCalledWith("book_appointment", expect.objectContaining({ p_patient_id: "p-1" }));
    });
  });

  it("passes the patient's reason through as notes", async () => {
    stubSuccess();
    const res = await POST(
      postReq({
        doctorId: "11111111-1111-4111-8111-111111111111",
        serviceId: "11111111-1111-4111-8111-111111111111",
        startAt: "2030-01-07T05:00:00Z",
        patientName: "Ali Valiyev",
        phone: "+998901234567",
        consent: true,
        initData: "dev",
        notes: "   Bosh og‘rig‘i, ko‘rik uchun  ",
      }),
    );
    
    expect(res.status).toBe(201);
    const { p_notes } = supabaseMock.rpc.mock.calls[0][1] as { p_notes?: string };
    expect(p_notes).toBe("Bosh og‘rig‘i, ko‘rik uchun");
  });

  it("stops the booking and alerts staff when the reason is urgent wording (R-02)", async () => {
    stubSuccess();
    resolveMock.mockResolvedValue({ patient: { id: "p-1", telegram_user_id: 123 }, identity: { telegramUserId: 123 } });
    escalateMock.mockClear();
    const res = await POST(
      postReq({
        initData: "valid",
        doctorId: "22222222-2222-4222-8222-222222222222",
        serviceId: "33333333-3333-4333-8333-333333333333",
        startAt: "2030-01-01T05:00:00.000Z",
        patientName: "Ali Valiyev",
        phone: "+998901234567",
        consent: true,
        notes: "ko'kragim og'riyapti, nafas ololmayapman",
      }),
    );
    const body = await res.json();
    expect(res.status).toBe(409);
    expect(body.code).toBe("urgent_concern");
    // The clinic-approved urgent-care message, word for word — never an improvised one.
    expect(body.error).toBe(urgentMessage("ko'kragim og'riyapti, nafas ololmayapman"));
    // Nothing was booked, and staff were alerted for this patient in this clinic.
    expect(supabaseMock.rpc).not.toHaveBeenCalled();
    expect(escalateMock).toHaveBeenCalledTimes(1);
    expect(escalateMock.mock.calls[0][0]).toMatchObject({ clinicId: CLINIC.id, patientId: "p-1", telegramUserId: 123 });
  });

  it("still refuses an urgent reason when there is nobody to alert through Telegram (website booking)", async () => {
    stubSuccess();
    getOrCreateMock.mockResolvedValue({ id: "p-web" });
    escalateMock.mockClear();
    const res = await POST(
      postReq({
        doctorId: "22222222-2222-4222-8222-222222222222",
        serviceId: "33333333-3333-4333-8333-333333333333",
        startAt: "2030-01-01T05:00:00.000Z",
        patientName: "Ali Valiyev",
        phone: "+998901234567",
        consent: true,
        notes: "потерял сознание",
      }),
    );
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("urgent_concern");
    expect(supabaseMock.rpc).not.toHaveBeenCalled();
    expect(escalateMock).not.toHaveBeenCalled();
  });

  it("sends no notes when the reason is absent", async () => {
    stubSuccess();
    const res = await POST(
      postReq({
        doctorId: "11111111-1111-4111-8111-111111111111",
        serviceId: "11111111-1111-4111-8111-111111111111",
        startAt: "2030-01-07T05:00:00Z",
        patientName: "Ali Valiyev",
        phone: "+998901234567",
        consent: true,
        initData: "dev",
      }),
    );
    expect(res.status).toBe(201);
    const { p_notes } = supabaseMock.rpc.mock.calls[0][1] as { p_notes?: string };
    expect(p_notes).toBeUndefined();
  });

  it("rejects a reason longer than 300 characters", async () => {
    stubSuccess();
    const res = await POST(
      postReq({
        doctorId: "11111111-1111-4111-8111-111111111111",
        serviceId: "11111111-1111-4111-8111-111111111111",
        startAt: "2030-01-07T05:00:00Z",
        patientName: "Ali Valiyev",
        phone: "+998901234567",
        consent: true,
        initData: "dev",
        notes: "x".repeat(301),
      }),
    );
    expect(res.status).toBe(400);
    expect(supabaseMock.rpc).not.toHaveBeenCalled();
  });

  it("scopes patient identity AND the booking to the URL clinic (?clinic= tamper cannot split them)", async () => {
    // An attacker swaps ?clinic= to a foreign clinic: the route must resolve
    // the patient for THAT clinic (never a different one) and book under it.
    const foreign = { ...CLINIC, id: "22222222-2222-4222-8222-222222222222", name: "Clinic B" };
    getClinicMock.mockResolvedValue(foreign);
    resolveMock.mockResolvedValue({ patient: { id: "p-f", clinic_id: foreign.id }, identity: { telegramUserId: 999 } });
    supabaseMock.from.mockImplementation((table: string) => {
      if (table === "patients") {
        return {
          update: vi.fn(() => ({ eq: vi.fn(() => ({ eq: vi.fn(async () => ({ data: null, error: null })) })) })),
          select: vi.fn(() => ({ eq: vi.fn(() => ({ eq: vi.fn(() => ({ single: vi.fn(async () => ({ data: { full_name: null, phone: null }, error: null })) })) })) })),
        };
      }
      return {
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            single: vi.fn(async () => ({
              data: { id: "a-1", status: "pending", patients: { full_name: "Ali Valiyev" } },
              error: null,
            })),
            maybeSingle: vi.fn(async () => ({
              data: table === "payments" ? { id: "pay-1", status: "unpaid", provider: "manual" } : null,
              error: null,
            })),
          })),
        })),
      };
    });
    supabaseMock.rpc.mockResolvedValue({
      data: { appointment_id: "a-1", amount: 80000, error_code: null, error_message: null },
      error: null,
    });

    const req = new NextRequest("http://localhost/api/bookings?clinic=22222222-2222-4222-8222-222222222222", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        doctorId: "11111111-1111-4111-8111-111111111111",
        serviceId: "11111111-1111-4111-8111-111111111111",
        startAt: "2030-01-07T05:00:00Z",
        patientName: "Ali Valiyev",
        phone: "+998901234567",
        consent: true,
        initData: "dev",
      }),
    });
    const res = await POST(req);

    expect(res.status).toBe(201);
    // Identity resolution was requested FOR the URL clinic...
    expect(resolveMock).toHaveBeenCalledWith("dev", foreign.id);
    // ...and the booking itself lands in the same clinic.
    const { p_clinic_id, p_patient_id } = supabaseMock.rpc.mock.calls[0][1] as { p_clinic_id: string; p_patient_id: string };
    expect(p_clinic_id).toBe(foreign.id);
    expect(p_patient_id).toBe("p-f");
    // A valid signature for that clinic is enforced server-side (see
    // bot-routing.test.ts): initData from any other bot is rejected.
  });
});
describe("POST /api/bookings — appointment source attribution (audit finding)", () => {
  it("records telegram_chat when the client reports a bot-chat deep link", async () => {
    stubSuccess();
    const res = await POST(
      postReq({
        doctorId: "11111111-1111-4111-8111-111111111111",
        serviceId: "11111111-1111-4111-8111-111111111111",
        startAt: "2030-01-07T05:00:00Z",
        patientName: "Ali Valiyev",
        phone: "+998901234567",
        consent: true,
        initData: "dev",
        source: "telegram_chat",
      }),
    );
    expect(res.status).toBe(201);
    const { p_source } = supabaseMock.rpc.mock.calls[0][1] as { p_source?: string };
    expect(p_source).toBe("telegram_chat");
  });

  it("defaults verified Telegram bookings to telegram_mini_app", async () => {
    stubSuccess();
    const res = await POST(
      postReq({
        doctorId: "11111111-1111-4111-8111-111111111111",
        serviceId: "11111111-1111-4111-8111-111111111111",
        startAt: "2030-01-07T05:00:00Z",
        patientName: "Ali Valiyev",
        phone: "+998901234567",
        consent: true,
        initData: "dev",
      }),
    );
    expect(res.status).toBe(201);
    const { p_source } = supabaseMock.rpc.mock.calls[0][1] as { p_source?: string };
    expect(p_source).toBe("telegram_mini_app");
  });

  it("never lets a non-Telegram booking claim a Telegram source", async () => {
    getClinicMock.mockResolvedValue(CLINIC);
    getOrCreateMock.mockResolvedValue({ id: "p-walkin" });
    supabaseMock.from.mockImplementation((table: string) => {
      if (table === "patients") {
        return {
          update: vi.fn(() => ({ eq: vi.fn(() => ({ eq: vi.fn(async () => ({ data: null, error: null })) })) })),
          select: vi.fn(() => ({ eq: vi.fn(() => ({ eq: vi.fn(() => ({ single: vi.fn(async () => ({ data: { full_name: null, phone: null }, error: null })) })) })) })),
        };
      }
      return {
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            single: vi.fn(async () => ({
              data: { id: "a-1", status: "pending", patients: { full_name: "Ali Valiyev" } },
              error: null,
            })),
            maybeSingle: vi.fn(async () => ({
              data: table === "payments" ? { id: "pay-1", status: "unpaid", provider: "manual" } : null,
              error: null,
            })),
          })),
        })),
      };
    });
    supabaseMock.rpc.mockResolvedValue({
      data: { appointment_id: "a-1", amount: 80000, error_code: null, error_message: null },
      error: null,
    });

    const res = await POST(
      postReq({
        doctorId: "11111111-1111-4111-8111-111111111111",
        serviceId: "11111111-1111-4111-8111-111111111111",
        startAt: "2030-01-07T05:00:00Z",
        patientName: "Ali Valiyev",
        phone: "+998901234567",
        consent: true,
        source: "telegram_chat",
      }),
    );
    expect(res.status).toBe(201);
    const { p_source, p_patient_id } = supabaseMock.rpc.mock.calls[0][1] as { p_source?: string; p_patient_id?: string };
    // No initData was sent, so this is a genuine web booking regardless of
    // the (ignored) client-supplied "telegram_chat" source claim above —
    // not 'walk_in', which is reserved for a reception-entered walk-in.
    expect(p_source).toBe("web");
    expect(p_patient_id).toBe("p-walkin");
  });

  it("rejects an unknown source value with 400", async () => {
    stubSuccess();
    const res = await POST(
      postReq({
        doctorId: "11111111-1111-4111-8111-111111111111",
        serviceId: "11111111-1111-4111-8111-111111111111",
        startAt: "2030-01-07T05:00:00Z",
        patientName: "Ali Valiyev",
        phone: "+998901234567",
        consent: true,
        initData: "dev",
        source: "telegram_bot",
      }),
    );
    expect(res.status).toBe(400);
    expect(supabaseMock.rpc).not.toHaveBeenCalled();
  });
});

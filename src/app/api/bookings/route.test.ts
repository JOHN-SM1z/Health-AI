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
const getOrCreateMock = vi.fn();
vi.mock("@/lib/patients/identity", () => ({
  resolvePatientFromInitData: (...args: unknown[]) => resolveMock(...args),
  devIdentityAllowed: () => true,
  getOrCreatePatientByContact: () => getOrCreateMock(),
}));

vi.mock("@/lib/rate-limit", () => ({
  rateLimit: () => ({ ok: true }),
  keyFromIp: () => "test-ip",
}));

vi.mock("@/lib/analytics", () => ({ trackAnalytics: vi.fn(async () => {}) }));
vi.mock("@/lib/notifications/jobs", () => ({ enqueueBookingNotifications: vi.fn(async () => {}) }));
const loggerMock = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock("@/lib/logger", () => ({ logger: loggerMock }));

import { POST } from "./route";

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
        update: vi.fn(() => ({ eq: vi.fn(async () => ({ data: null, error: null })) })),
      };
    }
    return {
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          single: vi.fn(async () => ({
            data: { id: "a-1", status: "pending", patients: { full_name: "Ali Valiyev" } },
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
          update: vi.fn(() => ({ eq: vi.fn(async () => ({ data: null, error: null })) })),
        };
      }
      return {
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            single: vi.fn(async () => ({
              data: { id: "a-1", status: "pending", patients: { full_name: "Ali Valiyev" } },
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
          update: vi.fn(() => ({ eq: vi.fn(async () => ({ data: null, error: null })) })),
        };
      }
      return {
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            single: vi.fn(async () => ({
              data: { id: "a-1", status: "pending", patients: { full_name: "Ali Valiyev" } },
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
    expect(p_source).toBe("walk_in");
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

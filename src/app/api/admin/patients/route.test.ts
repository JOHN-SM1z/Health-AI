import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

function patchReq(url: string, body: unknown): NextRequest {
  return new NextRequest(`http://localhost${url}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const supabaseMock = { from: vi.fn() };
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => supabaseMock,
}));

vi.mock("@/lib/auth/guards", () => ({
  requireRoles: vi.fn(async () => ({
    profileId: "staff-1",
    clinicId: "clinic-a",
    clinicName: "Clinic A",
    clinicTimezone: "Asia/Tashkent",
    platformAdmin: false,
    roles: ["admin"],
  })),
}));

vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { GET, PATCH } from "./route";

const PATIENT_ROW = {
  id: "p-1",
  full_name: "Ali Valiyev",
  phone: "+998901234567",
  telegram_username: "ali",
  telegram_first_name: "Ali",
  telegram_last_name: null,
  consent_given: true,
  consent_given_at: "2026-08-01T00:00:00Z",
  last_seen_at: "2026-08-18T00:00:00Z",
  created_at: "2026-07-01T00:00:00Z",
  appointments_count: 3,
  conversations_count: 2,
};

type Recorded = {
  conditions: Array<{ type: string; args: unknown[] }>;
  rangeWindow: [number, number] | null;
  updatePayload: unknown;
};

function chainBuilder(result: unknown, count?: number): Recorded & Record<string, unknown> {
  const recorded: Recorded = { conditions: [], rangeWindow: null, updatePayload: undefined };
  const builder = {} as Record<string, unknown>;
  const methods = ["select", "eq", "not", "or", "order", "range", "limit", "update"] as const;
  for (const m of methods) {
    builder[m] = (...args: unknown[]) => {
      if (m === "eq" || m === "not" || m === "or") recorded.conditions.push({ type: m, args });
      if (m === "range") recorded.rangeWindow = [args[0] as number, args[1] as number];
      if (m === "update") recorded.updatePayload = args[0];
      return builder;
    };
  }
  builder.maybeSingle = vi.fn(async () => ({ data: result, error: null }));
  builder.then = (resolve: (v: unknown) => void) =>
    resolve({ data: Array.isArray(result) ? result : result, error: null, count });
  // Merge INTO the recorder so its data properties stay live: methods keep
  // returning `builder`, and conditions/rangeWindow are read from `recorded`.
  return Object.assign(recorded, builder);
}

function getReq(url: string): NextRequest {
  return new NextRequest(`http://localhost${url}`);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("admin patients list", () => {
  it("lists patients scoped to the staff clinic with appointment/conversation counts", async () => {
    const patients = chainBuilder([PATIENT_ROW], 1);
    supabaseMock.from.mockReturnValue(patients);

    const res = await GET(getReq("/api/admin/patients"));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; data: { patients: unknown[]; total: number } };
    expect(json.ok).toBe(true);
    expect(json.data.patients).toHaveLength(1);
    expect(json.data.total).toBe(1);

    expect(patients.conditions).toContainEqual(
      expect.objectContaining({ type: "eq", args: ["clinic_id", "clinic-a"] }),
    );
  });

  it("adds filters and search terms when requested", async () => {
    const patients = chainBuilder([PATIENT_ROW], 1);
    supabaseMock.from.mockReturnValue(patients);

    const res = await GET(getReq("/api/admin/patients?q=ali&telegram=1&noConsent=1"));
    expect(res.status).toBe(200);
    expect(patients.conditions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "eq", args: ["clinic_id", "clinic-a"] }),
        expect.objectContaining({ type: "eq", args: ["consent_given", false] }),
        expect.objectContaining({ type: "not", args: ["telegram_user_id", "is", null] }),
        expect.objectContaining({ type: "or", args: ["full_name.ilike.%ali%,phone.ilike.%ali%,telegram_username.ilike.%ali%,telegram_first_name.ilike.%ali%"] }),
      ]),
    );
  });

  it("paginates with a 25-row window", async () => {
    const patients = chainBuilder([PATIENT_ROW], 60);
    supabaseMock.from.mockReturnValue(patients);

    const res = await GET(getReq("/api/admin/patients?page=3"));
    expect(res.status).toBe(200);
    expect(patients.rangeWindow).toEqual([50, 74]);
  });

  it("never lets the browser choose the clinic", async () => {
    const patients = chainBuilder([PATIENT_ROW], 1);
    supabaseMock.from.mockReturnValue(patients);

    await GET(getReq("/api/admin/patients?clinic=other-clinic&page=1"));
    // Only the staff clinic is ever queried.
    expect(patients.conditions.filter((c) => c.type === "eq" && c.args[0] === "clinic_id")).toEqual([
      expect.objectContaining({ args: ["clinic_id", "clinic-a"] }),
    ]);
  });
});

describe("admin patient detail", () => {
  it("returns the patient with appointments and conversations", async () => {
    const patient = chainBuilder({ id: "p-1", full_name: "Ali Valiyev", phone: "+998901234567" });
    const appointments = chainBuilder([]);
    const conversations = chainBuilder([]);
    supabaseMock.from.mockImplementation((table: string) => {
      if (table === "patients") return patient;
      if (table === "appointments") return appointments;
      return conversations;
    });

    const res = await GET(getReq("/api/admin/patients?id=p-1"));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; data: { patient: { id: string } } };
    expect(json.data.patient.id).toBe("p-1");
    expect(patient.conditions).toContainEqual(
      expect.objectContaining({ type: "eq", args: ["clinic_id", "clinic-a"] }),
    );
    expect(appointments.conditions).toContainEqual(
      expect.objectContaining({ type: "eq", args: ["patient_id", "p-1"] }),
    );
    expect(conversations.conditions).toContainEqual(
      expect.objectContaining({ type: "eq", args: ["patient_id", "p-1"] }),
    );
  });

  it("returns an empty detail when the patient belongs to another clinic", async () => {
    const patient = chainBuilder(null);
    supabaseMock.from.mockReturnValue(patient);

    const res = await GET(getReq("/api/admin/patients?id=other-clinic-patient"));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; data: { patient: null } };
    expect(json.ok).toBe(true);
    expect(json.data.patient).toBeNull();
  });
});

describe("admin patient operational notes (dashboard-completion phase)", () => {
  const PATIENT_ID = "11111111-1111-4111-8111-111111111111";

  it("updates the operational note for a patient in the staff's own clinic", async () => {
    const patients = chainBuilder({ id: PATIENT_ID, operational_notes: "Ertalab qulay" });
    supabaseMock.from.mockReturnValue(patients);

    const res = await PATCH(
      patchReq("/api/admin/patients", { patientId: PATIENT_ID, operationalNotes: "Ertalab qulay" }),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; data: { patient: { operational_notes: string } } };
    expect(json.ok).toBe(true);
    expect(json.data.patient.operational_notes).toBe("Ertalab qulay");
    expect(patients.updatePayload).toEqual({ operational_notes: "Ertalab qulay" });
    expect(patients.conditions).toContainEqual(
      expect.objectContaining({ type: "eq", args: ["clinic_id", "clinic-a"] }),
    );
    expect(patients.conditions).toContainEqual(expect.objectContaining({ type: "eq", args: ["id", PATIENT_ID] }));
  });

  it("clears the note (stores null) when an empty string is sent", async () => {
    const patients = chainBuilder({ id: PATIENT_ID, operational_notes: null });
    supabaseMock.from.mockReturnValue(patients);

    const res = await PATCH(patchReq("/api/admin/patients", { patientId: PATIENT_ID, operationalNotes: "" }));
    expect(res.status).toBe(200);
    expect(patients.updatePayload).toEqual({ operational_notes: null });
  });

  it("404s when the patient belongs to another clinic — clinic_id is scoped server-side, not just checked in the UI", async () => {
    const patients = chainBuilder(null);
    supabaseMock.from.mockReturnValue(patients);

    const res = await PATCH(patchReq("/api/admin/patients", { patientId: PATIENT_ID, operationalNotes: "x" }));
    expect(res.status).toBe(404);
  });

  it("rejects a note longer than 1000 characters without writing anything", async () => {
    const patients = chainBuilder({ id: PATIENT_ID });
    supabaseMock.from.mockReturnValue(patients);

    const res = await PATCH(
      patchReq("/api/admin/patients", { patientId: PATIENT_ID, operationalNotes: "x".repeat(1001) }),
    );
    expect(res.status).toBe(400);
    expect(patients.updatePayload).toBeUndefined();
  });

  it("rejects a malformed patientId", async () => {
    const res = await PATCH(patchReq("/api/admin/patients", { patientId: "not-a-uuid", operationalNotes: "x" }));
    expect(res.status).toBe(400);
  });
});
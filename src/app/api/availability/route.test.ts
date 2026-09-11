import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("server-only", () => ({}));

const mockClinic = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Test Klinika",
  timezone: "Asia/Tashkent",
  currency: "UZS",
};

vi.mock("@/lib/clinics/context", () => ({
  getClinicFromRequest: async () => mockClinic,
}));

const SERVICE_1 = "22222222-2222-4222-8222-222222222222";
const SERVICE_OTHER = "33333333-3333-4333-8333-333333333333";
const DOCTOR_RESTRICTED = "44444444-4444-4444-8444-444444444444";
const DOCTOR_OPEN = "55555555-5555-4555-8555-555555555555";

// doc-restricted offers only SERVICE_OTHER at a 60-minute override (the
// looked-up base service duration is 30); doc-open has no doctor_services
// rows at all and offers everything at the base duration.
const SERVICE_ROW = { duration_minutes: 30, clinic_id: mockClinic.id };
const DOCTOR_SERVICES = [
  { doctor_id: DOCTOR_RESTRICTED, service_id: SERVICE_OTHER, duration_override_minutes: 60 },
];
const WORKING_HOURS_TEMPLATE = Array.from({ length: 7 }, (_, i) => ({
  weekday: i + 1,
  start_time: "09:00",
  end_time: "18:00",
}));
// The route now fetches working hours for every doctor in one batched
// query (`.in("doctor_id", doctorIds)`), so the fixture must be tagged
// per doctor and grouped client-side the same way the route does.
const WORKING_HOURS_ALL = [DOCTOR_RESTRICTED, DOCTOR_OPEN].flatMap((doctorId) =>
  WORKING_HOURS_TEMPLATE.map((row) => ({ ...row, doctor_id: doctorId })),
);

function buildSupabaseMock() {
  return {
    from: vi.fn((table: string) => {
      if (table === "services") {
        return {
          select: () => ({
            eq: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: SERVICE_ROW, error: null }) }) }) }),
          }),
        };
      }
      if (table === "doctors") {
        return {
          select: () => ({
            eq: (col: string, val: string) => {
              if (col === "id") {
                return {
                  eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { id: val }, error: null }) }) }),
                };
              }
              return { eq: async () => ({ data: [{ id: DOCTOR_RESTRICTED }, { id: DOCTOR_OPEN }], error: null }) };
            },
            in: async () => ({
              data: [
                { id: DOCTOR_RESTRICTED, name: "Dr. Restricted" },
                { id: DOCTOR_OPEN, name: "Dr. Open" },
              ],
              error: null,
            }),
          }),
        };
      }
      if (table === "doctor_services") {
        return { select: () => ({ in: async () => ({ data: DOCTOR_SERVICES, error: null }) }) };
      }
      if (table === "doctor_working_hours") {
        return { select: () => ({ in: async () => ({ data: WORKING_HOURS_ALL, error: null }) }) };
      }
      if (table === "doctor_time_blocks") {
        return { select: () => ({ in: () => ({ gte: async () => ({ data: [], error: null }) }) }) };
      }
      if (table === "appointments") {
        return { select: () => ({ in: () => ({ gte: async () => ({ data: [], error: null }) }) }) };
      }
      return {};
    }),
  };
}

let supabaseMock: ReturnType<typeof buildSupabaseMock>;
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => supabaseMock,
}));

import { GET } from "./route";

beforeEach(() => {
  supabaseMock = buildSupabaseMock();
});

describe("availability route — per-doctor service gate and duration override", () => {
  it("excludes a doctor who does not offer the requested service (would fail service_not_offered in book_appointment)", async () => {
    const req = new NextRequest(`http://localhost/api/availability?serviceId=${SERVICE_1}&days=3`);
    const res = await GET(req);
    expect(res.status).toBe(200);
    const json = await res.json();

    const doctorIds = new Set(json.data.slots.map((s: { doctorId: string }) => s.doctorId));
    // doc-restricted only offers SERVICE_OTHER, never SERVICE_1 — must
    // never appear here, even though it has working hours configured.
    expect(doctorIds.has(DOCTOR_RESTRICTED)).toBe(false);
    // doc-open has no doctor_services rows at all — offers everything.
    expect(doctorIds.has(DOCTOR_OPEN)).toBe(true);
  });

  it("uses the doctor's duration_override_minutes, not the base service duration", async () => {
    const req = new NextRequest(`http://localhost/api/availability?serviceId=${SERVICE_OTHER}&doctorId=${DOCTOR_RESTRICTED}&days=3`);
    const res = await GET(req);
    expect(res.status).toBe(200);
    const json = await res.json();

    expect(json.data.slots.length).toBeGreaterThan(0);
    const first = json.data.slots[0];
    const durationMinutes = (new Date(first.end).getTime() - new Date(first.start).getTime()) / 60_000;
    // The mocked "services" lookup always returns the 30-minute base row
    // (it doesn't filter by id) — the 60-minute override for THIS doctor
    // must still win over that base duration.
    expect(durationMinutes).toBe(60);
  });

  it("uses the base service duration for a doctor with no override", async () => {
    const req = new NextRequest(`http://localhost/api/availability?serviceId=${SERVICE_1}&doctorId=${DOCTOR_OPEN}&days=3`);
    const res = await GET(req);
    expect(res.status).toBe(200);
    const json = await res.json();

    expect(json.data.slots.length).toBeGreaterThan(0);
    const first = json.data.slots[0];
    const durationMinutes = (new Date(first.end).getTime() - new Date(first.start).getTime()) / 60_000;
    expect(durationMinutes).toBe(30);
  });

  it("fetches working hours, time blocks, and appointments once in total, not once per doctor (no N+1 on this public, unauthenticated path)", async () => {
    const req = new NextRequest(`http://localhost/api/availability?days=3`); // no doctorId -> fans out to both seeded doctors
    const res = await GET(req);
    expect(res.status).toBe(200);
    const json = await res.json();
    const doctorIds = new Set(json.data.slots.map((s: { doctorId: string }) => s.doctorId));
    expect(doctorIds.has(DOCTOR_OPEN)).toBe(true); // sanity: both doctors really were resolved

    const callsFor = (table: string) => supabaseMock.from.mock.calls.filter(([t]) => t === table).length;
    expect(callsFor("doctor_working_hours")).toBe(1);
    expect(callsFor("doctor_time_blocks")).toBe(1);
    expect(callsFor("appointments")).toBe(1);
  });
});

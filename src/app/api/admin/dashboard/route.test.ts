import { describe, it, expect, vi, beforeEach } from "vitest";
import { localDayWindow } from "./route";

const supabaseMock = { from: vi.fn() };
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => supabaseMock,
}));

const rolesMock = vi.fn();
vi.mock("@/lib/auth/guards", () => ({
  requireRoles: () => rolesMock(),
}));

vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { GET } from "./route";

const TODAY_ROWS = [
  { status: "confirmed", services: { price: 80000 }, payments: { status: "unpaid", amount: 0 } },
  { status: "completed", services: { price: 50000 }, payments: { status: "paid", amount: 50000 } },
  { status: "completed", services: { price: 120000 }, payments: { status: "paid", amount: 120000 } },
  { status: "cancelled", services: { price: 30000 }, payments: { status: "refunded", amount: 30000 } },
  { status: "pending", services: { price: 70000 }, payments: { status: "unpaid", amount: 0 } },
];

type Recorded = { conditions: Array<{ type: string; args: unknown[] }>; selects: Array<{ type: string; args: unknown[] }> };

function chainBuilder(result: unknown[], count?: number): Recorded & Record<string, unknown> {
  const recorded: Recorded = { conditions: [], selects: [] };
  const builder = {} as Record<string, unknown>;
  const methods = ["select", "eq", "gte", "lte", "lt", "order", "limit"] as const;
  for (const m of methods) {
    builder[m] = (...args: unknown[]) => {
      if (m === "select") recorded.selects.push({ type: m, args });
      else recorded.conditions.push({ type: m, args });
      return builder;
    };
  }
  builder.then = (resolve: (v: unknown) => void) => resolve({ data: result, error: null, count });
  return Object.assign(recorded, builder);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("admin dashboard", () => {
  it("aggregates today's appointments, revenue and outstanding for the staff clinic", async () => {
    rolesMock.mockResolvedValue({
      profileId: "staff-1",
      clinicId: "clinic-a",
      clinicName: "Clinic A",
      clinicTimezone: "Asia/Tashkent",
      platformAdmin: false,
      roles: ["receptionist"],
    });
    const appointments = chainBuilder(TODAY_ROWS);
    const patients = chainBuilder([], 4);
    const jobs = chainBuilder([], 7);
    supabaseMock.from.mockImplementation((table: string) => {
      if (table === "appointments") return appointments;
      if (table === "patients") return patients;
      return jobs;
    });

    const res = await GET();
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      ok: boolean;
      data: {
        counts: Record<string, number>;
        revenue: number;
        outstanding: number;
        new_patients_today: number;
        upcoming_reminders: number | null;
      };
    };
    expect(json.ok).toBe(true);
    expect(json.data.counts.total).toBe(5);
    expect(json.data.counts.completed).toBe(2);
    expect(json.data.revenue).toBe(170000);
    expect(json.data.outstanding).toBe(150000);
    expect(json.data.new_patients_today).toBe(4);

    const clinicEqs = appointments.conditions.filter((c) => c.type === "eq" && c.args[0] === "clinic_id");
    expect(clinicEqs.length).toBeGreaterThanOrEqual(1);
    expect(patients.selects[0]?.args[1]).toEqual({ count: "exact", head: true });
    // Receptionists never read reminder jobs.
    expect(upcoming_reminders(json)).toBeNull();
    expect(supabaseMock.from.mock.calls.some((c) => c[0] === "notification_jobs")).toBe(false);
  });

  it("returns reminder count for management roles", async () => {
    rolesMock.mockResolvedValue({
      profileId: "staff-1",
      clinicId: "clinic-a",
      clinicName: "Clinic A",
      clinicTimezone: "Asia/Tashkent",
      platformAdmin: false,
      roles: ["owner"],
    });
    const appointments = chainBuilder([]);
    const patients = chainBuilder([], 0);
    const jobs = chainBuilder([], 3);
    supabaseMock.from.mockImplementation((table: string) => {
      if (table === "appointments") return appointments;
      if (table === "patients") return patients;
      return jobs;
    });

    const res = await GET();
    const json = (await res.json()) as { ok: boolean; data: { upcoming_reminders: number | null } };
    expect(json.ok).toBe(true);
    expect(json.data.upcoming_reminders).toBe(3);
    expect(supabaseMock.from.mock.calls.some((c) => c[0] === "notification_jobs")).toBe(true);
  });
});

function upcoming_reminders(json: { data: { upcoming_reminders: number | null } }) {
  return json.data.upcoming_reminders;
}

describe("localDayWindow", () => {
  it("returns a 24-hour window in the clinic's own timezone", () => {
    // 2026-08-18 20:30 UTC = 2026-08-19 01:30 Asia/Tashkent (UTC+5, no DST).
    const { start, end } = localDayWindow("Asia/Tashkent", new Date("2026-08-18T20:30:00Z"));
    expect(start).toBe("2026-08-18T19:00:00.000Z");
    expect(end).toBe("2026-08-19T19:00:00.000Z");
  });
});
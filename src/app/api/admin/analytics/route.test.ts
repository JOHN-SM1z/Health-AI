import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const supabaseMock = { from: vi.fn() };
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => supabaseMock,
}));

const staffMock = vi.hoisted(() => ({
  context: {
    profileId: "staff-1",
    clinicId: "clinic-a",
    clinicName: "Clinic A",
    clinicTimezone: "Asia/Tashkent",
    platformAdmin: false,
    roles: ["admin"],
  },
}));

vi.mock("@/lib/auth/guards", () => ({
  requireRoles: vi.fn(async () => staffMock.context),
}));

vi.mock("@/lib/auth/staff", () => ({
  canViewPaymentDynamics: (ctx: { roles: string[] }) => ctx.roles.includes("owner") || ctx.roles.includes("admin"),
}));

vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { GET } from "./route";

const APPOINTMENT_ROWS = [
  { source: "telegram_mini_app", status: "confirmed", cancelled_reason: null, start_at: "2026-08-17T04:00:00Z", services: { name: "Terapevt qabuli", price: 80000 }, doctors: { name: "Karimov Alisher" }, payments: { status: "unpaid", amount: 80000 } },
  { source: "telegram_mini_app", status: "cancelled", cancelled_reason: "Bemor tomonidan bekor qilindi", start_at: "2026-08-17T05:00:00Z", services: { name: "Terapevt qabuli", price: 80000 }, doctors: { name: "Karimov Alisher" }, payments: { status: "refunded", amount: 80000 } },
  { source: "telegram_mini_app", status: "cancelled", cancelled_reason: "Bemor tomonidan bekor qilindi", start_at: "2026-08-18T06:00:00Z", services: { name: "Terapevt qabuli", price: 80000 }, doctors: { name: "Karimov Alisher" }, payments: { status: "unpaid", amount: 80000 } },
  { source: "walk_in", status: "completed", cancelled_reason: null, start_at: "2026-08-17T07:00:00Z", services: { name: "Kardiolog qabuli", price: 120000 }, doctors: { name: "Yusupova Dilnoza" }, payments: { status: "paid", amount: 120000 } },
  { source: "walk_in", status: "completed", cancelled_reason: null, start_at: "2026-08-18T08:00:00Z", services: { name: "Terapevt qabuli", price: 80000 }, doctors: { name: "Karimov Alisher" }, payments: { status: "paid", amount: 80000 } },
  { source: "walk_in", status: "cancelled", cancelled_reason: "Vaqt mos kelmadi", start_at: "2026-08-18T09:00:00Z", services: { name: "Kardiolog qabuli", price: 120000 }, doctors: { name: "Yusupova Dilnoza" }, payments: { status: "unpaid", amount: 120000 } },
];

type Recorded = { conditions: Array<{ type: string; args: unknown[] }>; selectArgs: unknown[] };

function chainBuilder(result: unknown[]): Recorded & Record<string, unknown> {
  const recorded: Recorded = { conditions: [], selectArgs: [] };
  const builder = {} as Record<string, unknown>;
  const methods = ["select", "eq", "gte", "lte", "lt", "order", "limit"] as const;
  for (const m of methods) {
    builder[m] = (...args: unknown[]) => {
      if (m === "eq" || m === "gte" || m === "lte" || m === "lt") recorded.conditions.push({ type: m, args });
      if (m === "select") recorded.selectArgs.push(...args);
      return builder;
    };
  }
  builder.then = (resolve: (v: unknown) => void) => resolve({ data: result, error: null });
  return Object.assign(recorded, builder);
}

function getReq(url: string): NextRequest {
  return new NextRequest(`http://localhost${url}`);
}

beforeEach(() => {
  vi.clearAllMocks();
  staffMock.context.roles = ["admin"];
});

describe("admin analytics", () => {
  it("aggregates sources, cancellation reasons, trend and top lists scoped to the staff clinic", async () => {
    const appointments = chainBuilder(APPOINTMENT_ROWS);
    supabaseMock.from.mockReturnValue(appointments);

    const res = await GET(getReq("/api/admin/analytics?range=30"));
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      ok: boolean;
      data: {
        total: number;
        cancelled: number;
        cancellation_rate: number;
        no_show_rate: number;
        by_source: [string, number][];
        by_payment_status: [string, number][];
        total_revenue: number | null;
        cancel_reasons: { reason: string; count: number }[];
        revenue_trend: { date: string; revenue: number }[];
        top_services: { name: string; count: number; completed_count: number; revenue: number }[];
        top_doctors: { name: string; count: number; completed_count: number; completion_rate: number; revenue: number }[];
      };
    };
    expect(json.ok).toBe(true);
    expect(json.data.total).toBe(6);
    expect(json.data.cancelled).toBe(3);
    expect(json.data.cancellation_rate).toBe(50);
    expect(json.data.no_show_rate).toBe(0);
    expect(json.data.by_source).toEqual([
      ["telegram_mini_app", 3],
      ["walk_in", 3],
    ]);
    expect(json.data.cancel_reasons).toEqual([
      { reason: "Bemor tomonidan bekor qilindi", count: 2 },
      { reason: "Vaqt mos kelmadi", count: 1 },
    ]);

    // Completed+PAID only (never appointment status alone) — see
    // aggregate.test.ts for the dedicated unpaid/refunded exclusion cases.
    // Grouped by clinic-local day (Asia/Tashkent = UTC+5):
    // 2026-08-17T07:00Z is 2026-08-17 12:00 local, 2026-08-18T08:00Z is 13:00 local.
    expect(json.data.revenue_trend).toEqual([
      { date: "2026-08-17", revenue: 120000 },
      { date: "2026-08-18", revenue: 80000 },
    ]);
    expect(json.data.total_revenue).toBe(200000);
    // 3 unpaid (rows 0,2,5), 2 paid (rows 3,4), 1 refunded (row 1).
    expect(json.data.by_payment_status).toEqual([
      ["unpaid", 3],
      ["paid", 2],
      ["refunded", 1],
    ]);
    expect(json.data.top_services).toEqual([
      { name: "Terapevt qabuli", count: 4, completed_count: 1, revenue: 80000 },
      { name: "Kardiolog qabuli", count: 2, completed_count: 1, revenue: 120000 },
    ]);
    expect(json.data.top_doctors).toEqual([
      { name: "Karimov Alisher", count: 4, completed_count: 1, completion_rate: 25, revenue: 80000 },
      { name: "Yusupova Dilnoza", count: 2, completed_count: 1, completion_rate: 50, revenue: 120000 },
    ]);

    expect(appointments.conditions).toContainEqual(
      expect.objectContaining({ type: "eq", args: ["clinic_id", "clinic-a"] }),
    );
    // The revenue figures above are only trustworthy if payments were
    // actually fetched and joined into the query in the first place.
    expect(appointments.selectArgs.join(" ")).toContain("payments(status, amount)");
  });

  it("caps the range at 365 days and defaults to 30", async () => {
    const appointments = chainBuilder([]);
    supabaseMock.from.mockReturnValue(appointments);

    const res = await GET(getReq("/api/admin/analytics"));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; data: { range: number } };
    expect(json.data.range).toBe(30);

    const gteArgs = appointments.conditions.filter((c) => c.type === "gte").map((c) => c.args[1]);
    expect(gteArgs.length).toBe(1);
  });

  it("does not return revenue dynamics to a manager", async () => {
    staffMock.context.roles = ["manager"];
    supabaseMock.from.mockReturnValue(chainBuilder(APPOINTMENT_ROWS));

    const res = await GET(getReq("/api/admin/analytics?range=30"));
    const json = (await res.json()) as {
      data: {
        can_view_payment_dynamics: boolean;
        total_revenue: number | null;
        by_payment_status: unknown[];
        revenue_trend: unknown[];
        revenue_by_week: unknown[];
        revenue_by_month: unknown[];
        top_services: { revenue: number | null }[];
        top_doctors: { revenue: number | null }[];
        // Non-financial operational data must still reach a manager.
        cancellation_rate: number;
      };
    };

    expect(json.data.can_view_payment_dynamics).toBe(false);
    expect(json.data.total_revenue).toBeNull();
    expect(json.data.by_payment_status).toEqual([]);
    expect(json.data.revenue_trend).toEqual([]);
    expect(json.data.revenue_by_week).toEqual([]);
    expect(json.data.revenue_by_month).toEqual([]);
    expect(json.data.top_services.every((service) => service.revenue === null)).toBe(true);
    expect(json.data.top_doctors.every((doctor) => doctor.revenue === null)).toBe(true);
    // The cancellation rate is an operational metric, not a financial one —
    // a manager without owner/admin still needs it.
    expect(json.data.cancellation_rate).toBe(50);
  });

  it("supports a custom clinic-timezone-aware date range instead of a rolling window", async () => {
    const appointments = chainBuilder(APPOINTMENT_ROWS);
    supabaseMock.from.mockReturnValue(appointments);

    const res = await GET(getReq("/api/admin/analytics?from=2026-08-01&to=2026-08-31"));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: { from: string | null; to: string | null } };
    expect(json.data.from).toBe("2026-08-01");
    expect(json.data.to).toBe("2026-08-31");

    // Asia/Tashkent is UTC+5: local midnight Aug 1 is 2026-07-31T19:00:00Z,
    // and the exclusive upper bound is local midnight of the day AFTER Aug
    // 31, i.e. 2026-08-31T19:00:00Z.
    expect(appointments.conditions).toContainEqual(
      expect.objectContaining({ type: "gte", args: ["start_at", "2026-07-31T19:00:00.000Z"] }),
    );
    expect(appointments.conditions).toContainEqual(
      expect.objectContaining({ type: "lt", args: ["start_at", "2026-08-31T19:00:00.000Z"] }),
    );
  });

  it("rejects a custom range where the start date is after the end date", async () => {
    supabaseMock.from.mockReturnValue(chainBuilder(APPOINTMENT_ROWS));
    const res = await GET(getReq("/api/admin/analytics?from=2026-08-31&to=2026-08-01"));
    expect(res.status).toBe(400);
  });

  it("rejects a malformed custom date", async () => {
    supabaseMock.from.mockReturnValue(chainBuilder(APPOINTMENT_ROWS));
    const res = await GET(getReq("/api/admin/analytics?from=08-01-2026&to=2026-08-31"));
    expect(res.status).toBe(400);
  });
});

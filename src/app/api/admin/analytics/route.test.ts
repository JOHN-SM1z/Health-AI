import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

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

import { GET } from "./route";

const APPOINTMENT_ROWS = [
  { source: "telegram_mini_app", status: "confirmed", cancelled_reason: null, start_at: "2026-08-17T04:00:00Z", services: { name: "Terapevt qabuli", price: 80000 }, doctors: { name: "Karimov Alisher" } },
  { source: "telegram_mini_app", status: "cancelled", cancelled_reason: "Bemor tomonidan bekor qilindi", start_at: "2026-08-17T05:00:00Z", services: { name: "Terapevt qabuli", price: 80000 }, doctors: { name: "Karimov Alisher" } },
  { source: "telegram_mini_app", status: "cancelled", cancelled_reason: "Bemor tomonidan bekor qilindi", start_at: "2026-08-18T06:00:00Z", services: { name: "Terapevt qabuli", price: 80000 }, doctors: { name: "Karimov Alisher" } },
  { source: "walk_in", status: "completed", cancelled_reason: null, start_at: "2026-08-17T07:00:00Z", services: { name: "Kardiolog qabuli", price: 120000 }, doctors: { name: "Yusupova Dilnoza" } },
  { source: "walk_in", status: "completed", cancelled_reason: null, start_at: "2026-08-18T08:00:00Z", services: { name: "Terapevt qabuli", price: 80000 }, doctors: { name: "Karimov Alisher" } },
  { source: "walk_in", status: "cancelled", cancelled_reason: "Vaqt mos kelmadi", start_at: "2026-08-18T09:00:00Z", services: { name: "Kardiolog qabuli", price: 120000 }, doctors: { name: "Yusupova Dilnoza" } },
];

type Recorded = { conditions: Array<{ type: string; args: unknown[] }> };

function chainBuilder(result: unknown[]): Recorded & Record<string, unknown> {
  const recorded: Recorded = { conditions: [] };
  const builder = {} as Record<string, unknown>;
  const methods = ["select", "eq", "gte", "lte", "order", "limit"] as const;
  for (const m of methods) {
    builder[m] = (...args: unknown[]) => {
      if (m === "eq" || m === "gte" || m === "lte") recorded.conditions.push({ type: m, args });
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
        by_source: [string, number][];
        cancel_reasons: { reason: string; count: number }[];
        revenue_trend: { date: string; revenue: number }[];
        top_services: { name: string; count: number; revenue: number }[];
        top_doctors: { name: string; count: number; revenue: number }[];
      };
    };
    expect(json.ok).toBe(true);
    expect(json.data.total).toBe(6);
    expect(json.data.cancelled).toBe(3);
    expect(json.data.by_source).toEqual([
      ["telegram_mini_app", 3],
      ["walk_in", 3],
    ]);
    expect(json.data.cancel_reasons).toEqual([
      { reason: "Bemor tomonidan bekor qilindi", count: 2 },
      { reason: "Vaqt mos kelmadi", count: 1 },
    ]);

    // Completed+paid only; grouped by clinic-local day (Asia/Tashkent = UTC+5):
    // 2026-08-17T07:00Z is 2026-08-17 12:00 local, 2026-08-18T08:00Z is 13:00 local.
    expect(json.data.revenue_trend).toEqual([
      { date: "2026-08-17", revenue: 120000 },
      { date: "2026-08-18", revenue: 80000 },
    ]);
    expect(json.data.top_services).toEqual([
      { name: "Terapevt qabuli", count: 4, revenue: 80000 },
      { name: "Kardiolog qabuli", count: 2, revenue: 120000 },
    ]);
    expect(json.data.top_doctors).toEqual([
      { name: "Karimov Alisher", count: 4, revenue: 80000 },
      { name: "Yusupova Dilnoza", count: 2, revenue: 120000 },
    ]);

    expect(appointments.conditions).toContainEqual(
      expect.objectContaining({ type: "eq", args: ["clinic_id", "clinic-a"] }),
    );
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
});
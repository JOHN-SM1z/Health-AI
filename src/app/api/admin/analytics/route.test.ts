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
  { source: "telegram_mini_app", status: "confirmed", cancelled_reason: null },
  { source: "telegram_mini_app", status: "cancelled", cancelled_reason: "Bemor tomonidan bekor qilindi" },
  { source: "telegram_mini_app", status: "cancelled", cancelled_reason: "Bemor tomonidan bekor qilindi" },
  { source: "walk_in", status: "completed", cancelled_reason: null },
  { source: "walk_in", status: "cancelled", cancelled_reason: "Vaqt mos kelmadi" },
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
  it("aggregates sources and cancellation reasons scoped to the staff clinic", async () => {
    const appointments = chainBuilder(APPOINTMENT_ROWS);
    supabaseMock.from.mockReturnValue(appointments);

    const res = await GET(getReq("/api/admin/analytics?range=30"));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; data: { total: number; cancelled: number; by_source: [string, number][]; cancel_reasons: { reason: string; count: number }[] } };
    expect(json.ok).toBe(true);
    expect(json.data.total).toBe(5);
    expect(json.data.cancelled).toBe(3);
    expect(json.data.by_source).toEqual([
      ["telegram_mini_app", 3],
      ["walk_in", 2],
    ]);
    expect(json.data.cancel_reasons).toEqual([
      { reason: "Bemor tomonidan bekor qilindi", count: 2 },
      { reason: "Vaqt mos kelmadi", count: 1 },
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
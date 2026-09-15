import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("server-only", () => ({}));

const STAFF_CLINIC = "11111111-1111-4111-8111-111111111111";
const OTHER_CLINIC = "99999999-9999-4999-8999-999999999999";

const staffMock = vi.hoisted(() => ({
  impl: async () => ({
    profileId: "staff-1",
    clinicId: "11111111-1111-4111-8111-111111111111",
    clinicName: "Staff Clinic",
    clinicTimezone: "Asia/Tashkent",
    roles: ["receptionist"],
    platformAdmin: false,
  }),
}));
let requireRolesCalls: string[][] = [];
vi.mock("@/lib/auth/guards", () => ({
  requireRoles: (...roles: string[]) => {
    requireRolesCalls.push(roles);
    return staffMock.impl();
  },
}));

// Records every clinic_id the route actually scoped a query by, so the test
// can prove it always comes from the staff session — never a query param.
const seenClinicIds: string[] = [];

function buildSupabaseMock() {
  return {
    from: vi.fn(() => {
      const node: Record<string, unknown> = {};
      node.select = () => node;
      node.eq = (col: string, val: unknown) => {
        if (col === "clinic_id") seenClinicIds.push(val as string);
        return node;
      };
      node.in = () => node;
      node.gte = () => node;
      node.maybeSingle = async () => ({ data: null, error: null });
      node.then = (resolve: (v: unknown) => void) => resolve({ data: [], error: null });
      return node;
    }),
  };
}
let supabaseMock: ReturnType<typeof buildSupabaseMock>;
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => supabaseMock }));

import { GET } from "./route";

beforeEach(() => {
  supabaseMock = buildSupabaseMock();
  requireRolesCalls = [];
  seenClinicIds.length = 0;
  staffMock.impl = async () => ({
    profileId: "staff-1",
    clinicId: STAFF_CLINIC,
    clinicName: "Staff Clinic",
    clinicTimezone: "Asia/Tashkent",
    roles: ["receptionist"],
    platformAdmin: false,
  });
});

function getReq(url: string): NextRequest {
  return new NextRequest(`http://localhost${url}`);
}

describe("admin availability route", () => {
  it("requires an admin-workspace staff role", async () => {
    await GET(getReq("/api/admin/availability"));
    expect(requireRolesCalls).toEqual([["owner", "admin", "manager", "receptionist"]]);
  });

  it("scopes the doctor lookup to the staff session's own clinic — this route reads no clinic param at all", async () => {
    // Even a URL carrying a different clinic id has nowhere to plug in: the
    // route only ever reads ctx.clinicId, never request.nextUrl for it.
    const res = await GET(getReq(`/api/admin/availability?clinic=${OTHER_CLINIC}`));
    expect(res.status).toBe(200);
    expect(seenClinicIds.length).toBeGreaterThan(0);
    expect(seenClinicIds.every((id) => id === STAFF_CLINIC)).toBe(true);
    expect(seenClinicIds).not.toContain(OTHER_CLINIC);
  });

  it("propagates the staff clinic's own timezone into the response", async () => {
    staffMock.impl = async () => ({
      profileId: "staff-1",
      clinicId: STAFF_CLINIC,
      clinicName: "Staff Clinic",
      clinicTimezone: "Europe/London",
      roles: ["manager"],
      platformAdmin: false,
    });
    const res = await GET(getReq("/api/admin/availability"));
    const json = (await res.json()) as { data: { timezone: string } };
    expect(json.data.timezone).toBe("Europe/London");
  });

  it("rejects a role outside the admin workspace (the guard itself is trusted, exercised here for wiring, not re-proving guards.ts)", async () => {
    const { ApiError } = await import("@/lib/api/errors");
    staffMock.impl = async () => {
      throw new ApiError(403, "Bu amal uchun ruxsat yo‘q", "forbidden");
    };
    const res = await GET(getReq("/api/admin/availability"));
    expect(res.status).toBe(403);
  });
});

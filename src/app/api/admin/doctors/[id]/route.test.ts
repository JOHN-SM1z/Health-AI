import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

/**
 * Time-block PUT/DELETE coverage (dashboard-completion phase): these
 * handlers existed with zero test coverage and no admin-UI consumer at
 * all — the admin Doctors page has now been wired up to them (view/add/
 * remove a doctor's blocked time directly from the dashboard, alongside
 * the pre-existing doctor self-service path at /doctor/schedule). Working
 * hours (POST) is unchanged by this phase and is left to its own coverage.
 */

const staffMock = vi.hoisted(() => ({
  impl: async () => ({
    profileId: "staff-1",
    clinicId: "clinic-a",
    clinicName: "Clinic A",
    clinicTimezone: "Asia/Tashkent",
    platformAdmin: false,
    roles: ["admin"] as const,
  }),
}));
vi.mock("@/lib/auth/guards", () => ({
  requireStaff: () => staffMock.impl(),
}));

const supabaseMock = { from: vi.fn() };
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => supabaseMock,
}));

import { PUT, DELETE } from "./route";

const DOCTOR_ID = "11111111-1111-4111-8111-111111111111";

function putReq(body: unknown): NextRequest {
  return new NextRequest(`http://localhost/api/admin/doctors/${DOCTOR_ID}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function delReq(query = ""): NextRequest {
  return new NextRequest(`http://localhost/api/admin/doctors/${DOCTOR_ID}${query}`, { method: "DELETE" });
}

function ctx() {
  return { params: Promise.resolve({ id: DOCTOR_ID }) };
}

type DoctorLookup = { data: { id: string } | null };
type Chain = {
  select: () => Chain;
  eq: (...args: unknown[]) => Chain;
  neq: (...args: unknown[]) => Chain;
  insert: (payload: unknown) => Chain;
  delete: () => Chain;
  maybeSingle: () => Promise<DoctorLookup>;
  single: () => Promise<{ data: unknown; error: unknown }>;
  then: (resolve: (v: unknown) => void) => void;
  insertedPayload?: unknown;
  deleteConditions: Array<[string, unknown]>;
};

function doctorsTable(found: boolean): Chain {
  const chain = {} as Chain;
  chain.select = () => chain;
  chain.eq = () => chain;
  chain.maybeSingle = async () => ({ data: found ? { id: DOCTOR_ID } : null });
  return chain;
}

function timeBlocksTable(): Chain {
  const chain = {} as Chain;
  chain.deleteConditions = [];
  chain.insert = (payload: unknown) => {
    chain.insertedPayload = payload;
    return chain;
  };
  chain.select = () => chain;
  chain.single = async () => ({ data: { id: "block-1", ...(chain.insertedPayload as object) }, error: null });
  chain.delete = () => chain;
  chain.eq = (...args: unknown[]) => {
    chain.deleteConditions.push(args as [string, unknown]);
    return chain;
  };
  chain.then = (resolve: (v: unknown) => void) => resolve({ error: null });
  return chain;
}

beforeEach(() => {
  vi.clearAllMocks();
  staffMock.impl = async () => ({
    profileId: "staff-1",
    clinicId: "clinic-a",
    clinicName: "Clinic A",
    clinicTimezone: "Asia/Tashkent",
    platformAdmin: false,
    roles: ["admin"] as const,
  });
});

describe("PUT /api/admin/doctors/[id] (create time block)", () => {
  it("creates a block for a doctor in the staff's own clinic", async () => {
    const blocks = timeBlocksTable();
    supabaseMock.from.mockImplementation((table: string) => (table === "doctors" ? doctorsTable(true) : blocks));

    const res = await PUT(
      putReq({ startsAt: "2030-01-01T09:00:00Z", endsAt: "2030-01-01T10:00:00Z", reason: "absence", note: "Ta‘til" }),
      ctx(),
    );
    expect(res.status).toBe(201);
    expect(blocks.insertedPayload).toMatchObject({
      clinic_id: "clinic-a",
      doctor_id: DOCTOR_ID,
      starts_at: "2030-01-01T09:00:00Z",
      ends_at: "2030-01-01T10:00:00Z",
      reason: "absence",
      note: "Ta‘til",
      created_by: "staff-1",
    });
  });

  it("rejects an end time at or before the start time", async () => {
    const blocks = timeBlocksTable();
    supabaseMock.from.mockImplementation((table: string) => (table === "doctors" ? doctorsTable(true) : blocks));

    const res = await PUT(
      putReq({ startsAt: "2030-01-01T10:00:00Z", endsAt: "2030-01-01T09:00:00Z", reason: "break" }),
      ctx(),
    );
    expect(res.status).toBe(400);
    expect(blocks.insertedPayload).toBeUndefined();
  });

  it("404s when the doctor does not belong to the staff's clinic (tenant isolation)", async () => {
    const blocks = timeBlocksTable();
    supabaseMock.from.mockImplementation((table: string) => (table === "doctors" ? doctorsTable(false) : blocks));

    const res = await PUT(
      putReq({ startsAt: "2030-01-01T09:00:00Z", endsAt: "2030-01-01T10:00:00Z", reason: "break" }),
      ctx(),
    );
    expect(res.status).toBe(404);
    expect(blocks.insertedPayload).toBeUndefined();
  });

  it("propagates a requireStaff rejection (e.g. a below-admin-weight caller) as an error response", async () => {
    // requireStaff("admin") itself throws ApiError(403, ...) for a
    // sub-admin role — guards.test.ts covers that weight check directly;
    // this just confirms the route surfaces the rejection instead of
    // reaching the doctors/time_blocks tables at all.
    const { ApiError } = await import("@/lib/api/errors");
    staffMock.impl = async () => {
      throw new ApiError(403, "Bu amal uchun ruxsat yo‘q", "forbidden");
    };
    const res = await PUT(
      putReq({ startsAt: "2030-01-01T09:00:00Z", endsAt: "2030-01-01T10:00:00Z", reason: "break" }),
      ctx(),
    );
    expect(res.status).toBe(403);
    expect(supabaseMock.from).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/admin/doctors/[id] (remove time block)", () => {
  it("deletes a block scoped to the staff's own clinic", async () => {
    const blocks = timeBlocksTable();
    supabaseMock.from.mockReturnValue(blocks);

    const res = await DELETE(delReq("?blockId=block-1"), ctx());
    expect(res.status).toBe(200);
    expect(blocks.deleteConditions).toContainEqual(["id", "block-1"]);
    expect(blocks.deleteConditions).toContainEqual(["clinic_id", "clinic-a"]);
  });
});

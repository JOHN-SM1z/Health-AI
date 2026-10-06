import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { NextRequest } from "next/server";
import { localDbAvailable } from "@/test/local-db";

/**
 * Staff management API (role-based dashboard spec): only the clinic owner
 * may create staff, change roles, or remove members; every admin+ session
 * may list. Self-protection rules: an owner can never demote/remove
 * themselves and the last owner can never be removed — otherwise a single
 * misclick could lock the clinic out of management.
 *
 * Runs the real route against the local database with a mocked staff
 * session. Requires `npm run db:reset-local`; skips when the stack is down.
 */

const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const URL = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";

const staffMock = vi.hoisted(() => ({ impl: async () => null as unknown }));

vi.mock("@/lib/auth/guards", () => ({
  requireStaff: () => staffMock.impl(),
}));

vi.mock("@/lib/analytics", () => ({
  trackAnalytics: async () => {},
}));

import { ApiError } from "@/lib/api/errors";
import { GET, POST, PATCH, DELETE } from "./route";

const describeDb = describe.skipIf(!localDbAvailable());

function jsonRequest(method: string, url: string, body?: unknown): NextRequest {
  return new NextRequest(url, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describeDb("staff management API (real DB, mocked session)", () => {
  let admin: SupabaseClient;
  let clinicId: string;
  let ownerId: string;
  let managerId: string;
  let receptionistId: string;
  const suffix = Date.now().toString(36);

  const ctxFor = (profileId: string) => ({
    profileId,
    fullName: "Test Owner",
    clinicId,
    clinicName: "Staff Clinic",
    clinicTimezone: "Asia/Tashkent",
    roles: ["owner"] as ("owner")[],
    platformAdmin: false,
  });

  beforeAll(async () => {
    admin = createClient(URL, SERVICE_KEY, { auth: { persistSession: false } });

    const { data: clinic } = await admin
      .from("clinics")
      .insert({ name: `Staff Clinic ${suffix}`, slug: `staff-${suffix}`, timezone: "Asia/Tashkent", currency: "UZS" })
      .select("id")
      .single();
    clinicId = clinic!.id;

    // Three real auth users so profile/staff_role rows have valid owners.
    const mkUser = async (email: string) => {
      const { data: created, error } = await admin.auth.admin.createUser({
        email,
        password: `StaffTest_${suffix}_Pass!`,
        email_confirm: true,
      });
      expect(error).toBeNull();
      if (!created?.user) throw new Error("user creation failed");
      return created.user.id;
    };
    ownerId = await mkUser(`owner-${suffix}@staff.test`);
    managerId = await mkUser(`manager-${suffix}@staff.test`);
    receptionistId = await mkUser(`reception-${suffix}@staff.test`);

    for (const [uid, role] of [
      [ownerId, "owner"],
      [managerId, "manager"],
      [receptionistId, "receptionist"],
    ] as const) {
      await admin.from("profiles").insert({ id: uid, full_name: `${role} user` });
      await admin.from("staff_roles").insert({ profile_id: uid, clinic_id: clinicId, role });
    }
  });

  afterAll(async () => {
    if (!clinicId) return;
    await admin.from("staff_roles").delete().eq("clinic_id", clinicId);
    await admin.from("profiles").delete().in("id", [ownerId, managerId, receptionistId]);
    for (const uid of [ownerId, managerId, receptionistId]) {
      await admin.auth.admin.deleteUser(uid);
    }
    await admin.from("clinics").delete().eq("id", clinicId);
  });

  it("lists all clinic roles for an owner session", async () => {
    staffMock.impl = async () => ctxFor(ownerId);
    const res = await GET(jsonRequest("GET", "http://localhost/api/admin/staff"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data?: { staff?: Array<{ profileId: string }> } };
    const ids = (body.data?.staff ?? []).map((s) => s.profileId).sort();
    expect(ids).toEqual([ownerId, managerId, receptionistId].sort());
  });

  it("propagates the guard's denial for a receptionist session", async () => {
    // Guards are mocked; simulate the real requireStaff("admin") rejection
    // for an insufficient role (role-gate behavior itself is covered by
    // role-authorization.test.ts against the live DB).
    staffMock.impl = async () => {
      throw new ApiError(403, "Ruxsat yo‘q", "insufficient_role");
    };
    const res = await GET(jsonRequest("GET", "http://localhost/api/admin/staff"));
    expect(res.status).toBe(403);
  });

  it("creates a new staff member with a one-time password", async () => {
    staffMock.impl = async () => ctxFor(ownerId);
    const email = `newdoc-${suffix}@staff.test`;
    const res = await POST(
      jsonRequest("POST", "http://localhost/api/admin/staff", {
        email,
        fullName: "Yangi Shifokor",
        role: "doctor",
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data?: { oneTimePassword?: string | null; profileId?: string } };
    expect(body.data?.oneTimePassword).toBeTruthy();
    expect(body.data?.profileId).toBeTruthy();

    const { data: roles } = await admin.from("staff_roles").select("role").eq("clinic_id", clinicId);
    expect((roles ?? []).some((r) => r.role === "doctor")).toBe(true);

    // Cleanup the created auth user + rows.
    const pid = body.data!.profileId!;
    await admin.from("staff_roles").delete().eq("profile_id", pid).eq("clinic_id", clinicId);
    await admin.from("profiles").delete().eq("id", pid);
    const { data: list } = await admin.auth.admin.listUsers({ perPage: 500 });
    const createdUser = (list?.users ?? []).find((u) => u.email === email);
    if (createdUser) await admin.auth.admin.deleteUser(createdUser.id);
  });

  it("propagates the guard's denial for a non-owner creation attempt", async () => {
    staffMock.impl = async () => {
      throw new ApiError(403, "Faqat egasi xodim qo‘shadi", "insufficient_role");
    };
    const res = await POST(
      jsonRequest("POST", "http://localhost/api/admin/staff", {
        email: `nope-${suffix}@staff.test`,
        fullName: "Yo'q Xodim",
        role: "receptionist",
      }),
    );
    expect(res.status).toBe(403);
  });

  it("changes a member's role", async () => {
    staffMock.impl = async () => ctxFor(ownerId);
    const res = await PATCH(
      jsonRequest("PATCH", "http://localhost/api/admin/staff", { profileId: receptionistId, role: "manager" }),
    );
    expect(res.status).toBe(200);
    const { data: role } = await admin
      .from("staff_roles")
      .select("role")
      .eq("profile_id", receptionistId)
      .eq("clinic_id", clinicId)
      .single();
    expect(role?.role).toBe("manager");
    // Restore.
    await admin.from("staff_roles").update({ role: "receptionist" }).eq("profile_id", receptionistId).eq("clinic_id", clinicId);
  });

  it("refuses an owner changing their own role", async () => {
    staffMock.impl = async () => ctxFor(ownerId);
    const res = await PATCH(
      jsonRequest("PATCH", "http://localhost/api/admin/staff", { profileId: ownerId, role: "receptionist" }),
    );
    expect(res.status).toBe(400);
  });

  it("refuses removing the last owner", async () => {
    staffMock.impl = async () => ctxFor(ownerId);
    const res = await DELETE(
      jsonRequest("DELETE", `http://localhost/api/admin/staff?profileId=${ownerId}`),
    );
    expect([400, 409]).toContain(res.status);
  });

  it("removes a non-owner member", async () => {
    staffMock.impl = async () => ctxFor(ownerId);
    const res = await DELETE(
      jsonRequest("DELETE", `http://localhost/api/admin/staff?profileId=${receptionistId}`),
    );
    expect(res.status).toBe(200);
    const { data: role } = await admin
      .from("staff_roles")
      .select("role")
      .eq("profile_id", receptionistId)
      .eq("clinic_id", clinicId)
      .maybeSingle();
    expect(role).toBeNull();
  });
});

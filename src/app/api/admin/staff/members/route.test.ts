import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { localDbAvailable } from "@/test/local-db";
import { ApiError } from "@/lib/api/errors";

/**
 * The owner's staff management against the real database and auth server:
 * accounts created with a one-time password that signs in, roles changed
 * and removed only within the owner's clinic, owners protected, every change
 * audited with the owner as actor.
 */

const URL = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const ANON_KEY = process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";

const session = vi.hoisted(() => ({ ctx: null as unknown }));
vi.mock("@/lib/auth/guards", () => ({
  requireRoles: async (...roles: string[]) => {
    const ctx = session.ctx as { roles: string[] } | null;
    if (!ctx || !ctx.roles.some((r) => roles.includes(r))) throw new ApiError(403, "Ruxsat yo‘q", "forbidden");
    return ctx;
  },
}));

import { GET, POST, PATCH, DELETE } from "./route";

const describeDb = describe.skipIf(!localDbAvailable());

type Body = { ok: boolean; data?: Record<string, unknown>; code?: string };

describeDb("owner staff management (real database and auth)", () => {
  let admin: SupabaseClient;
  const suffix = Date.now().toString(36);
  const clinicA = randomUUID();
  const clinicB = randomUUID();
  const created: string[] = [];
  let ownerA = "";
  let ownerB = "";
  let staffB = "";

  const req = (method: string, body?: unknown) =>
    new NextRequest(
      method === "DELETE" ? `http://localhost/api/admin/staff/members?profileId=${(body as { profileId: string }).profileId}` : "http://localhost/api/admin/staff/members",
      {
        method,
        headers: { "content-type": "application/json" },
        body: body === undefined || method === "DELETE" ? undefined : JSON.stringify(body),
      },
    );
  const call = async (handler: (r: NextRequest) => Promise<Response>, method: string, body?: unknown) => {
    const res = await handler(req(method, body));
    return { status: res.status, body: (await res.json()) as Body };
  };
  const asOwner = (clinicId = clinicA, profileId = ownerA) => {
    session.ctx = { profileId, clinicId, clinicName: "Staff", clinicTimezone: "Asia/Tashkent", roles: ["owner"], platformAdmin: false };
  };
  async function account(email: string): Promise<string> {
    const { data, error } = await admin.auth.admin.createUser({ email, password: `Pw-${randomUUID()}`, email_confirm: true });
    if (error || !data.user) throw new Error(`createUser: ${error?.message}`);
    created.push(data.user.id);
    await admin.from("profiles").insert({ id: data.user.id, full_name: email });
    return data.user.id;
  }
  const roleOf = async (profileId: string, clinicId = clinicA) =>
    (await admin.from("staff_roles").select("role").eq("clinic_id", clinicId).eq("profile_id", profileId).maybeSingle()).data?.role ?? null;

  beforeAll(async () => {
    admin = createClient(URL, SERVICE_KEY, { auth: { persistSession: false } });
    await admin.from("clinics").insert([
      { id: clinicA, name: `Staff A ${suffix}`, slug: `staff-a-${suffix}` },
      { id: clinicB, name: `Staff B ${suffix}`, slug: `staff-b-${suffix}` },
    ]);
    ownerA = await account(`owner-a-${suffix}@test.local`);
    ownerB = await account(`owner-b-${suffix}@test.local`);
    staffB = await account(`reception-b-${suffix}@test.local`);
    await admin.from("staff_roles").insert([
      { clinic_id: clinicA, profile_id: ownerA, role: "owner" },
      { clinic_id: clinicB, profile_id: ownerB, role: "owner" },
      { clinic_id: clinicB, profile_id: staffB, role: "receptionist" },
    ]);
  });

  afterAll(async () => {
    if (!admin) return;
    await admin.from("clinics").delete().in("id", [clinicA, clinicB]);
    for (const id of created) await admin.auth.admin.deleteUser(id);
  });

  beforeEach(() => asOwner());

  it("only the owner manages staff — an admin is refused", async () => {
    session.ctx = { profileId: ownerA, clinicId: clinicA, roles: ["admin"], platformAdmin: false };
    expect((await call(GET, "GET")).status).toBe(403);
    expect((await call(POST, "POST", { email: `x-${suffix}@test.local`, fullName: "X Y", role: "receptionist" })).status).toBe(403);
  });

  it("adds a receptionist: a new account whose one-time password signs in, audited with the owner as actor", async () => {
    const email = `new-reception-${suffix}@test.local`;
    const res = await call(POST, "POST", { email, fullName: "Yangi Qabulxona", role: "receptionist" });
    expect(res.status).toBe(201);
    const { profileId, temporaryPassword } = res.body.data as { profileId: string; temporaryPassword: string };
    created.push(profileId);
    expect(temporaryPassword.length).toBeGreaterThanOrEqual(12);
    expect(await roleOf(profileId)).toBe("receptionist");

    const anon = createClient(URL, ANON_KEY, { auth: { persistSession: false } });
    const { error: signInError } = await anon.auth.signInWithPassword({ email, password: temporaryPassword });
    expect(signInError).toBeNull();

    const { data: audit } = await admin
      .from("audit_events")
      .select("actor_id, action, new_values")
      .eq("clinic_id", clinicA)
      .eq("entity_id", profileId)
      .eq("action", "staff_added");
    expect(audit).toEqual([{ actor_id: ownerA, action: "staff_added", new_values: { role: "receptionist", account: "created" } }]);

    const list = await call(GET, "GET");
    const member = (list.body.data!.staff as Array<{ profileId: string; email: string; role: string }>).find((m) => m.profileId === profileId);
    expect(member).toMatchObject({ email, role: "receptionist" });

    // The same email again: already a member.
    expect((await call(POST, "POST", { email, fullName: "Yangi Qabulxona", role: "receptionist" })).body.code).toBe("already_member");
  });

  it("never attaches another clinic's staff account, and says nothing about it", async () => {
    const res = await call(POST, "POST", { email: `reception-b-${suffix}@test.local`, fullName: "Begona", role: "admin" });
    expect(res).toMatchObject({ status: 409, body: { code: "email_unavailable" } });
    expect(await roleOf(staffB, clinicA)).toBeNull();
    expect(await roleOf(staffB, clinicB)).toBe("receptionist");
  });

  it("changes and removes roles only within the owner's clinic, never an owner's or their own", async () => {
    const res = await call(POST, "POST", { email: `doctor-${suffix}@test.local`, fullName: "Dr Yangi", role: "doctor" });
    const { profileId } = res.body.data as { profileId: string };
    created.push(profileId);
    const doctorId = randomUUID();
    await admin.from("doctors").insert({ id: doctorId, clinic_id: clinicA, name: `Dr Yangi ${suffix}`, profile_id: profileId });

    // Doctor → receptionist: the doctor record no longer belongs to the account.
    expect((await call(PATCH, "PATCH", { profileId, role: "receptionist" })).status).toBe(200);
    expect(await roleOf(profileId)).toBe("receptionist");
    const { data: doctor } = await admin.from("doctors").select("profile_id").eq("id", doctorId).single();
    expect(doctor!.profile_id).toBeNull();

    // Owners and oneself are off limits; another clinic's members are not found.
    expect((await call(PATCH, "PATCH", { profileId: ownerA, role: "admin" })).body.code).toBe("self_change");
    expect((await call(DELETE, "DELETE", { profileId: ownerA })).body.code).toBe("self_change");
    expect((await call(PATCH, "PATCH", { profileId: staffB, role: "admin" })).status).toBe(404);
    expect((await call(DELETE, "DELETE", { profileId: staffB })).status).toBe(404);
    asOwner(clinicB, ownerB);
    expect((await call(DELETE, "DELETE", { profileId: ownerA })).status).toBe(404);
    asOwner();
    const coOwner = await account(`co-owner-${suffix}@test.local`);
    await admin.from("staff_roles").insert({ clinic_id: clinicA, profile_id: coOwner, role: "owner" });
    expect((await call(DELETE, "DELETE", { profileId: coOwner })).body.code).toBe("owner_protected");
    // The owner role is never handed out here.
    expect((await call(PATCH, "PATCH", { profileId, role: "owner" })).status).toBe(400);

    // Removal ends access to this clinic.
    expect((await call(DELETE, "DELETE", { profileId })).status).toBe(200);
    expect(await roleOf(profileId)).toBeNull();
    expect(await roleOf(staffB, clinicB)).toBe("receptionist");
  });
});

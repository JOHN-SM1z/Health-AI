import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { localDbAvailable } from "@/test/local-db";

/**
 * getStaffContext() role-resolution regression (Phase 1 dashboard
 * remediation, audit finding F-10).
 *
 * A profile may legitimately hold staff_roles rows at more than one clinic
 * (schema: unique(clinic_id, profile_id), not unique(profile_id)). The
 * resolved session must be scoped to exactly ONE clinic and that clinic's
 * roles only — merging roles across clinics would let e.g. a receptionist
 * at Clinic A who is also owner at Clinic B act with owner privileges while
 * working inside Clinic A's session.
 *
 * Requires: `npm run db:reset-local` + `.env` with local keys. Skips
 * cleanly when the stack is unavailable.
 */

const URL = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const ANON_KEY = process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";
const SEED_CLINIC = "11111111-1111-4111-8111-111111111111";

const staffClientMock = vi.hoisted(() => ({ client: null as unknown }));

vi.mock("@/lib/supabase/server", () => ({
  createStaffClient: async () => staffClientMock.client,
}));

import { getStaffContext } from "@/lib/auth/staff";

const describeDb = describe.skipIf(!localDbAvailable());

describeDb("getStaffContext() multi-clinic role scoping", () => {
  const suffix = Date.now().toString(36);
  const email = `multiclinic-${suffix}@test.local`;
  const password = "TestPassword123!";
  let userId = "";
  let secondClinicId = "";

  beforeAll(async () => {
    const admin = createClient(URL, SERVICE_KEY, { auth: { persistSession: false } });

    const { data: created, error: createError } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    expect(createError).toBeNull();
    userId = created?.user?.id ?? "";
    if (!userId) throw new Error("failed to create test user");

    const { error: profileError } = await admin.from("profiles").insert({ id: userId, full_name: "Multi Clinic" });
    expect(profileError).toBeNull();

    // Earliest membership: receptionist (lowest weight) at the seed clinic.
    const { error: firstRoleError } = await admin
      .from("staff_roles")
      .insert({ clinic_id: SEED_CLINIC, profile_id: userId, role: "receptionist" });
    expect(firstRoleError).toBeNull();

    // A second, later-created clinic where the SAME profile is owner.
    const { data: clinic, error: clinicError } = await admin
      .from("clinics")
      .insert({ name: `Second Clinic ${suffix}`, slug: `second-clinic-${suffix}` })
      .select("id")
      .single();
    expect(clinicError).toBeNull();
    secondClinicId = clinic?.id ?? "";
    if (!secondClinicId) throw new Error("failed to create second test clinic");

    const { error: secondRoleError } = await admin
      .from("staff_roles")
      .insert({ clinic_id: secondClinicId, profile_id: userId, role: "owner" });
    expect(secondRoleError).toBeNull();
  });

  afterAll(async () => {
    const admin = createClient(URL, SERVICE_KEY, { auth: { persistSession: false } });
    if (secondClinicId) await admin.from("clinics").delete().eq("id", secondClinicId);
    if (userId) await admin.auth.admin.deleteUser(userId).catch(() => {});
  });

  it("scopes the resolved session to the earliest clinic's roles only — never merges roles across clinics", async () => {
    const admin = createClient(URL, SERVICE_KEY, { auth: { persistSession: false } });
    const { data: session, error: signInError } = await admin.auth.signInWithPassword({ email, password });
    expect(signInError).toBeNull();

    const client = createClient(URL, ANON_KEY, { auth: { persistSession: false } });
    await client.auth.setSession(session!.session!);
    staffClientMock.client = client;

    const ctx = await getStaffContext();
    expect(ctx).not.toBeNull();
    // Resolves to the earliest membership (the seed clinic)...
    expect(ctx!.clinicId).toBe(SEED_CLINIC);
    expect(ctx!.roles).toEqual(["receptionist"]);
    // ...and "owner" from the second, later clinic must NEVER leak in.
    expect(ctx!.roles).not.toContain("owner");
  });
});

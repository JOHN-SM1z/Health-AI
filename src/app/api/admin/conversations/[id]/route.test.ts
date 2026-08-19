import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { NextRequest } from "next/server";
import { localDbAvailable } from "@/test/local-db";

/**
 * Conversation read tracking (audit finding, Phase 8): opening a
 * conversation marks it as seen by the admin; the marker is clinic-scoped.
 * Regression tests run the real route against the local database with a
 * mocked staff session.
 *
 * Requires: `npm run db:reset-local`. Skips cleanly when the stack is down.
 */

const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const URL = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";

const staffMock = vi.hoisted(() => ({ impl: async () => null as unknown }));

vi.mock("@/lib/auth/guards", () => ({
  requireRoles: () => staffMock.impl(),
}));

import { POST } from "./route";

const describeDb = describe.skipIf(!localDbAvailable());

describeDb("conversation mark_seen (real DB, mocked session)", () => {
  let admin: SupabaseClient;
  let clinicId: string;
  let otherClinicId: string;
  let patientId: string;
  let convId: string;
  let otherConvId: string;
  let actorProfileId: string;
  const suffix = Date.now().toString(36);

  const staffCtx = () => ({
    profileId: actorProfileId,
    clinicId,
    clinicName: "Conv Clinic",
    clinicTimezone: "Asia/Tashkent",
    roles: ["admin"] as const,
    platformAdmin: false,
  });

  beforeAll(async () => {
    admin = createClient(URL, SERVICE_KEY, { auth: { persistSession: false } });

    const { data: authUser, error: authError } = await admin.auth.admin.createUser({
      email: `conv-actor-${suffix}@test.local`,
      password: "TestPass123!",
      email_confirm: true,
    });
    expect(authError).toBeNull();
    if (!authUser?.user) throw new Error("actor auth user creation failed");
    actorProfileId = authUser.user.id;
    await admin.from("profiles").insert({ id: actorProfileId, full_name: `Conv Actor ${suffix}` });

    const { data: clinic } = await admin
      .from("clinics")
      .insert({ name: `Conv Clinic ${suffix}`, slug: `conv-${suffix}`, timezone: "Asia/Tashkent", currency: "UZS" })
      .select("id")
      .single();
    clinicId = clinic!.id;
    const { data: other } = await admin
      .from("clinics")
      .insert({ name: `Conv Other ${suffix}`, slug: `conv-o-${suffix}`, timezone: "Asia/Tashkent", currency: "UZS" })
      .select("id")
      .single();
    otherClinicId = other!.id;

    const { data: patient } = await admin
      .from("patients")
      .insert({ clinic_id: clinicId, full_name: "Conv Patient", phone: `+99896${suffix.slice(0, 7)}`, consent_given: true })
      .select("id")
      .single();
    patientId = patient!.id;

    const { data: conv } = await admin
      .from("conversations")
      .insert({ clinic_id: clinicId, patient_id: patientId, status: "open", ai_enabled: true, channel: "telegram" })
      .select("id")
      .single();
    convId = conv!.id;

    const { data: otherPatient } = await admin
      .from("patients")
      .insert({ clinic_id: otherClinicId, full_name: "Conv Other Patient", phone: `+99897${suffix.slice(0, 7)}`, consent_given: true })
      .select("id")
      .single();
    const { data: otherConv } = await admin
      .from("conversations")
      .insert({ clinic_id: otherClinicId, patient_id: otherPatient!.id, status: "open", ai_enabled: true, channel: "telegram" })
      .select("id")
      .single();
    otherConvId = otherConv!.id;

    staffMock.impl = async () => staffCtx();
  });

  afterAll(async () => {
    await admin.from("conversations").delete().in("id", [convId, otherConvId]);
    await admin.from("patients").delete().eq("clinic_id", clinicId);
    await admin.from("patients").delete().eq("clinic_id", otherClinicId);
    await admin.from("clinics").delete().in("id", [clinicId, otherClinicId]);
    await admin.from("profiles").delete().eq("id", actorProfileId);
    await admin.auth.admin.deleteUser(actorProfileId);
  });

  beforeEach(() => {
    staffMock.impl = async () => staffCtx();
  });

  function post(id: string, body: unknown): Promise<Response> {
    return POST(
      new NextRequest(`http://localhost/api/admin/conversations/${id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ id }) },
    );
  }

  it("marks the conversation as seen and persists admin_seen_at", async () => {
    const res = await post(convId, { action: "mark_seen" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data?: { updated?: boolean } };
    expect(body.data!.updated).toBe(true);

    const { data: conv } = await admin.from("conversations").select("admin_seen_at").eq("id", convId).single();
    expect(conv!.admin_seen_at).not.toBeNull();
  });

  it("does not leak read state across clinics (404 for foreign conversation)", async () => {
    const res = await post(otherConvId, { action: "mark_seen" });
    expect(res.status).toBe(404);
    const { data: conv } = await admin.from("conversations").select("admin_seen_at").eq("id", otherConvId).single();
    expect(conv!.admin_seen_at).toBeNull();
  });

  it("rejects unknown actions before touching the row (400)", async () => {
    const res = await post(convId, { action: "garbage" });
    expect(res.status).toBe(400);
  });

  it("takeover still works after mark_seen (CAS not weakened)", async () => {
    const res = await post(convId, { action: "takeover" });
    expect(res.status).toBe(200);
    const { data: conv } = await admin.from("conversations").select("status, taken_over_by").eq("id", convId).single();
    expect(conv!.status).toBe("assigned");
    expect(conv!.taken_over_by).not.toBeNull();
  });

  it("simultaneous takeovers: exactly one wins, the other gets 409 (CAS)", async () => {
    const { data: racePatient } = await admin
      .from("patients")
      .insert({ clinic_id: clinicId, full_name: "Race Patient", phone: `+99899${suffix.slice(0, 7)}`, consent_given: true })
      .select("id")
      .single();
    const { data: fresh } = await admin
      .from("conversations")
      .insert({ clinic_id: clinicId, patient_id: racePatient!.id, status: "open", ai_enabled: true, channel: "telegram" })
      .select("id")
      .single();
    const freshId = fresh!.id;
    const [a, b] = await Promise.all([
      post(freshId, { action: "takeover" }),
      post(freshId, { action: "takeover" }),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 409]);
    const { data: conv } = await admin.from("conversations").select("status, taken_over_by").eq("id", freshId).single();
    expect(conv!.status).toBe("assigned");
    expect(conv!.taken_over_by).not.toBeNull();
    await admin.from("conversations").delete().eq("id", freshId);
    await admin.from("patients").delete().eq("id", racePatient!.id);
  });
});
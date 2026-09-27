import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { NextRequest } from "next/server";
import { localDbAvailable } from "@/test/local-db";

/**
 * The referral lifecycle through the API: every transition a user can make,
 * the access that follows (or ends), the scheduled expiry job, and the audit
 * trail each step leaves — actor, clinic, patient, referral, action, time.
 * Real routes, services, decision, triggers and audit table on the local
 * Supabase stack; only the session lookup is mocked.
 *
 * Cast: Dr A (referring), Dr B (receiving), a manager.
 */

const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const URL = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const TZ = "Asia/Tashkent";

const session = vi.hoisted(() => ({ ctx: null as unknown }));

vi.mock("@/lib/auth/staff", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/staff")>();
  return { ...actual, getStaffContext: async () => session.ctx };
});

import { env } from "@/lib/env";
import { GET as listReferrals, POST as createReferral } from "./route";
import { GET as getReferral, PATCH as actOnReferral } from "./[id]/route";
import { GET as getWorkspace } from "../patients/[id]/route";
import { PATCH as revokeAsManagement } from "@/app/api/admin/referrals/[id]/route";
import { POST as expireJob } from "@/app/api/referrals/expire/route";

const describeDb = describe.skipIf(!localDbAvailable());

type Body = { ok: boolean; data?: Record<string, unknown>; code?: string };
type AuditRow = {
  action: string;
  actor_id: string | null;
  actor_type: string;
  clinic_id: string;
  patient_id: string | null;
  referral_id: string | null;
  entity_id: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
};

describeDb("referral lifecycle through the API — transitions, access termination, audit", () => {
  let admin: SupabaseClient;
  const suffix = Date.now().toString(36);
  const users: Record<string, string> = {};
  const doctors: Record<string, string> = {};
  let clinicA: string;
  let serviceA: string;
  let slot = 0;

  const as = (name: string, role = "doctor") => {
    session.ctx = { profileId: users[name], clinicId: clinicA, clinicName: "Lifecycle API", clinicTimezone: TZ, roles: [role], platformAdmin: false };
  };
  const request = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
    new NextRequest(`http://localhost${path}`, {
      method,
      headers: { ...headers, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const params = (id: string) => ({ params: Promise.resolve({ id }) });
  const read = async (res: Response) => ({ status: res.status, body: (await res.json()) as Body });

  const act = async (name: string, id: string, body: Record<string, unknown>) => {
    as(name);
    return read(await actOnReferral(request("PATCH", `/api/doctor/referrals/${id}`, body), params(id)));
  };
  const detail = async (name: string, id: string) => {
    as(name);
    return read(await getReferral(request("GET", `/api/doctor/referrals/${id}`), params(id)));
  };
  const list = async (name: string, box: "incoming" | "outgoing") => {
    as(name);
    const res = await read(await listReferrals(request("GET", `/api/doctor/referrals?box=${box}`)));
    return (res.body.data?.referrals ?? []) as Array<{ id: string; status: string }>;
  };
  const workspace = async (name: string, patientId: string) => {
    as(name);
    return read(await getWorkspace(request("GET", `/api/doctor/patients/${patientId}`), params(patientId)));
  };
  const status = async (id: string) => (await admin.from("referrals").select("status").eq("id", id).single()).data!.status as string;
  const audit = async (filter: Record<string, string>) => {
    let q = admin.from("audit_events").select("action, actor_id, actor_type, clinic_id, patient_id, referral_id, entity_id, metadata, created_at");
    for (const [k, v] of Object.entries(filter)) q = q.eq(k, v);
    return ((await q.order("created_at", { ascending: true })).data ?? []) as AuditRow[];
  };
  /** The referral's lifecycle row for `action`: who, which clinic, patient and referral, when. */
  async function expectLifecycleAudit(referralId: string, patientId: string, action: string, actor: string | null) {
    const rows = await audit({ referral_id: referralId, action });
    expect(rows, action).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      clinic_id: clinicA,
      patient_id: patientId,
      referral_id: referralId,
      actor_id: actor,
      actor_type: actor ? "staff" : "system",
    });
    expect(Date.now() - Date.parse(rows[0].created_at)).toBeLessThan(120_000);
  }

  async function makeUser(name: string, role: string) {
    const { data, error } = await admin.auth.admin.createUser({ email: `lifecycle-api-${name}-${suffix}@test.local`, password: "Lifecycle-Test-123!", email_confirm: true });
    expect(error).toBeNull();
    users[name] = data.user!.id;
    await admin.from("profiles").insert({ id: users[name], full_name: name });
    await admin.from("staff_roles").insert({ clinic_id: clinicA, profile_id: users[name], role });
  }

  async function makeDoctor(name: string) {
    const { data } = await admin
      .from("doctors")
      .insert({ clinic_id: clinicA, profile_id: users[name], name: `Dr ${name.toUpperCase()} ${suffix}`, active: true })
      .select("id")
      .single();
    doctors[name] = data!.id;
    await admin.from("doctor_working_hours").insert(
      [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ clinic_id: clinicA, doctor_id: data!.id, weekday, start_time: "00:00", end_time: "23:59" })),
    );
  }

  async function visit(patientId: string, doctor: string, statusValue = "completed") {
    const startTime = new Date(Date.UTC(2026, 0, 5, 5, 0) + slot++ * 86_400_000);
    const { data, error } = await admin
      .from("appointments")
      .insert({
        clinic_id: clinicA,
        patient_id: patientId,
        doctor_id: doctor,
        service_id: serviceA,
        start_at: startTime.toISOString(),
        end_at: new Date(startTime.getTime() + 30 * 60_000).toISOString(),
        status: statusValue,
        source: "walk_in",
      })
      .select("id")
      .single();
    expect(error).toBeNull();
    return data!.id as string;
  }

  async function writeRecord(patientId: string, doctor: "a" | "b", appointmentId: string, summary: string) {
    const { data, error } = await admin
      .from("clinical_records")
      .insert({ clinic_id: clinicA, patient_id: patientId, author_doctor_id: doctors[doctor], appointment_id: appointmentId, record_type: "diagnosis", summary, created_by: users[doctor] })
      .select("id")
      .single();
    expect(error).toBeNull();
    return data!.id as string;
  }

  async function patientX() {
    const { data } = await admin.from("patients").insert({ clinic_id: clinicA, full_name: `Lifecycle API patient ${suffix}` }).select("id").single();
    const id = data!.id as string;
    const consultation = await visit(id, doctors.a);
    const aRecord = await writeRecord(id, "a", consultation, `Essential hypertension (${suffix})`);
    return { id, consultation, aRecord };
  }

  async function refer(x: { consultation: string }) {
    as("a");
    const res = await read(
      await createReferral(
        request("POST", "/api/doctor/referrals", {
          idempotencyKey: randomUUID(),
          appointmentId: x.consultation,
          referredToDoctorId: doctors.b,
          reason: `Please assess (${suffix})`,
          priority: "routine",
          validForDays: 30,
        }),
      ),
    );
    expect(res.status).toBe(201);
    return (res.body.data!.referral as { id: string }).id;
  }

  /** A referral inserted with a validity of a few seconds (the API offers 30–180 days). */
  async function shortLived(x: { id: string; consultation: string }, ms: number) {
    const { data, error } = await admin
      .from("referrals")
      .insert({
        clinic_id: clinicA,
        patient_id: x.id,
        referring_doctor_id: doctors.a,
        referred_to_doctor_id: doctors.b,
        originating_appointment_id: x.consultation,
        reason: `Short-lived (${suffix})`,
        created_by: users.a,
        expires_at: new Date(Date.now() + ms).toISOString(),
      })
      .select("id")
      .single();
    expect(error).toBeNull();
    return data!.id as string;
  }

  /** Dr B's consultation for the referral starts (linked as its follow-up → in progress). */
  async function start(referralId: string, patientId: string) {
    const own = await visit(patientId, doctors.b, "in_progress");
    await admin.from("referrals").update({ follow_up_appointment_id: own }).eq("id", referralId);
    expect(await status(referralId)).toBe("in_progress");
    return own;
  }

  beforeAll(async () => {
    admin = createClient(URL, SERVICE_KEY, { auth: { persistSession: false } });
    const { data: clinic } = await admin
      .from("clinics")
      .insert({ name: `Lifecycle API ${suffix}`, slug: `lifecycle-api-${suffix}`, timezone: TZ })
      .select("id")
      .single();
    clinicA = clinic!.id;
    await makeUser("a", "doctor");
    await makeUser("b", "doctor");
    await makeUser("manager", "manager");
    await makeDoctor("a");
    await makeDoctor("b");
    const { data: svc } = await admin
      .from("services")
      .insert({ clinic_id: clinicA, name: `Lifecycle API consult ${suffix}`, duration_minutes: 30, price: 100000, active: true })
      .select("id")
      .single();
    serviceA = svc!.id;
  });

  afterAll(async () => {
    if (!admin || !clinicA) return;
    await admin.from("patients").delete().eq("clinic_id", clinicA);
    await admin.from("staff_roles").delete().eq("clinic_id", clinicA);
    await admin.from("doctors").delete().eq("clinic_id", clinicA);
    await admin.from("services").delete().eq("clinic_id", clinicA);
    await admin.from("clinics").delete().eq("id", clinicA);
    for (const id of Object.values(users)) await admin.auth.admin.deleteUser(id).catch(() => {});
  });

  it("created → viewed → accepted → in progress → completed: each step audited with actor, clinic, patient, referral", async () => {
    const x = await patientX();
    const referral = await refer(x);
    await expectLifecycleAudit(referral, x.id, "referral_created", users.a);

    // Viewed — the detail and every list that shows its text.
    expect((await detail("b", referral)).status).toBe(200);
    expect((await list("b", "incoming")).map((r) => r.id)).toContain(referral);
    expect((await list("a", "outgoing")).map((r) => r.id)).toContain(referral);
    const views = await audit({ referral_id: referral, action: "referral_viewed" });
    expect(views.map((v) => [v.actor_id, v.metadata.via])).toEqual(
      expect.arrayContaining([
        [users.b, "detail"],
        [users.b, "list"],
        [users.a, "list"],
      ]),
    );
    for (const v of views) expect(v).toMatchObject({ clinic_id: clinicA, patient_id: x.id, referral_id: referral, actor_type: "staff" });

    expect(await act("b", referral, { action: "accept" })).toMatchObject({ status: 200 });
    await expectLifecycleAudit(referral, x.id, "referral_accepted", users.b);

    // Clinical record access through the referral: which records of another doctor were released, under which referral.
    expect((await workspace("b", x.id)).status).toBe(200);
    const [recordView] = (await audit({ patient_id: x.id, action: "patient_clinical_record_viewed", actor_id: users.b })).slice(-1);
    expect(recordView).toMatchObject({ clinic_id: clinicA, patient_id: x.id, referral_id: referral, metadata: { shared_record_ids: [x.aRecord] } });

    await start(referral, x.id);
    await expectLifecycleAudit(referral, x.id, "referral_in_progress", users.b);
    expect(await act("b", referral, { action: "complete" })).toMatchObject({ status: 200, body: { data: { status: "completed" } } });
    await expectLifecycleAudit(referral, x.id, "referral_completed", users.b);
  });

  it("declined: audited, and Dr B's access ends — the refusal itself is logged against the referral", async () => {
    const x = await patientX();
    const referral = await refer(x);
    expect(await act("b", referral, { action: "decline", reason: "Outside my specialty" })).toMatchObject({ status: 200 });
    await expectLifecycleAudit(referral, x.id, "referral_declined", users.b);

    expect(await workspace("b", x.id)).toMatchObject({ status: 410, body: { code: "referral_declined" } });
    expect(await detail("b", referral)).toMatchObject({ status: 410, body: { code: "referral_declined" } });
    const [denied] = (await audit({ action: "patient_clinical_access_denied", actor_id: users.b, referral_id: referral })).slice(-1);
    expect(denied).toMatchObject({ clinic_id: clinicA, patient_id: x.id, metadata: { referral_status: "declined" } });
  });

  it("revoked by the referring doctor or by management: immediate, audited with who did it", async () => {
    for (const by of ["a", "manager"] as const) {
      const x = await patientX();
      const referral = await refer(x);
      await act("b", referral, { action: "accept" });
      expect((await workspace("b", x.id)).status).toBe(200);

      if (by === "a") {
        expect(await act("a", referral, { action: "revoke", reason: "Patient transferred" })).toMatchObject({ status: 200 });
      } else {
        as("manager", "manager");
        const res = await read(await revokeAsManagement(request("PATCH", `/api/admin/referrals/${referral}`, { action: "revoke", reason: "Duplicate" }), params(referral)));
        expect(res.status).toBe(200);
      }
      await expectLifecycleAudit(referral, x.id, "referral_revoked", users[by]);
      // The very next request is refused.
      expect(await workspace("b", x.id)).toMatchObject({ status: 410, body: { code: "referral_revoked" } });
      expect((await list("b", "incoming")).map((r) => r.id)).not.toContain(referral);
    }
  });

  it("expired: access ends at expires_at; the scheduled job records it (as the system) and requires the cron secret", async () => {
    const x = await patientX();
    const referral = await shortLived(x, 2_000);
    await act("b", referral, { action: "accept" });
    expect((await workspace("b", x.id)).status).toBe(200);
    await new Promise((r) => setTimeout(r, 2_500));

    // Ended before anything recorded it.
    expect(await status(referral)).toBe("accepted");
    expect(await workspace("b", x.id)).toMatchObject({ status: 410, body: { code: "referral_expired" } });

    // The job: no secret, a wrong one → 401 and nothing changes.
    for (const auth of [undefined, "Bearer wrong-secret", `Bearer ${env.CRON_SECRET}x`]) {
      const res = await expireJob(request("POST", "/api/referrals/expire", undefined, auth ? { authorization: auth } : {}));
      expect(res.status).toBe(401);
    }
    expect(await status(referral)).toBe("accepted");
    const res = await expireJob(request("POST", "/api/referrals/expire", undefined, { authorization: `Bearer ${env.CRON_SECRET}` }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { expired: number }).expired).toBeGreaterThanOrEqual(1);
    expect(await status(referral)).toBe("expired");
    await expectLifecycleAudit(referral, x.id, "referral_expired", null);
    expect(await detail("b", referral)).toMatchObject({ status: 410, body: { code: "referral_expired" } });
  }, 20_000); // waits for a real expiry (seconds) — generous under parallel load

  it("completed: no referral-based access for Dr B — and past expires_at neither doctor keeps anything of the other's", async () => {
    const x = await patientX();
    const referral = await shortLived(x, 4_000);
    await act("b", referral, { action: "accept" });
    const own = await start(referral, x.id);
    const bRecord = await writeRecord(x.id, "b", own, `Hypertensive heart disease (${suffix})`);
    expect(await act("b", referral, { action: "complete" })).toMatchObject({ status: 200 });

    // Straight after completion: Dr B sees only their own consultation; Dr A receives its outcome.
    const b = (await workspace("b", x.id)).body.data!.record as { relationship: string; records: Array<{ id: string }>; referralAccessUntil: string | null };
    expect(b).toMatchObject({ relationship: "own", referralAccessUntil: null });
    expect(b.records.map((r) => r.id)).toEqual([bRecord]);
    const a = (await workspace("a", x.id)).body.data!.record as { records: Array<{ id: string }> };
    expect(a.records.map((r) => r.id).sort()).toEqual([x.aRecord, bRecord].sort());
    expect((await detail("b", referral)).status).toBe(200);

    await new Promise((r) => setTimeout(r, 4_500));
    // Not permanent: the completed referral's text is gone for Dr B, the outcome for Dr A.
    expect(await detail("b", referral)).toMatchObject({ status: 410, body: { code: "referral_completed" } });
    expect((await list("b", "incoming")).map((r) => r.id)).not.toContain(referral);
    const bAfter = (await workspace("b", x.id)).body.data!.record as { records: Array<{ id: string }> };
    expect(bAfter.records.map((r) => r.id)).toEqual([bRecord]);
    const aAfter = (await workspace("a", x.id)).body.data!.record as { records: Array<{ id: string }> };
    expect(aAfter.records.map((r) => r.id)).toEqual([x.aRecord]);
    expect((await detail("a", referral)).status).toBe(200); // the referring doctor's own referral
  }, 20_000); // waits for a real expiry (seconds) — generous under parallel load

  it("an open referral tells Dr B until when referral-based access lasts", async () => {
    const x = await patientX();
    const referral = await refer(x);
    const ws = (await workspace("b", x.id)).body.data!.record as { referralAccessUntil: string | null };
    const { data } = await admin.from("referrals").select("expires_at").eq("id", referral).single();
    expect(Date.parse(ws.referralAccessUntil!)).toBe(Date.parse(data!.expires_at));
  });

  it("a probe of an unknown patient is logged without inventing a patient reference", async () => {
    const probe = randomUUID();
    expect(await workspace("b", probe)).toMatchObject({ status: 404 });
    const [row] = (await audit({ action: "patient_clinical_access_denied", entity_id: probe })).slice(-1);
    expect(row).toMatchObject({ clinic_id: clinicA, actor_id: users.b, patient_id: null, referral_id: null });
  });
});

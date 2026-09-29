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
 * The access model (supabase/migrations/20261002000001_longitudinal_history.sql):
 * a referral is a clinical handoff — from the moment it exists (pending) the
 * receiving doctor sees the patient's whole clinical history in the clinic,
 * every doctor's visits and records, without anyone's approval. Access that
 * rests ONLY on the referral ends when it is declined, revoked or completed
 * and, at the latest, at expires_at (the database clock, before any sweep
 * records it). The receiving doctor's own non-cancelled appointment with the
 * patient (their consultation, or the follow-up reception booked) is a
 * treating relationship of its own and keeps the history (continuity of care).
 *
 * Audit: list views are 'referral_viewed', the detail view 'referral_opened',
 * the workspace 'clinical_record_viewed', a refused patient read
 * 'unauthorized_clinical_access_attempt'.
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
import { POST as bookAppointment } from "@/app/api/admin/appointments/route";
import { POST as expireJob } from "@/app/api/referrals/expire/route";
import { asOnlyGlobalSweep } from "@/test/referral-sweep-lock";

const describeDb = describe.skipIf(!localDbAvailable());

type Body = { ok: boolean; data?: Record<string, unknown>; code?: string };
type AuditRow = {
  action: string;
  actor_id: string | null;
  actor_type: string;
  clinic_id: string;
  patient_id: string | null;
  referral_id: string | null;
  entity_type: string;
  entity_id: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
};
type Workspace = {
  relationship: string;
  activeReferralIds: string[];
  referralAccessUntil: string | null;
  appointments: Array<{ id: string; mine: boolean }>;
  records: Array<{ id: string; author: { id: string }; mine: boolean }>;
  referrals: Array<{ id: string; role: string; status: string; allowedActions: string[] }>;
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
  /** The workspace `name` is shown (asserting it is shown at all). */
  const ws = async (name: string, patientId: string) => {
    const res = await workspace(name, patientId);
    expect(res.status, `${name}: ${JSON.stringify(res.body)}`).toBe(200);
    return res.body.data!.record as Workspace;
  };
  const status = async (id: string) => (await admin.from("referrals").select("status").eq("id", id).single()).data!.status as string;
  const audit = async (filter: Record<string, string>) => {
    let q = admin.from("audit_events").select("action, actor_id, actor_type, clinic_id, patient_id, referral_id, entity_type, entity_id, metadata, created_at");
    for (const [k, v] of Object.entries(filter)) q = q.eq(k, v);
    return ((await q.order("created_at", { ascending: true })).data ?? []) as AuditRow[];
  };
  /** A refused patient read by `name`: the refusal names the lapsed referral and its status (ids only). */
  const refusalOf = (name: string, patientId: string, referralId: string, referralStatus: string) => ({
    action: "unauthorized_clinical_access_attempt",
    actor_id: users[name],
    actor_type: "staff",
    clinic_id: clinicA,
    entity_type: "patients",
    entity_id: patientId,
    patient_id: patientId,
    referral_id: referralId,
    metadata: { doctor_id: doctors[name], referral_status: referralStatus },
  });
  const sorted = (ids: string[]) => [...ids].sort();
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

  /** A slot some days ahead (10:00 in the clinic's zone), one per call. */
  const futureStart = () => {
    const day = new Date(Date.now() + (3 + slot++) * 86_400_000);
    return new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), 5, 0)).toISOString();
  };

  /** The appointment is cancelled (as reception would) — it no longer relates its doctor to the patient. */
  async function cancel(appointmentId: string) {
    const { error } = await admin
      .from("appointments")
      .update({ status: "cancelled", cancelled_at: new Date().toISOString(), cancelled_reason: "Entered in error" })
      .eq("id", appointmentId);
    expect(error).toBeNull();
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

    // Opened while pending: the patient's history comes with the referral at once — no acceptance needed.
    const opened = await detail("b", referral);
    expect(opened).toMatchObject({ status: 200, body: { data: { referral: { role: "receiver", status: "pending", patientRecordAccessible: true } } } });
    expect((opened.body.data!.referral as { history: Array<{ id: string }> }).history.map((h) => h.id)).toEqual([x.consultation]);
    // Viewed — every list that shows its text.
    expect((await list("b", "incoming")).map((r) => r.id)).toContain(referral);
    expect((await list("a", "outgoing")).map((r) => r.id)).toContain(referral);

    // The detail view is 'referral_opened'; the lists stay 'referral_viewed' — one row per view, in order.
    const opens = await audit({ referral_id: referral, action: "referral_opened" });
    expect(opens).toEqual([
      expect.objectContaining({
        actor_id: users.b,
        actor_type: "staff",
        clinic_id: clinicA,
        patient_id: x.id,
        referral_id: referral,
        entity_type: "referrals",
        entity_id: referral,
        metadata: { via: "detail", role: "receiver", status: "pending", relationship: "referred", history_shared: true },
      }),
    ]);
    const views = await audit({ referral_id: referral, action: "referral_viewed" });
    expect(views.map((v) => [v.actor_id, v.metadata])).toEqual([
      [users.b, { via: "list", box: "incoming", role: "receiver", status: "pending" }],
      [users.a, { via: "list", box: "outgoing", role: "referrer", status: "pending" }],
    ]);
    for (const v of views) expect(v).toMatchObject({ clinic_id: clinicA, patient_id: x.id, referral_id: referral, entity_id: referral, actor_type: "staff" });

    expect(await act("b", referral, { action: "accept" })).toMatchObject({ status: 200 });
    await expectLifecycleAudit(referral, x.id, "referral_accepted", users.b);

    // The workspace read through the referral: the patient, the relationship it rests on, the referral, and
    // which records — here Dr A's — were shown. Ids only.
    const seen = await ws("b", x.id);
    expect(seen).toMatchObject({ relationship: "referred", activeReferralIds: [referral] });
    expect(seen.records.map((r) => [r.id, r.author.id, r.mine])).toEqual([[x.aRecord, doctors.a, false]]);
    expect(await audit({ patient_id: x.id, action: "clinical_record_viewed", actor_id: users.b })).toEqual([
      expect.objectContaining({
        clinic_id: clinicA,
        entity_type: "patients",
        entity_id: x.id,
        patient_id: x.id,
        referral_id: referral,
        metadata: {
          via: "workspace",
          relationship: "referred",
          referral_ids: [referral],
          shown_referral_ids: [referral],
          record_count: 1,
          record_ids: [x.aRecord],
          other_author_record_ids: [x.aRecord],
        },
      }),
    ]);

    await start(referral, x.id);
    await expectLifecycleAudit(referral, x.id, "referral_in_progress", users.b);
    expect(await act("b", referral, { action: "complete" })).toMatchObject({ status: 200, body: { data: { status: "completed" } } });
    await expectLifecycleAudit(referral, x.id, "referral_completed", users.b);
  });

  it("declined: audited, and the access Dr B had from the referral's creation ends — the refusal itself is logged against the referral", async () => {
    const x = await patientX();
    const referral = await refer(x);
    // Pending, and already the patient's history — Dr A's record included.
    expect((await ws("b", x.id)).records.map((r) => r.id)).toEqual([x.aRecord]);

    expect(await act("b", referral, { action: "decline", reason: "Outside my specialty" })).toMatchObject({ status: 200 });
    await expectLifecycleAudit(referral, x.id, "referral_declined", users.b);

    const refused = await workspace("b", x.id);
    expect(refused).toMatchObject({ status: 410, body: { code: "referral_declined" } });
    expect(JSON.stringify(refused.body)).not.toContain("hypertension");
    expect(await detail("b", referral)).toMatchObject({ status: 410, body: { code: "referral_declined" } });
    // One refusal row, for the workspace read (the detail's 410 releases nothing and names only the status).
    expect(await audit({ action: "unauthorized_clinical_access_attempt", actor_id: users.b, referral_id: referral })).toEqual([
      expect.objectContaining(refusalOf("b", x.id, referral, "declined")),
    ]);
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
      // The very next request is refused — the referral was Dr B's only link to the patient.
      expect(await workspace("b", x.id)).toMatchObject({ status: 410, body: { code: "referral_revoked" } });
      expect(await audit({ action: "unauthorized_clinical_access_attempt", actor_id: users.b, referral_id: referral })).toEqual([
        expect.objectContaining(refusalOf("b", x.id, referral, "revoked")),
      ]);
      expect((await list("b", "incoming")).map((r) => r.id)).not.toContain(referral);
    }
  });

  it("revoked after reception booked the follow-up: Dr B keeps the history through that booking — once it is cancelled, nothing", async () => {
    const x = await patientX();
    const referral = await refer(x);
    await act("b", referral, { action: "accept" });
    as("manager", "manager");
    const booked = await read(
      await bookAppointment(
        request("POST", "/api/admin/appointments", {
          patientName: "Lifecycle follow-up",
          doctorId: doctors.b,
          serviceId: serviceA,
          startAt: futureStart(),
          source: "admin",
          referralId: referral,
        }),
      ),
    );
    expect(booked.status).toBe(201);
    const followUp = booked.body.data!.appointmentId as string;
    expect((await admin.from("referrals").select("status, follow_up_appointment_id").eq("id", referral).single()).data).toEqual({
      status: "accepted",
      follow_up_appointment_id: followUp,
    });
    // The booked visit is Dr B's own relationship with the patient, next to the referral.
    expect(await ws("b", x.id)).toMatchObject({ relationship: "own", activeReferralIds: [referral], referralAccessUntil: null });

    expect(await act("a", referral, { action: "revoke", reason: "Patient transferred" })).toMatchObject({ status: 200 });
    // Revoked: the referral gives nothing any more — the booking still relates Dr B to the patient (continuity of care).
    const kept = await ws("b", x.id);
    expect(kept).toMatchObject({ relationship: "own", activeReferralIds: [], referralAccessUntil: null });
    expect(sorted(kept.appointments.map((a) => a.id))).toEqual(sorted([x.consultation, followUp]));
    expect(kept.records.map((r) => [r.id, r.mine])).toEqual([[x.aRecord, false]]);
    expect(kept.referrals).toEqual([expect.objectContaining({ id: referral, role: "receiver", status: "revoked", allowedActions: [] })]);

    // The booking cancelled: the revoked referral was the only other link — nothing is left.
    await cancel(followUp);
    expect(await workspace("b", x.id)).toMatchObject({ status: 410, body: { code: "referral_revoked" } });
    expect(await audit({ action: "unauthorized_clinical_access_attempt", actor_id: users.b, referral_id: referral })).toEqual([
      expect.objectContaining(refusalOf("b", x.id, referral, "revoked")),
    ]);
  });

  it("expired: access ends at expires_at; the scheduled job records it (as the system) and requires the cron secret", async () => {
    await asOnlyGlobalSweep(async () => {
      const x = await patientX();
      const referral = await shortLived(x, 2_000);
      await act("b", referral, { action: "accept" });
      expect((await workspace("b", x.id)).status).toBe(200);
      await new Promise((r) => setTimeout(r, 2_500));

      // Ended before anything recorded it — the refusal already names the expiry.
      expect(await status(referral)).toBe("accepted");
      expect(await workspace("b", x.id)).toMatchObject({ status: 410, body: { code: "referral_expired" } });
      expect(await audit({ action: "unauthorized_clinical_access_attempt", actor_id: users.b, referral_id: referral })).toEqual([
        expect.objectContaining(refusalOf("b", x.id, referral, "expired")),
      ]);

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
    });
  }, 20_000); // waits for a real expiry (seconds) — generous under parallel load

  it("completed: nothing rests on the referral any more — Dr B's own consultation keeps the whole history, past expires_at too; only the referral closes", async () => {
    const x = await patientX();
    const referral = await shortLived(x, 4_000);
    await act("b", referral, { action: "accept" });
    const own = await start(referral, x.id);
    const bRecord = await writeRecord(x.id, "b", own, `Hypertensive heart disease (${suffix})`);
    expect(await act("b", referral, { action: "complete" })).toMatchObject({ status: 200 });

    // Straight after completion: no open referral — Dr B's consultation (and record) is a treating relationship of
    // its own, so Dr B keeps the patient's whole history; Dr A sees Dr B's outcome the same way.
    const b = await ws("b", x.id);
    expect(b).toMatchObject({ relationship: "own", activeReferralIds: [], referralAccessUntil: null });
    expect(sorted(b.records.map((r) => r.id))).toEqual(sorted([x.aRecord, bRecord]));
    expect(sorted(b.appointments.map((a) => a.id))).toEqual(sorted([x.consultation, own]));
    const a = await ws("a", x.id);
    expect(sorted(a.records.map((r) => r.id))).toEqual(sorted([x.aRecord, bRecord]));
    expect((await detail("b", referral)).status).toBe(200);

    await new Promise((r) => setTimeout(r, 4_500));
    // Past expires_at the completed referral itself is closed to Dr B (its detail, their incoming list)…
    expect(await detail("b", referral)).toMatchObject({ status: 410, body: { code: "referral_completed" } });
    expect((await list("b", "incoming")).map((r) => r.id)).not.toContain(referral);
    // …but the history never rested on it: both doctors treated the patient.
    const bAfter = await ws("b", x.id);
    expect(bAfter.relationship).toBe("own");
    expect(sorted(bAfter.records.map((r) => r.id))).toEqual(sorted([x.aRecord, bRecord]));
    expect(bAfter.referrals).toEqual([expect.objectContaining({ id: referral, role: "receiver", status: "completed", allowedActions: [] })]);
    const aAfter = await ws("a", x.id);
    expect(sorted(aAfter.records.map((r) => r.id))).toEqual(sorted([x.aRecord, bRecord]));
    expect((await detail("a", referral)).status).toBe(200); // the referring doctor's own referral
  }, 20_000); // waits for a real expiry (seconds) — generous under parallel load

  it("completed, Dr B's consultation since cancelled and nothing written: the referral was the only link — nothing of the patient is left", async () => {
    const x = await patientX();
    const referral = await refer(x);
    await act("b", referral, { action: "accept" });
    const own = await start(referral, x.id);
    expect(await act("b", referral, { action: "complete" })).toMatchObject({ status: 200, body: { data: { status: "completed" } } });
    expect((await ws("b", x.id)).relationship).toBe("own");

    await cancel(own);
    // No live appointment, no record of theirs, no open referral: refused, and the refusal names the completion.
    const refused = await workspace("b", x.id);
    expect(refused).toMatchObject({ status: 410, body: { code: "referral_completed" } });
    expect(JSON.stringify(refused.body)).not.toContain("hypertension");
    expect(await audit({ action: "unauthorized_clinical_access_attempt", actor_id: users.b, referral_id: referral })).toEqual([
      expect.objectContaining(refusalOf("b", x.id, referral, "completed")),
    ]);
    // The completed referral stays readable to its two doctors until expires_at — its own text, never the history.
    expect((await detail("b", referral)).body.data!.referral).toMatchObject({
      role: "receiver",
      status: "completed",
      patientRecordAccessible: false,
      consultation: null,
      followUp: null,
      history: null,
      allowedActions: [],
    });
    expect((await audit({ referral_id: referral, action: "referral_opened", actor_id: users.b })).map((r) => r.metadata)).toEqual([
      { via: "detail", role: "receiver", status: "completed", relationship: "none", history_shared: false },
    ]);
  });

  it("an open referral tells Dr B until when referral-based access lasts", async () => {
    const x = await patientX();
    const referral = await refer(x);
    const ws = (await workspace("b", x.id)).body.data!.record as { referralAccessUntil: string | null };
    const { data } = await admin.from("referrals").select("expires_at").eq("id", referral).single();
    expect(Date.parse(ws.referralAccessUntil!)).toBe(Date.parse(data!.expires_at));
  });

  it("a probe of an unknown patient is logged without inventing a patient reference", async () => {
    const probe = randomUUID();
    expect(await workspace("b", probe)).toMatchObject({ status: 404, body: { code: "patient_not_found" } });
    expect(await audit({ action: "unauthorized_clinical_access_attempt", entity_id: probe })).toEqual([
      expect.objectContaining({
        clinic_id: clinicA,
        actor_id: users.b,
        actor_type: "staff",
        entity_type: "patients",
        entity_id: probe,
        patient_id: null,
        referral_id: null,
        metadata: { doctor_id: doctors.b, referral_status: null },
      }),
    ]);
  });
});

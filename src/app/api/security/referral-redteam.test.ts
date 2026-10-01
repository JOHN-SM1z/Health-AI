import { cleanupTestClinics } from "@/test/cleanup-clinics";
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { NextRequest } from "next/server";
import { localDbAvailable } from "@/test/local-db";

/**
 * RED-TEAM suite for clinical access and referrals. Every attack is made
 * against the real route handlers, services, decision function, triggers and
 * RLS on the local Supabase stack — only the session lookup is replaced, so a
 * test "as receptionist" is exactly a request carrying a receptionist's
 * session. Direct database attacks use real signed-in Supabase sessions
 * (their own JWT against the REST API), like a client bypassing the app.
 *
 * A passing test proves the DATA or API access is denied — never that a
 * button is hidden. Every response to an attack is also checked for leaked
 * patient or clinical text.
 *
 * The model under attack (supabase/migrations/20261002000001_longitudinal_history.sql):
 * a doctor with a legitimate relationship — a non-cancelled appointment with
 * the patient or a record they wrote, or an open referral to them (or, while
 * nobody has taken it, to their department) — sees the patient's WHOLE
 * clinical history in the clinic, from the moment a referral exists. What
 * must never happen: a same-clinic doctor without a relationship, or anyone
 * of another clinic, seeing anything; a doctor changing a record they did not
 * write; anyone but the session's doctor acting on (or taking) a referral;
 * access that rests only on a referral outliving its decline, revocation,
 * completion or expires_at; operational staff seeing clinical text.
 *
 * Cast (clinic A unless noted): Dr A (refers), Dr B (receives), Dr C (no
 * relationship), a receptionist, a manager linked to a doctor record but
 * without the doctor role, Dr K and Dr K2 (clinic B). Departments: Dr Card1
 * and Dr Card2 (cardiology), Dr Neuro (neurology), an observer (no
 * department), Dr KCard (clinic B, a department with cardiology's very name).
 */

const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const ANON_KEY = process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";
const URL = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
// A zone where it is daytime now: walk-ins "now" stay inside one local day.
const TZ = daytimeTimezone();
const PASSWORD = "RedTeam-Test-123!";

const session = vi.hoisted(() => ({ ctx: null as unknown }));
vi.mock("@/lib/auth/staff", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/staff")>();
  return { ...actual, getStaffContext: async () => session.ctx };
});

import { env } from "@/lib/env";
import { GET as patientList } from "@/app/api/doctor/patients/route";
import { GET as workspaceGet } from "@/app/api/doctor/patients/[id]/route";
import { POST as recordPost } from "@/app/api/doctor/patients/[id]/records/route";
import { POST as consultationPost } from "@/app/api/doctor/patients/[id]/consultations/route";
import { GET as referralList, POST as referralCreate } from "@/app/api/doctor/referrals/route";
import { GET as referralGet, PATCH as referralAct } from "@/app/api/doctor/referrals/[id]/route";
import { GET as recipientsGet } from "@/app/api/doctor/referrals/recipients/route";
import { GET as pendingCountGet } from "@/app/api/doctor/referrals/pending-count/route";
import { PATCH as doctorAppointmentPatch } from "@/app/api/doctor/appointments/[id]/route";
import { POST as timeBlockPost } from "@/app/api/doctor/appointments/route";
import { GET as adminPatientsGet } from "@/app/api/admin/patients/route";
import { POST as adminBook } from "@/app/api/admin/appointments/route";
import { PATCH as adminRevoke } from "@/app/api/admin/referrals/[id]/route";
import { POST as expireJob } from "@/app/api/referrals/expire/route";
import { daytimeTimezone } from "@/test/daytime-timezone";

const describeDb = describe.skipIf(!localDbAvailable());

type Res = { status: number; body: { ok: boolean; data?: Record<string, unknown>; code?: string; error?: string } };
type Handler = (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;
type ListHandler = (req: NextRequest) => Promise<Response>;

describeDb("RED TEAM — referral-based clinical access", () => {
  let admin: SupabaseClient;
  const suffix = Date.now().toString(36);
  const SECRET = `RT-SECRET-${suffix}`;
  const users: Record<string, string> = {};
  const emails: Record<string, string> = {};
  const doctors: Record<string, string> = {};
  const clinic: Record<"A" | "B", string> = { A: "", B: "" };
  const service: Record<"A" | "B", string> = { A: "", B: "" };
  // Clinic A's cardiology and neurology; clinic B's department of the same name as clinic A's cardiology.
  const specialty: Record<"cardio" | "neuro" | "cardioB", string> = { cardio: "", neuro: "", cardioB: "" };
  let slot = 0;

  // The world under attack.
  let X: { id: string; consultation: string; record: string }; // Dr A's patient, referred to Dr B (accepted)
  let Y: { id: string; consultation: string; record: string }; // Dr C's patient — unrelated to Dr B
  let Z: { id: string; consultation: string; record: string }; // clinic B, Dr K's patient
  let active: string; // A → B, accepted
  let W: { id: string; consultation: string; record: string }; // accepted referral to Dr B, no consultation started
  let aToC: string; // A → C (Dr B is not a party)
  let clinicBReferral: string; // K → K2 in clinic B
  let expired: { referral: string; patient: string };
  let revoked: { referral: string; patient: string };
  let completed: { referral: string; patient: string; own: string; consultation: string; record: string };
  // Completed too, but Dr B's consultation was cancelled afterwards and Dr B wrote nothing: the referral was the only link.
  let completedOnly: { referral: string; patient: string; own: string };
  let declined: { referral: string; patient: string };

  // ---------- plumbing ----------

  const as = (name: string | null, roles: string[] = ["doctor"], clinicKey: "A" | "B" = "A") => {
    session.ctx =
      name === null
        ? null
        : { profileId: users[name], clinicId: clinic[clinicKey], clinicName: "Red team", clinicTimezone: TZ, roles, platformAdmin: false };
  };
  const req = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
    new NextRequest(`http://localhost${path}`, {
      method,
      headers: { ...headers, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    });
  const params = (id: string) => ({ params: Promise.resolve({ id }) });
  const read = async (res: Response): Promise<Res> => ({ status: res.status, body: (await res.json().catch(() => ({ ok: false }))) as Res["body"] });
  const call = async (h: Handler, method: string, path: string, id: string, body?: unknown, headers?: Record<string, string>) =>
    read(await h(req(method, path, body, headers), params(id)));
  const callList = async (h: ListHandler, method: string, path: string, body?: unknown, headers?: Record<string, string>) =>
    read(await h(req(method, path, body, headers)));

  const workspace = (id: string) => call(workspaceGet as Handler, "GET", `/api/doctor/patients/${id}`, id);
  const writeRecord = (patientId: string, body: Record<string, unknown>) =>
    call(recordPost as Handler, "POST", `/api/doctor/patients/${patientId}/records`, patientId, {
      idempotencyKey: randomUUID(),
      recordType: "consultation_note",
      summary: "Attack",
      ...body,
    });
  const startConsultation = (patientId: string, body: Record<string, unknown>) =>
    call(consultationPost as Handler, "POST", `/api/doctor/patients/${patientId}/consultations`, patientId, body);
  const referral = (id: string) => call(referralGet as Handler, "GET", `/api/doctor/referrals/${id}`, id);
  const actOn = (id: string, body: Record<string, unknown> | string) => call(referralAct as Handler, "PATCH", `/api/doctor/referrals/${id}`, id, body);

  /** No patient name, clinical record text or referral text in anything an attack returns. */
  function expectNoLeak(res: Res) {
    const text = JSON.stringify(res.body);
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain(`RT patient ${suffix}`);
  }
  const denied = (res: Res, statuses: number[]) => {
    expect(statuses, JSON.stringify(res.body)).toContain(res.status);
    expect(res.body.ok).toBe(false);
    expectNoLeak(res);
  };

  async function makeUser(name: string, clinicKey: "A" | "B", role: string | null) {
    emails[name] = `redteam-${name}-${suffix}@test.local`;
    const { data, error } = await admin.auth.admin.createUser({ email: emails[name], password: PASSWORD, email_confirm: true });
    expect(error).toBeNull();
    users[name] = data.user!.id;
    await admin.from("profiles").insert({ id: users[name], full_name: `RT ${name}` });
    if (role) await admin.from("staff_roles").insert({ clinic_id: clinic[clinicKey], profile_id: users[name], role });
  }
  async function makeDoctor(key: string, clinicKey: "A" | "B", profile: string, specialtyId: string | null = null) {
    const { data, error } = await admin
      .from("doctors")
      .insert({ clinic_id: clinic[clinicKey], profile_id: profile, name: `Dr ${key} ${suffix}`, specialty_id: specialtyId, active: true })
      .select("id")
      .single();
    expect(error).toBeNull();
    doctors[key] = data!.id;
    await admin.from("doctor_working_hours").insert(
      [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ clinic_id: clinic[clinicKey], doctor_id: data!.id, weekday, start_time: "00:00", end_time: "23:59" })),
    );
  }
  async function visit(clinicKey: "A" | "B", patientId: string, doctor: string, status = "completed") {
    const start = new Date(Date.UTC(2026, 0, 5, 5, 0) + slot++ * 86_400_000);
    const { data, error } = await admin
      .from("appointments")
      .insert({
        clinic_id: clinic[clinicKey],
        patient_id: patientId,
        doctor_id: doctor,
        service_id: service[clinicKey],
        start_at: start.toISOString(),
        end_at: new Date(start.getTime() + 30 * 60_000).toISOString(),
        status,
        source: "walk_in",
      })
      .select("id")
      .single();
    expect(error).toBeNull();
    return data!.id as string;
  }
  async function patientWithRecord(clinicKey: "A" | "B", doctorKey: string, profileKey: string) {
    const { data } = await admin
      .from("patients")
      .insert({ clinic_id: clinic[clinicKey], full_name: `RT patient ${suffix}`, phone: "+998900001122" })
      .select("id")
      .single();
    const id = data!.id as string;
    const consultation = await visit(clinicKey, id, doctors[doctorKey]);
    const { data: rec, error } = await admin
      .from("clinical_records")
      .insert({
        clinic_id: clinic[clinicKey],
        patient_id: id,
        author_doctor_id: doctors[doctorKey],
        appointment_id: consultation,
        record_type: "diagnosis",
        summary: `${SECRET} diagnosis`,
        created_by: users[profileKey],
      })
      .select("id")
      .single();
    expect(error).toBeNull();
    return { id, consultation, record: rec!.id as string };
  }
  async function insertReferral(clinicKey: "A" | "B", p: { id: string; consultation: string }, from: string, to: string, createdBy: string, ms = 30 * 86_400_000) {
    const { data, error } = await admin
      .from("referrals")
      .insert({
        clinic_id: clinic[clinicKey],
        patient_id: p.id,
        referring_doctor_id: doctors[from],
        referred_to_doctor_id: doctors[to],
        originating_appointment_id: p.consultation,
        reason: `${SECRET} reason`,
        handoff_note: `${SECRET} note`,
        created_by: users[createdBy],
        expires_at: new Date(Date.now() + ms).toISOString(),
      })
      .select("id")
      .single();
    expect(error).toBeNull();
    return data!.id as string;
  }
  /** A referral to a department nobody has taken yet (as POST /api/doctor/referrals creates it). */
  async function insertDepartmentReferral(p: { id: string; consultation: string }, from: string, specialtyId: string) {
    const { data, error } = await admin
      .from("referrals")
      .insert({
        clinic_id: clinic.A,
        patient_id: p.id,
        referring_doctor_id: doctors[from],
        referred_to_doctor_id: null,
        referred_to_specialty_id: specialtyId,
        originating_appointment_id: p.consultation,
        reason: `${SECRET} department reason`,
        handoff_note: `${SECRET} department note`,
        created_by: users[from],
      })
      .select("id")
      .single();
    expect(error).toBeNull();
    return data!.id as string;
  }
  const referralRow = async (id: string) =>
    (await admin.from("referrals").select("status, referred_to_doctor_id, accepted_by, follow_up_appointment_id").eq("id", id).single()).data;
  const UNTAKEN = { status: "pending", referred_to_doctor_id: null, accepted_by: null, follow_up_appointment_id: null };
  const sorted = (ids: string[]) => [...ids].sort();
  /** Refused as "not on this referral" — indistinguishable from a referral that does not exist. */
  const notOnIt = (res: Res) => {
    denied(res, [404]);
    expect(res.body.code).toBe("referral_not_found");
  };
  const transition = async (id: string, patch: Record<string, unknown>) => {
    const { error } = await admin.from("referrals").update(patch).eq("id", id);
    expect(error).toBeNull();
  };
  async function signedIn(name: string) {
    const client = createClient(URL, ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
    const { error } = await client.auth.signInWithPassword({ email: emails[name], password: PASSWORD });
    expect(error).toBeNull();
    return client;
  }

  beforeAll(async () => {
    admin = createClient(URL, SERVICE_KEY, { auth: { persistSession: false } });
    const { data: clinics } = await admin
      .from("clinics")
      .insert([
        { name: `RT Clinic A ${suffix}`, slug: `rt-a-${suffix}`, timezone: TZ },
        { name: `RT Clinic B ${suffix}`, slug: `rt-b-${suffix}`, timezone: TZ },
      ])
      .select("id, slug");
    clinic.A = clinics!.find((c) => c.slug.startsWith("rt-a"))!.id;
    clinic.B = clinics!.find((c) => c.slug.startsWith("rt-b"))!.id;
    const { data: services } = await admin
      .from("services")
      .insert([
        { clinic_id: clinic.A, name: `RT consult A ${suffix}`, duration_minutes: 5, price: 100000, active: true },
        { clinic_id: clinic.B, name: `RT consult B ${suffix}`, duration_minutes: 5, price: 100000, active: true },
      ])
      .select("id, clinic_id");
    service.A = services!.find((s) => s.clinic_id === clinic.A)!.id;
    service.B = services!.find((s) => s.clinic_id === clinic.B)!.id;

    const { data: specialties } = await admin
      .from("specialties")
      .insert([
        { clinic_id: clinic.A, name: `RT Kardiologiya ${suffix}` },
        { clinic_id: clinic.A, name: `RT Nevrologiya ${suffix}` },
        { clinic_id: clinic.B, name: `RT Kardiologiya ${suffix}` },
      ])
      .select("id, clinic_id, name");
    specialty.cardio = specialties!.find((s) => s.clinic_id === clinic.A && s.name.startsWith("RT Kardiologiya"))!.id;
    specialty.neuro = specialties!.find((s) => s.clinic_id === clinic.A && s.name.startsWith("RT Nevrologiya"))!.id;
    specialty.cardioB = specialties!.find((s) => s.clinic_id === clinic.B)!.id;

    for (const n of ["a", "b", "c", "card1", "card2", "neuro", "observer"]) await makeUser(n, "A", "doctor");
    await makeUser("kcard", "B", "doctor");
    await makeUser("receptionist", "A", "receptionist");
    await makeUser("manager", "A", "manager");
    await makeUser("k", "B", "doctor");
    await makeUser("k2", "B", "doctor");
    await makeUser("managerB", "B", "manager");
    for (const n of ["a", "b", "c"]) await makeDoctor(n, "A", users[n]);
    await makeDoctor("k", "B", users.k);
    await makeDoctor("k2", "B", users.k2);
    await makeDoctor("card1", "A", users.card1, specialty.cardio);
    await makeDoctor("card2", "A", users.card2, specialty.cardio);
    await makeDoctor("neuro", "A", users.neuro, specialty.neuro);
    await makeDoctor("observer", "A", users.observer);
    await makeDoctor("kcard", "B", users.kcard, specialty.cardioB);
    // A manager account linked to a doctor record — without the doctor role.
    await makeDoctor("managerDoc", "A", users.manager);

    X = await patientWithRecord("A", "a", "a");
    Y = await patientWithRecord("A", "c", "c");
    Z = await patientWithRecord("B", "k", "k");

    active = await insertReferral("A", X, "a", "b", "a");
    await transition(active, { status: "accepted", accepted_by: users.b });
    aToC = await insertReferral("A", await patientWithRecord("A", "a", "a"), "a", "c", "a");
    W = await patientWithRecord("A", "a", "a");
    const toW = await insertReferral("A", W, "a", "b", "a");
    await transition(toW, { status: "accepted", accepted_by: users.b });
    clinicBReferral = await insertReferral("B", Z, "k", "k2", "k");

    const x2 = await patientWithRecord("A", "a", "a");
    expired = { referral: await insertReferral("A", x2, "a", "b", "a", 2_000), patient: x2.id };
    await transition(expired.referral, { status: "accepted", accepted_by: users.b });

    const x3 = await patientWithRecord("A", "a", "a");
    revoked = { referral: await insertReferral("A", x3, "a", "b", "a"), patient: x3.id };
    await transition(revoked.referral, { status: "accepted", accepted_by: users.b });
    await transition(revoked.referral, { status: "revoked", revoked_by: users.a, revoked_reason: "Red team" });

    const x4 = await patientWithRecord("A", "a", "a");
    const c4 = await insertReferral("A", x4, "a", "b", "a", 3_000);
    await transition(c4, { status: "accepted", accepted_by: users.b });
    const own = await visit("A", x4.id, doctors.b, "in_progress");
    await transition(c4, { follow_up_appointment_id: own });
    await transition(c4, { status: "completed", completed_by: users.b });
    completed = { referral: c4, patient: x4.id, own, consultation: x4.consultation, record: x4.record };

    const x7 = await patientWithRecord("A", "a", "a");
    const c7 = await insertReferral("A", x7, "a", "b", "a", 3_000);
    await transition(c7, { status: "accepted", accepted_by: users.b });
    const own7 = await visit("A", x7.id, doctors.b, "in_progress");
    await transition(c7, { follow_up_appointment_id: own7 });
    await transition(c7, { status: "completed", completed_by: users.b });
    const { error: cancelError } = await admin.from("appointments").update({ status: "cancelled", cancelled_reason: "Entered in error" }).eq("id", own7);
    expect(cancelError).toBeNull();
    completedOnly = { referral: c7, patient: x7.id, own: own7 };

    const x5 = await patientWithRecord("A", "a", "a");
    declined = { referral: await insertReferral("A", x5, "a", "b", "a"), patient: x5.id };
    await transition(declined.referral, { status: "declined", declined_by: users.b });

    // Let the short-lived referrals lapse (expired: pending access gone; completed: past its validity).
    await new Promise((r) => setTimeout(r, 3_500));
  }, 90_000);

  afterAll(async () => {
    if (!admin) return;
    for (const c of [clinic.A, clinic.B]) {
      if (!c) continue;
      await admin.from("patients").delete().eq("clinic_id", c);
      await admin.from("staff_roles").delete().eq("clinic_id", c);
      await admin.from("doctors").delete().eq("clinic_id", c);
      await admin.from("services").delete().eq("clinic_id", c);
      await cleanupTestClinics([c]);
    }
    for (const id of Object.values(users)) await admin.auth.admin.deleteUser(id).catch(() => {});
  });

  // 1 ----------------------------------------------------------------------
  it("1. another patient's ID: an unrelated patient can't be read, written or consulted", async () => {
    const probes = async () =>
      (
        await admin
          .from("audit_events")
          .select("clinic_id, actor_type, entity_type, patient_id, referral_id, metadata")
          .eq("action", "unauthorized_clinical_access_attempt")
          .eq("entity_id", Y.id)
          .eq("actor_id", users.b)
      ).data ?? [];
    const before = (await probes()).length;
    as("b");
    denied(await workspace(Y.id), [404]);
    // Writing into the unrelated patient's chart — with Dr B's own consultation of X, or C's consultation of Y.
    const ownX = await visit("A", X.id, doctors.b, "in_progress");
    denied(await writeRecord(Y.id, { appointmentId: ownX }), [404]);
    denied(await writeRecord(Y.id, { appointmentId: Y.consultation }), [404]);
    denied(await startConsultation(Y.id, { serviceId: service.A }), [404]);
    denied(await startConsultation(Y.id, { appointmentId: Y.consultation }), [404]);
    // Referring a patient from someone else's consultation.
    denied(
      await callList(referralCreate as ListHandler, "POST", "/api/doctor/referrals", {
        idempotencyKey: randomUUID(),
        appointmentId: Y.consultation,
        referredToDoctorId: doctors.a,
        reason: "Attack",
        priority: "routine",
      }),
      [404],
    );
    // Every refusal to open the patient is logged (the workspace, both writes, both consultation starts) —
    // the probed id stays the entity and never becomes a patient reference: nothing proves it is Dr B's business.
    const log = await probes();
    expect(log).toHaveLength(before + 5);
    for (const row of log) {
      expect(row).toEqual({
        clinic_id: clinic.A,
        actor_type: "staff",
        entity_type: "patients",
        patient_id: null,
        referral_id: null,
        metadata: { doctor_id: doctors.b, referral_status: null },
      });
    }
  });

  // 2 ----------------------------------------------------------------------
  it("2. another doctor's ID: their consultations, records and referrals stay theirs", async () => {
    as("b");
    // Write into Dr A's consultation of a patient Dr B *may* see.
    denied(await writeRecord(X.id, { appointmentId: X.consultation }), [404]);
    // Correct Dr A's record.
    const own = await visit("A", X.id, doctors.b, "in_progress");
    denied(await writeRecord(X.id, { appointmentId: own, recordType: "diagnosis", correctsRecordId: X.record }), [403]);
    // Start Dr A's appointment as Dr B's consultation (a patient Dr B may consult, no consultation yet).
    denied(await startConsultation(W.id, { appointmentId: W.consultation }), [404]);
    const { data: aVisit } = await admin.from("appointments").select("status, doctor_id").eq("id", W.consultation).single();
    expect(aVisit).toEqual({ status: "completed", doctor_id: doctors.a });
    // A referral Dr B is not on: A → C.
    denied(await referral(aToC), [404]);
    denied(await actOn(aToC, { action: "accept" }), [404]);
    // Another doctor's appointment through the queue route: indistinguishable from a missing one.
    denied(await call(doctorAppointmentPatch as Handler, "PATCH", `/api/doctor/appointments/${Y.consultation}`, Y.consultation, { status: "in_progress" }), [404]);
    const { data: untouched } = await admin.from("appointments").select("status").eq("id", Y.consultation).single();
    expect(untouched!.status).toBe("completed");
  });

  // 3 ----------------------------------------------------------------------
  it("3. another clinic's ID: patients, referrals, doctors and services of clinic B are unreachable from clinic A", async () => {
    as("b");
    denied(await workspace(Z.id), [404]);
    denied(await referral(clinicBReferral), [404]);
    denied(await actOn(clinicBReferral, { action: "accept" }), [404]);
    denied(await writeRecord(Z.id, { appointmentId: Z.consultation }), [404]);
    denied(await startConsultation(Z.id, { serviceId: service.B }), [404]);
    // Clinic B's service or doctor inside clinic A's flows.
    denied(await startConsultation(W.id, { serviceId: service.B }), [400, 404, 409, 422]);
    const { data: wVisits } = await admin.from("appointments").select("id").eq("patient_id", W.id).eq("doctor_id", doctors.b);
    expect(wVisits).toEqual([]);
    denied(
      await callList(referralCreate as ListHandler, "POST", "/api/doctor/referrals", {
        idempotencyKey: randomUUID(),
        appointmentId: await visit("A", X.id, doctors.b, "completed"),
        referredToDoctorId: doctors.k,
        reason: "Attack",
        priority: "routine",
      }),
      [404],
    );
    // Clinic B's staff against clinic A.
    as("k", ["doctor"], "B");
    denied(await workspace(X.id), [404]);
    denied(await referral(active), [404]);
    as("managerB", ["manager"], "B");
    denied(await call(adminRevoke as Handler, "PATCH", `/api/admin/referrals/${active}`, active, { action: "revoke", reason: "Cross-clinic" }), [404]);
    // Another clinic's patient id reads exactly like one that doesn't exist.
    const res = await callList(adminPatientsGet as ListHandler, "GET", `/api/admin/patients?id=${X.id}`);
    expect(res.body.data).toEqual({ patient: null, appointments: [], conversations: [], referrals: [] });
    expectNoLeak(res);
    const { data } = await admin.from("referrals").select("status").eq("id", active).single();
    expect(data!.status).toBe("accepted");
  });

  // 4 ----------------------------------------------------------------------
  it("4. expired referral IDs: nothing — no data, no transitions — even before the expiry is recorded", async () => {
    as("b");
    denied(await workspace(expired.patient), [410]);
    denied(await writeRecord(expired.patient, { appointmentId: randomUUID() }), [410]);
    denied(await startConsultation(expired.patient, { serviceId: service.A }), [410]);
    denied(await actOn(expired.referral, { action: "complete" }), [409, 410]);
    denied(await referral(expired.referral), [410]);
  });

  // 5 ----------------------------------------------------------------------
  it("5. revoked referral IDs: nothing, and the referral can't be revived", async () => {
    as("b");
    denied(await workspace(revoked.patient), [410]);
    denied(await referral(revoked.referral), [410]);
    // Dr B has lost it: every action answers "revoked" (410) — nothing is written.
    for (const action of ["accept", "decline", "complete"]) denied(await actOn(revoked.referral, { action }), [410]);
    denied(await startConsultation(revoked.patient, { serviceId: service.A }), [410]);
  });

  // 6 ----------------------------------------------------------------------
  it("6. completed referral IDs: no referral-based access is left — only Dr B's own visit keeps the history; past validity the referral itself is closed", async () => {
    as("b");
    // Dr B's consultation for the referral is a treating relationship of its own (continuity of care): the
    // patient's whole history stays — Dr A's visit and record included — though no referral gives anything.
    const ws = await workspace(completed.patient);
    expect(ws.status).toBe(200);
    const rec = ws.body.data!.record as {
      relationship: string;
      activeReferralIds: string[];
      referralAccessUntil: string | null;
      appointments: Array<{ id: string }>;
      records: Array<{ id: string; author: { id: string }; mine: boolean }>;
      referrals: Array<{ id: string; role: string; status: string; allowedActions: string[] }>;
    };
    expect(rec).toMatchObject({ relationship: "own", activeReferralIds: [], referralAccessUntil: null });
    expect(sorted(rec.appointments.map((a) => a.id))).toEqual(sorted([completed.consultation, completed.own]));
    expect(rec.records.map((r) => [r.id, r.author.id, r.mine])).toEqual([[completed.record, doctors.a, false]]);
    expect(rec.referrals).toEqual([expect.objectContaining({ id: completed.referral, role: "receiver", status: "completed", allowedActions: [] })]);
    // Past its validity the referral answers Dr B with its status only — no text, no transition, never a silent no-op.
    const detail = await referral(completed.referral);
    denied(detail, [410]);
    expect(detail.body.code).toBe("referral_completed");
    for (const action of ["accept", "complete", "decline"]) {
      const res = await actOn(completed.referral, { action });
      denied(res, [410]);
      expect(res.body.code).toBe("referral_completed");
    }
    denied(await actOn(completed.referral, { action: "revoke", reason: "Receiver tries" }), [403]);
    as("b");
    const incoming = await callList(referralList as ListHandler, "GET", "/api/doctor/referrals?box=incoming");
    expect((incoming.body.data!.referrals as Array<{ id: string }>).map((r) => r.id)).not.toContain(completed.referral);

    // A completed referral that was Dr B's only link (their consultation since cancelled, nothing written):
    // nothing of the patient at all — no history, no writes, no new consultation.
    for (const res of [
      await workspace(completedOnly.patient),
      await referral(completedOnly.referral),
      await writeRecord(completedOnly.patient, { appointmentId: completedOnly.own }),
      await startConsultation(completedOnly.patient, { serviceId: service.A }),
    ]) {
      denied(res, [410]);
      expect(res.body.code).toBe("referral_completed");
    }
    for (const id of [completed.referral, completedOnly.referral]) expect((await referralRow(id))!.status).toBe("completed");
    const { data: written } = await admin.from("clinical_records").select("id").eq("patient_id", completedOnly.patient).eq("author_doctor_id", doctors.b);
    expect(written).toEqual([]);
  });

  // 7 ----------------------------------------------------------------------
  it("7. manipulated API requests: unknown actions, forged fields, oversize or malformed bodies are refused or ignored", async () => {
    as("b");
    denied(await actOn(active, { action: "approve" }), [400]);
    denied(await actOn(active, { action: "revoke", reason: "Receiver tries" }), [403]);
    denied(await actOn(active, "{not json"), [400]);
    // Forged lifecycle fields on the receiver's own referral are ignored — only the transition is applied.
    const forged = await actOn(declined.referral, { action: "accept", status: "accepted", accepted_by: users.b });
    denied(forged, [410]);
    const { data: stillDeclined } = await admin.from("referrals").select("status").eq("id", declined.referral).single();
    expect(stillDeclined!.status).toBe("declined");
    // Forged record fields: the author, patient and time are the server's.
    const own = await visit("A", X.id, doctors.b, "in_progress");
    const res = await writeRecord(X.id, {
      appointmentId: own,
      authorDoctorId: doctors.a,
      author_doctor_id: doctors.a,
      createdBy: users.a,
      created_at: "2000-01-01T00:00:00Z",
      clinicId: clinic.B,
      patientId: Y.id,
    });
    expect(res.status).toBe(201);
    const { data: stored } = await admin
      .from("clinical_records")
      .select("author_doctor_id, created_by, clinic_id, patient_id, created_at")
      .eq("id", (res.body.data!.record as { id: string }).id)
      .single();
    expect(stored).toMatchObject({ author_doctor_id: doctors.b, created_by: users.b, clinic_id: clinic.A, patient_id: X.id });
    expect(Date.parse(stored!.created_at)).toBeGreaterThan(Date.now() - 60_000);
    // Out-of-range values.
    denied(await writeRecord(X.id, { appointmentId: own, recordType: "ai_summary" }), [400]);
    denied(await writeRecord(X.id, { appointmentId: own, summary: "x".repeat(301) }), [400]);
    denied(
      await callList(referralCreate as ListHandler, "POST", "/api/doctor/referrals", {
        idempotencyKey: randomUUID(),
        appointmentId: own,
        referredToDoctorId: doctors.c,
        reason: "Too long a validity",
        priority: "routine",
        validForDays: 365,
      }),
      [400],
    );
  });

  // 8 ----------------------------------------------------------------------
  it("8. direct server actions: none exist — every mutation is a guarded route handler", () => {
    const found: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(ts|tsx)$/.test(name) && !name.endsWith(".test.ts")) {
          if (/^\s*["']use server["']/m.test(readFileSync(p, "utf8"))) found.push(p);
        }
      }
    };
    walk(join(process.cwd(), "src"));
    expect(found).toEqual([]);
  });

  // 9 ----------------------------------------------------------------------
  it("9. direct database queries with each role's own token are refused or empty", async () => {
    const [b, c, receptionist, manager, k] = await Promise.all(["b", "c", "receptionist", "manager", "k"].map(signedIn));

    // Clinical text: no direct reads, for anyone.
    for (const client of [b, c, receptionist, manager, k]) {
      expect((await client.from("clinical_records").select("id").eq("patient_id", X.id)).error?.code).toBe("42501");
      expect((await client.from("referrals").select("id")).error?.code).toBe("42501");
    }
    // No direct writes of clinical text or referrals.
    expect((await b.from("clinical_records").insert({ clinic_id: clinic.A, patient_id: X.id, author_doctor_id: doctors.b, appointment_id: X.consultation, record_type: "diagnosis", summary: "x", created_by: users.b })).error?.code).toBe("42501");
    expect((await b.from("referrals").update({ status: "completed" }).eq("id", active)).error?.code).toBe("42501");
    expect((await c.from("referrals").insert({ clinic_id: clinic.A, patient_id: X.id })).error?.code).toBe("42501");
    // Privileged RPCs are server-only.
    for (const [fn, args] of [
      ["doctor_patient_access", { p_doctor_id: doctors.b, p_patient_id: X.id }],
      ["expire_due_referrals", {}],
      ["book_appointment", { p_clinic_id: clinic.A, p_patient_id: Y.id, p_doctor_id: doctors.c, p_service_id: service.A, p_start_at: new Date().toISOString() }],
    ] as const) {
      const { error } = await c.rpc(fn, args as never);
      expect(error, fn).not.toBeNull();
    }
    // RLS: an unrelated doctor, another clinic's doctor and reception see no clinical visit history.
    expect((await c.from("patients").select("id").eq("id", X.id)).data).toEqual([]);
    expect((await c.from("appointments").select("id").eq("patient_id", X.id)).data).toEqual([]);
    expect((await k.from("patients").select("id").eq("id", X.id)).data).toEqual([]);
    expect((await k.from("appointments").select("id").eq("patient_id", X.id)).data).toEqual([]);
    // Dr B, whom X is referred to, reads X's whole visit history — every doctor's, Dr A's included — and still
    // nothing of Y, a patient of the same clinic Dr B has no relationship with.
    const { data: allOfX } = await admin.from("appointments").select("id").eq("patient_id", X.id);
    expect(sorted(((await b.from("appointments").select("id").eq("patient_id", X.id)).data ?? []).map((a) => a.id))).toEqual(sorted((allOfX ?? []).map((a) => a.id)));
    expect((await b.from("patients").select("id").eq("id", X.id)).data).toEqual([{ id: X.id }]);
    expect((await b.from("patients").select("id").eq("id", Y.id)).data).toEqual([]);
    expect((await b.from("appointments").select("id").eq("patient_id", Y.id)).data).toEqual([]);
    // Payments: a doctor's own token reads none — not even the payment of their own visit (the server shows only its status).
    const bVisit = await visit("A", X.id, doctors.b, "completed");
    const { error: paymentError } = await admin.from("payments").insert({ clinic_id: clinic.A, appointment_id: bVisit, patient_id: X.id, amount: 100000 });
    expect(paymentError).toBeNull();
    expect((await b.from("payments").select("id").eq("appointment_id", bVisit)).data ?? []).toEqual([]);
    expect(((await receptionist.from("payments").select("appointment_id").eq("appointment_id", bVisit)).data ?? []).map((r) => r.appointment_id)).toEqual([bVisit]);
    // The audit log: doctors and reception read none of it; clinic B's staff none of clinic A's.
    for (const client of [b, c, receptionist, k]) {
      expect((await client.from("audit_events").select("id").eq("clinic_id", clinic.A)).data ?? []).toEqual([]);
    }
    // Nobody rewrites history: records can't be moved to another doctor or patient through the appointment they belong to.
    const moveDoctor = await receptionist.from("appointments").update({ doctor_id: doctors.c }).eq("id", X.consultation).select();
    expect(moveDoctor.error).not.toBeNull();
    const movePatient = await receptionist.from("appointments").update({ patient_id: Y.id }).eq("id", X.consultation).select();
    expect(movePatient.error).not.toBeNull();
    // …nor an appointment moved into another clinic.
    const moveClinic = await receptionist.from("appointments").update({ clinic_id: clinic.B }).eq("id", Y.consultation).select();
    expect(moveClinic.error ?? (moveClinic.data ?? []).length === 0).toBeTruthy();
    const { data: still } = await admin.from("appointments").select("doctor_id, patient_id, clinic_id").eq("id", X.consultation).single();
    expect(still).toEqual({ doctor_id: doctors.a, patient_id: X.id, clinic_id: clinic.A });
    // A doctor has no direct appointment writes at all.
    expect(((await b.from("appointments").update({ status: "cancelled" }).eq("id", X.consultation).select()).data ?? []).length).toBe(0);
    await Promise.all([b, c, receptionist, manager, k].map((cl) => cl.auth.signOut()));
  });

  // 10 ---------------------------------------------------------------------
  it("10. modified URL parameters: malformed ids, forged query parameters and filter syntax change nothing", async () => {
    as("b");
    for (const id of ["not-a-uuid", "' or 1=1 --", "../../admin", `${X.id},${Y.id}`]) {
      denied(await workspace(id), [404]);
      denied(await referral(id), [404]);
    }
    // Forged query parameters on the list endpoints.
    const list = await callList(referralList as ListHandler, "GET", `/api/doctor/referrals?box=incoming&doctorId=${doctors.a}&clinicId=${clinic.B}`);
    expect(list.status).toBe(200);
    expect((list.body.data!.referrals as Array<{ id: string }>).map((r) => r.id)).not.toContain(aToC);
    // An unknown box falls back to the caller's own incoming referrals — never "all".
    const all = await callList(referralList as ListHandler, "GET", "/api/doctor/referrals?box=all");
    const allIds = (all.body.data!.referrals as Array<{ id: string; referredToDoctor: { id: string } }>);
    expect(allIds.every((r) => r.referredToDoctor.id === doctors.b)).toBe(true);
    expect(allIds.map((r) => r.id)).not.toContain(aToC);
    expect(allIds.map((r) => r.id)).not.toContain(clinicBReferral);
    const patients = await callList(patientList as ListHandler, "GET", `/api/doctor/patients?q=${encodeURIComponent("id.neq.0,full_name.ilike.*")}&doctorId=${doctors.c}`);
    expect(patients.status).toBe(200);
    expect((patients.body.data!.patients as Array<{ id: string }>).map((p) => p.id)).not.toContain(Y.id);
    // Reception's patient search: PostgREST filter syntax in `q` is text, never a filter.
    as("receptionist", ["receptionist"]);
    for (const q of ["x,id.neq.00000000-0000-0000-0000-000000000000", "a)", "full_name.ilike.*RT*", 'x"),id.neq.0', "or(id.not.is.null)"]) {
      const res = await callList(adminPatientsGet as ListHandler, "GET", `/api/admin/patients?q=${encodeURIComponent(q)}`);
      expect(res.status, q).toBe(200);
      expect((res.body.data!.patients as unknown[]).length, q).toBe(0);
    }
    // …while a real search still works — by name, and by phone digits.
    const byName = await callList(adminPatientsGet as ListHandler, "GET", `/api/admin/patients?q=${encodeURIComponent(`RT patient ${suffix}`)}`);
    expect((byName.body.data!.patients as Array<{ id: string }>).map((p) => p.id)).toContain(X.id);
    const byPhone = await callList(adminPatientsGet as ListHandler, "GET", "/api/admin/patients?q=900001122");
    expect((byPhone.body.data!.patients as Array<{ id: string }>).map((p) => p.id)).toContain(X.id);
  });

  // 11 ---------------------------------------------------------------------
  it("11. client-side state manipulation: what the page believes is never what the server trusts", async () => {
    // Whatever the page believes about a pending referral, the server decides: a doctor with no relationship
    // can't start a consultation with the patient at all…
    const pendingPatient = await patientWithRecord("A", "a", "a");
    const pendingReferral = await insertReferral("A", pendingPatient, "a", "b", "a");
    as("c");
    denied(await startConsultation(pendingPatient.id, { serviceId: service.A }), [404]);
    expect(await referralRow(pendingReferral)).toMatchObject({ status: "pending", accepted_by: null, follow_up_appointment_id: null });
    // …while the receiving doctor's start takes the referral on — accepted by the session's doctor and linked to
    // the new consultation, whatever doctor, referral or status the body names (those fields are not accepted).
    as("b");
    const started = await startConsultation(pendingPatient.id, { serviceId: service.A, doctorId: doctors.c, referralId: aToC, status: "completed" });
    expect(started.status, JSON.stringify(started.body)).toBe(201);
    const walkIn = (started.body.data!.consultation as { appointmentId: string }).appointmentId;
    expect((await admin.from("appointments").select("doctor_id, patient_id, status").eq("id", walkIn).single()).data).toEqual({
      doctor_id: doctors.b,
      patient_id: pendingPatient.id,
      status: "in_progress",
    });
    expect(await referralRow(pendingReferral)).toEqual({ status: "in_progress", referred_to_doctor_id: doctors.b, accepted_by: users.b, follow_up_appointment_id: walkIn });
    expect(await referralRow(aToC)).toMatchObject({ status: "pending", follow_up_appointment_id: null });
    // Replaying another doctor's idempotency key can't return their record.
    const key = randomUUID();
    as("a");
    const aOwn = await visit("A", X.id, doctors.a, "in_progress");
    const aRes = await call(recordPost as Handler, "POST", `/api/doctor/patients/${X.id}/records`, X.id, { idempotencyKey: key, appointmentId: aOwn, recordType: "consultation_note", summary: `${SECRET} A's note` });
    expect(aRes.status).toBe(201);
    as("b");
    const bOwn = await visit("A", X.id, doctors.b, "in_progress");
    const bRes = await call(recordPost as Handler, "POST", `/api/doctor/patients/${X.id}/records`, X.id, { idempotencyKey: key, appointmentId: bOwn, recordType: "consultation_note", summary: "B's note" });
    expect(bRes.status).toBe(201);
    expect((bRes.body.data!.record as { id: string }).id).not.toBe((aRes.body.data!.record as { id: string }).id);
    expectNoLeak(bRes);
  });

  // 12 ---------------------------------------------------------------------
  it("12. hidden UI routes: doctor/admin pages render no data server-side — the data only comes from guarded APIs", () => {
    const pages: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (name === "page.tsx" || name === "layout.tsx") pages.push(p);
      }
    };
    walk(join(process.cwd(), "src/app/doctor"));
    walk(join(process.cwd(), "src/app/admin"));
    for (const p of pages) {
      const src = readFileSync(p, "utf8");
      expect(src, p).not.toMatch(/createAdminClient|service_role|SUPABASE_SERVICE_ROLE_KEY|from\("clinical_records"\)|from\("referrals"\)/);
    }
  });

  // 13 ---------------------------------------------------------------------
  it("13. changing clinic_id in requests: body, query and headers can't move a session into another clinic", async () => {
    as("b");
    const res = await call(workspaceGet as Handler, "GET", `/api/doctor/patients/${Z.id}?clinicId=${clinic.B}&clinic_id=${clinic.B}`, Z.id, undefined, {
      "x-clinic-id": clinic.B,
      "x-clinic-slug": `rt-b-${suffix}`,
    });
    denied(res, [404]);
    const create = await callList(referralCreate as ListHandler, "POST", "/api/doctor/referrals", {
      idempotencyKey: randomUUID(),
      appointmentId: Z.consultation,
      referredToDoctorId: doctors.k2,
      reason: "Cross-clinic attack",
      priority: "routine",
      clinicId: clinic.B,
      clinic_id: clinic.B,
    });
    denied(create, [404]);
    as("receptionist", ["receptionist"]);
    denied(
      await callList(adminBook as ListHandler, "POST", "/api/admin/appointments", {
        patientId: Z.id,
        doctorId: doctors.k,
        serviceId: service.B,
        startAt: new Date(Date.now() + 5 * 86_400_000).toISOString(),
        source: "admin",
        clinicId: clinic.B,
      }),
      [400, 404, 409, 422],
    );
  });

  // 14 ---------------------------------------------------------------------
  it("14. changing patient_id in requests: the patient comes from the URL and the consultation, never the body", async () => {
    as("b");
    const own = await visit("A", X.id, doctors.b, "in_progress");
    // URL says Y, the consultation is X's: refused.
    denied(await writeRecord(Y.id, { appointmentId: own, patientId: X.id }), [404]);
    // A referral carries the consultation's patient, whatever the body says.
    const res = await callList(referralCreate as ListHandler, "POST", "/api/doctor/referrals", {
      idempotencyKey: randomUUID(),
      appointmentId: own,
      referredToDoctorId: doctors.a,
      reason: "Patient swap",
      priority: "routine",
      patientId: Y.id,
      patient_id: Y.id,
    });
    expect(res.status).toBe(201);
    const { data } = await admin.from("referrals").select("patient_id").eq("id", (res.body.data!.referral as { id: string }).id).single();
    expect(data!.patient_id).toBe(X.id);
  });

  // 15 ---------------------------------------------------------------------
  it("15. changing doctor_id in requests: the acting doctor is always the session's", async () => {
    as("c");
    const own = await visit("A", Y.id, doctors.c, "completed");
    const res = await callList(referralCreate as ListHandler, "POST", "/api/doctor/referrals", {
      idempotencyKey: randomUUID(),
      appointmentId: own,
      referredToDoctorId: doctors.a,
      reason: "Impersonation",
      priority: "routine",
      referringDoctorId: doctors.a,
      referring_doctor_id: doctors.a,
      createdBy: users.a,
    });
    expect(res.status).toBe(201);
    const { data } = await admin.from("referrals").select("referring_doctor_id, created_by").eq("id", (res.body.data!.referral as { id: string }).id).single();
    expect(data).toEqual({ referring_doctor_id: doctors.c, created_by: users.c });
    // Dr C "as" Dr B via a doctorId parameter still gets Dr C's (empty) view of X.
    const ws = await call(workspaceGet as Handler, "GET", `/api/doctor/patients/${X.id}?doctorId=${doctors.b}`, X.id);
    denied(ws, [404]);
  });

  // 16 ---------------------------------------------------------------------
  it("16. no authentication: every doctor, admin and job endpoint refuses", async () => {
    as(null);
    denied(await workspace(X.id), [401]);
    denied(await writeRecord(X.id, { appointmentId: X.consultation }), [401]);
    denied(await startConsultation(X.id, { serviceId: service.A }), [401]);
    denied(await referral(active), [401]);
    denied(await actOn(active, { action: "complete" }), [401]);
    denied(await callList(referralList as ListHandler, "GET", "/api/doctor/referrals?box=incoming"), [401]);
    denied(await callList(recipientsGet as ListHandler, "GET", "/api/doctor/referrals/recipients"), [401]);
    denied(await callList(patientList as ListHandler, "GET", "/api/doctor/patients"), [401]);
    denied(await call(doctorAppointmentPatch as Handler, "PATCH", `/api/doctor/appointments/${X.consultation}`, X.consultation, { status: "in_progress" }), [401]);
    denied(await callList(adminPatientsGet as ListHandler, "GET", `/api/admin/patients?id=${X.id}`), [401]);
    denied(await call(adminRevoke as Handler, "PATCH", `/api/admin/referrals/${active}`, active, { action: "revoke", reason: "Anonymous" }), [401]);
    const job = await expireJob(req("POST", "/api/referrals/expire"));
    expect(job.status).toBe(401);
    const forgedJob = await expireJob(req("POST", "/api/referrals/expire", undefined, { authorization: `Bearer ${env.CRON_SECRET}-forged` }));
    expect(forgedJob.status).toBe(401);
  });

  // 17 ---------------------------------------------------------------------
  it("17. as receptionist: no doctor endpoint, no revocation, no clinical text through the patient panel", async () => {
    as("receptionist", ["receptionist"]);
    denied(await workspace(X.id), [403]);
    denied(await referral(active), [403]);
    denied(await actOn(active, { action: "complete" }), [403]);
    denied(await callList(patientList as ListHandler, "GET", "/api/doctor/patients"), [403]);
    denied(await writeRecord(X.id, { appointmentId: X.consultation }), [403]);
    denied(await call(adminRevoke as Handler, "PATCH", `/api/admin/referrals/${active}`, active, { action: "revoke", reason: "Front desk" }), [403]);
    denied(await call(doctorAppointmentPatch as Handler, "PATCH", `/api/doctor/appointments/${X.consultation}`, X.consultation, { status: "in_progress" }), [403]);
    const panel = await callList(adminPatientsGet as ListHandler, "GET", `/api/admin/patients?id=${X.id}`);
    expect(panel.status).toBe(200); // operational data is theirs…
    expect(JSON.stringify(panel.body)).not.toContain(SECRET); // …clinical text never is.
  });

  // 18 ---------------------------------------------------------------------
  it("18. as manager (even linked to a doctor record): management actions only — no doctor endpoint, no clinical text", async () => {
    as("manager", ["manager"]);
    denied(await workspace(X.id), [403]);
    denied(await referral(active), [403]);
    denied(await actOn(active, { action: "complete" }), [403]);
    denied(await callList(referralList as ListHandler, "GET", "/api/doctor/referrals?box=incoming"), [403]);
    denied(await writeRecord(X.id, { appointmentId: X.consultation }), [403]);
    // The queue and time-block routes demand the doctor role itself, not the manager's rank.
    const mgrAppt = await visit("A", Y.id, doctors.managerDoc, "checked_in");
    denied(await call(doctorAppointmentPatch as Handler, "PATCH", `/api/doctor/appointments/${mgrAppt}`, mgrAppt, { status: "in_progress" }), [403]);
    denied(
      await callList(timeBlockPost as ListHandler, "POST", "/api/doctor/appointments", {
        startsAt: new Date(Date.now() + 86_400_000).toISOString(),
        endsAt: new Date(Date.now() + 90_000_000).toISOString(),
        reason: "break",
      }),
      [403],
    );
    const { data: blocks } = await admin.from("doctor_time_blocks").select("id").eq("doctor_id", doctors.managerDoc);
    expect(blocks ?? []).toEqual([]);
    const panel = await callList(adminPatientsGet as ListHandler, "GET", `/api/admin/patients?id=${X.id}`);
    expect(JSON.stringify(panel.body)).not.toContain(SECRET);
    const { data } = await admin.from("appointments").select("status").eq("id", mgrAppt).single();
    expect(data!.status).toBe("checked_in");
  });

  // 19 ---------------------------------------------------------------------
  it("19. as another doctor: an unrelated colleague and a doctor of another clinic get nothing", async () => {
    as("c");
    denied(await workspace(X.id), [404]);
    denied(await referral(active), [404]);
    denied(await actOn(active, { action: "complete" }), [404]);
    denied(await actOn(active, { action: "revoke", reason: "Not mine" }), [404]);
    const list = await callList(referralList as ListHandler, "GET", "/api/doctor/referrals?box=incoming");
    expect((list.body.data!.referrals as Array<{ id: string }>).map((r) => r.id)).not.toContain(active);
    as("k", ["doctor"], "B");
    denied(await workspace(X.id), [404]);
    denied(await actOn(active, { action: "complete" }), [404]);
  });

  // 20 ---------------------------------------------------------------------
  it("20. unrelated patients never appear in a doctor's lists — and every probe is logged", async () => {
    as("b");
    const mine = await callList(patientList as ListHandler, "GET", "/api/doctor/patients");
    const ids = (mine.body.data!.patients as Array<{ id: string }>).map((p) => p.id);
    expect(ids).toContain(X.id);
    for (const other of [Y.id, Z.id, expired.patient, revoked.patient, declined.patient]) expect(ids).not.toContain(other);
    const probe = randomUUID();
    denied(await workspace(probe), [404]);
    const { data } = await admin
      .from("audit_events")
      .select("actor_id, patient_id, referral_id, clinic_id, entity_type, metadata")
      .eq("action", "unauthorized_clinical_access_attempt")
      .eq("entity_id", probe);
    expect(data).toEqual([
      { actor_id: users.b, patient_id: null, referral_id: null, clinic_id: clinic.A, entity_type: "patients", metadata: { doctor_id: doctors.b, referral_status: null } },
    ]);
  });

  it("2b. referral laundering: an onward referral hands on the history, never authorship — the onward receiver changes nobody's records, can't act on the original referral, and loses everything when the onward referral ends", async () => {
    const p = await patientWithRecord("A", "a", "a");
    const toB = await insertReferral("A", p, "a", "b", "a");
    await transition(toB, { status: "accepted", accepted_by: users.b });
    as("b");
    const own = await visit("A", p.id, doctors.b, "in_progress");
    const bNote = await writeRecord(p.id, { appointmentId: own, summary: `${SECRET} B's assessment` });
    expect(bNote.status).toBe(201);
    const bRecord = (bNote.body.data!.record as { id: string }).id;
    const onwardRes = await callList(referralCreate as ListHandler, "POST", "/api/doctor/referrals", {
      idempotencyKey: randomUUID(),
      appointmentId: own,
      referredToDoctorId: doctors.c,
      reason: "Onward",
      priority: "routine",
    });
    expect(onwardRes.status).toBe(201);
    const onward = (onwardRes.body.data!.referral as { id: string }).id;
    as("c");
    expect((await actOn(onward, { action: "accept" })).status).toBe(200);

    // The onward referral is a handoff like any other: Dr C sees the whole history — Dr A's and Dr B's records —
    // and neither is Dr C's.
    const ws = await workspace(p.id);
    expect(ws.status).toBe(200);
    const rec = ws.body.data!.record as { relationship: string; activeReferralIds: string[]; records: Array<{ id: string; mine: boolean }> };
    expect(rec).toMatchObject({ relationship: "referred", activeReferralIds: [onward] });
    expect(sorted(rec.records.map((r) => r.id))).toEqual(sorted([p.record, bRecord]));
    expect(rec.records.every((r) => !r.mine)).toBe(true);

    // Reading is not writing: no correction of either author's record, no note in either doctor's consultation.
    for (const target of [p.record, bRecord]) {
      const res = await writeRecord(p.id, { appointmentId: own, recordType: "diagnosis", correctsRecordId: target, summary: "Laundered" });
      denied(res, [403]);
      expect(res.body.code).toBe("CLINICAL_RECORD_NOT_OWNED");
    }
    for (const appointmentId of [own, p.consultation]) denied(await writeRecord(p.id, { appointmentId, summary: "Laundered" }), [404]);
    const { data: attempts } = await admin
      .from("audit_events")
      .select("entity_type, entity_id, patient_id, metadata")
      .eq("action", "unauthorized_clinical_mutation_attempt")
      .eq("actor_id", users.c)
      .eq("patient_id", p.id)
      .order("created_at");
    expect(attempts).toEqual([
      { entity_type: "clinical_records", entity_id: p.record, patient_id: p.id, metadata: { reason: "not_owned", attempted: "correct", doctor_id: doctors.c } },
      { entity_type: "clinical_records", entity_id: bRecord, patient_id: p.id, metadata: { reason: "not_owned", attempted: "correct", doctor_id: doctors.c } },
      { entity_type: "appointments", entity_id: own, patient_id: p.id, metadata: { reason: "not_own_consultation", attempted: "write", doctor_id: doctors.c } },
      { entity_type: "appointments", entity_id: p.consultation, patient_id: p.id, metadata: { reason: "not_own_consultation", attempted: "write", doctor_id: doctors.c } },
    ]);
    const { data: records } = await admin.from("clinical_records").select("id, author_doctor_id").eq("patient_id", p.id);
    expect(sorted((records ?? []).map((r) => `${r.id}:${r.author_doctor_id}`))).toEqual(sorted([`${p.record}:${doctors.a}`, `${bRecord}:${doctors.b}`]));

    // The original referral is Dr A's and Dr B's: Dr C can neither open nor move it.
    notOnIt(await referral(toB));
    for (const body of [{ action: "accept" }, { action: "decline" }, { action: "complete" }, { action: "revoke", reason: "Laundered" }]) notOnIt(await actOn(toB, body));
    expect(await referralRow(toB)).toMatchObject({ status: "accepted", referred_to_doctor_id: doctors.b, follow_up_appointment_id: null });

    // The onward referral was Dr C's only link: revoked by Dr B, it takes everything with it at once.
    as("b");
    expect((await actOn(onward, { action: "revoke", reason: "Seen elsewhere" })).status).toBe(200);
    as("c");
    const after = await workspace(p.id);
    denied(after, [410]);
    expect(after.body.code).toBe("referral_revoked");
  });

  // Department referrals -----------------------------------------------------
  const incomingIds = async () =>
    ((await callList(referralList as ListHandler, "GET", "/api/doctor/referrals?box=incoming")).body.data!.referrals as Array<{ id: string }>).map((r) => r.id);
  const pendingCount = async () => (await read(await pendingCountGet())).body.data;

  it("21. another department's doctor: a department referral is neither seen nor taken — and opens nothing", async () => {
    const p = await patientWithRecord("A", "a", "a");
    const dept = await insertDepartmentReferral(p, "a", specialty.cardio);
    as("neuro");
    // Not in the list or the badge — not even when the query names the department or one of its doctors.
    const forged = await callList(referralList as ListHandler, "GET", `/api/doctor/referrals?box=incoming&specialtyId=${specialty.cardio}&doctorId=${doctors.card1}`);
    expect(forged.status).toBe(200);
    expect(forged.body.data!.referrals).toEqual([]);
    expect(await pendingCount()).toEqual({ pending: 0 });
    notOnIt(await referral(dept));
    for (const body of [{ action: "accept" }, { action: "decline" }, { action: "complete" }, { action: "revoke", reason: "Not mine" }]) notOnIt(await actOn(dept, body));
    // No clinical access either: not the patient, not a consultation, not a record.
    denied(await workspace(p.id), [404]);
    denied(await startConsultation(p.id, { appointmentId: p.consultation }), [404]);
    denied(await writeRecord(p.id, { appointmentId: p.consultation }), [404]);
    expect(await referralRow(dept)).toEqual(UNTAKEN);
    // The refusal is about the department: a cardiologist does receive it.
    as("card1");
    expect(await incomingIds()).toContain(dept);
  });

  it("22. another clinic's department of the same name: nothing crosses clinics", async () => {
    const p = await patientWithRecord("A", "a", "a");
    const dept = await insertDepartmentReferral(p, "a", specialty.cardio);
    as("kcard", ["doctor"], "B");
    expect(await incomingIds()).toEqual([]);
    expect(await pendingCount()).toEqual({ pending: 0 });
    notOnIt(await referral(dept));
    for (const body of [{ action: "accept" }, { action: "decline" }]) notOnIt(await actOn(dept, body));
    denied(await workspace(p.id), [404]);
    // Nor can either clinic refer into the other's department — a same-named one included.
    const kVisit = await visit("B", Z.id, doctors.kcard, "completed");
    const toA = await callList(referralCreate as ListHandler, "POST", "/api/doctor/referrals", {
      idempotencyKey: randomUUID(),
      appointmentId: kVisit,
      referredToSpecialtyId: specialty.cardio,
      reason: "Cross-clinic department",
      priority: "routine",
    });
    denied(toA, [404]);
    expect(toA.body.code).toBe("department_not_found");
    as("a");
    const aVisit = await visit("A", p.id, doctors.a, "completed");
    for (const [target, code] of [
      [{ referredToSpecialtyId: specialty.cardioB }, "department_not_found"],
      [{ referredToDoctorId: doctors.kcard, referredToSpecialtyId: specialty.cardio }, "doctor_not_found"],
    ] as const) {
      const res = await callList(referralCreate as ListHandler, "POST", "/api/doctor/referrals", {
        idempotencyKey: randomUUID(),
        appointmentId: aVisit,
        reason: "Cross-clinic department",
        priority: "routine",
        ...target,
      });
      denied(res, [404]);
      expect(res.body.code).toBe(code);
    }
    const { data: made } = await admin.from("referrals").select("id").in("originating_appointment_id", [kVisit, aVisit]);
    expect(made).toEqual([]);
    expect(await referralRow(dept)).toEqual(UNTAKEN);
  });

  it("23. an observer — the whole history through their own visit — reads the patient's referrals but can act on none of them", async () => {
    const p = await patientWithRecord("A", "a", "a");
    const named = await insertReferral("A", p, "a", "b", "a");
    await transition(named, { status: "accepted", accepted_by: users.b });
    const dept = await insertDepartmentReferral(p, "a", specialty.cardio);
    await visit("A", p.id, doctors.observer, "completed");
    as("observer");
    const ws = await workspace(p.id);
    expect(ws.status).toBe(200);
    const rec = ws.body.data!.record as {
      relationship: string;
      referrals: Array<{ id: string; role: string; status: string; allowedActions: string[]; referredToDoctor: { id: string } | null; department: { id: string } | null }>;
    };
    expect(rec.relationship).toBe("own");
    expect(sorted(rec.referrals.map((r) => r.id))).toEqual(sorted([named, dept]));
    expect(rec.referrals.find((r) => r.id === named)).toMatchObject({ role: "observer", status: "accepted", allowedActions: [], referredToDoctor: { id: doctors.b }, department: null });
    expect(rec.referrals.find((r) => r.id === dept)).toMatchObject({ role: "observer", status: "pending", allowedActions: [], referredToDoctor: null, department: { id: specialty.cardio } });
    // Read-only means read-only: no referral page, no transition of any kind.
    for (const id of [named, dept]) {
      notOnIt(await referral(id));
      for (const body of [{ action: "accept" }, { action: "decline" }, { action: "complete" }, { action: "revoke", reason: "Observer" }]) notOnIt(await actOn(id, body));
    }
    expect(await referralRow(named)).toEqual({ status: "accepted", referred_to_doctor_id: doctors.b, accepted_by: users.b, follow_up_appointment_id: null });
    expect(await referralRow(dept)).toEqual(UNTAKEN);
    expect(await incomingIds()).toEqual([]);
  });

  it("24. forging the claiming doctor: a department referral is only ever taken by the session's own doctor — the database refuses anything else", async () => {
    const p = await patientWithRecord("A", "a", "a");
    const dept = await insertDepartmentReferral(p, "a", specialty.cardio);
    const forgedBody = (doctor: string, profile: string) => ({
      action: "accept",
      referredToDoctorId: doctors[doctor],
      referred_to_doctor_id: doctors[doctor],
      doctorId: doctors[doctor],
      accepted_by: users[profile],
      acceptedBy: users[profile],
    });
    const claim = (id: string, doctor: string) =>
      call(referralAct as Handler, "PATCH", `/api/doctor/referrals/${id}?doctorId=${doctors[doctor]}&referredToDoctorId=${doctors[doctor]}`, id, forgedBody(doctor, doctor));

    // A doctor outside the department can't take it for a cardiologist.
    as("neuro");
    notOnIt(await claim(dept, "card1"));
    expect(await referralRow(dept)).toEqual(UNTAKEN);
    // A cardiologist naming a colleague takes it themselves — the request's names are never read.
    as("card1");
    expect(await claim(dept, "card2")).toMatchObject({ status: 200, body: { data: { status: "accepted" } } });
    expect(await referralRow(dept)).toEqual({ status: "accepted", referred_to_doctor_id: doctors.card1, accepted_by: users.card1, follow_up_appointment_id: null });
    const { data: accepted } = await admin.from("audit_events").select("actor_id, old_values, new_values").eq("action", "referral_accepted").eq("referral_id", dept);
    expect(accepted).toEqual([
      {
        actor_id: users.card1,
        old_values: { status: "pending", referred_to_doctor_id: null },
        new_values: expect.objectContaining({ status: "accepted", referred_to_doctor_id: doctors.card1, referred_to_specialty_id: specialty.cardio }),
      },
    ]);
    // The colleague it was "claimed for" has nothing: not the referral, not the patient.
    as("card2");
    expect(await incomingIds()).not.toContain(dept);
    notOnIt(await claim(dept, "card2"));
    denied(await workspace(p.id), [404]);

    // The database backstop — even a server that forwarded forged names could not claim for someone else.
    const p2 = await patientWithRecord("A", "a", "a");
    const dept2 = await insertDepartmentReferral(p2, "a", specialty.cardio);
    for (const [patch, refusal] of [
      [{ referred_to_doctor_id: doctors.card2 }, "a department referral is taken by accepting it"],
      [{ status: "accepted", accepted_by: users.card1, referred_to_doctor_id: doctors.card2 }, "only the receiving doctor can mark the referral accepted"],
      [{ status: "accepted", accepted_by: users.neuro, referred_to_doctor_id: doctors.neuro }, "does not belong to that department"],
    ] as const) {
      const { error } = await admin.from("referrals").update(patch).eq("id", dept2);
      expect(error?.message, refusal).toContain(refusal);
    }
    expect(await referralRow(dept2)).toEqual(UNTAKEN);
    // Once taken, it is never handed to another doctor.
    const { error: moved } = await admin.from("referrals").update({ referred_to_doctor_id: doctors.card2 }).eq("id", dept);
    expect(moved?.message).toContain("cannot be edited");
    expect((await referralRow(dept))!.referred_to_doctor_id).toBe(doctors.card1);
  });

  // Cross-cutting ----------------------------------------------------------
  it("audit: legitimate reads are logged with actor, clinic, patient and referral; no clinical text in the whole trail", async () => {
    as("b");
    expect((await referral(active)).status).toBe(200);
    const logged = async (action: string) =>
      (
        await admin
          .from("audit_events")
          .select("actor_id, clinic_id, patient_id, referral_id, entity_type, entity_id, metadata")
          .eq("action", action)
          .eq("referral_id", active)
          .eq("actor_id", users.b)
      ).data ?? [];
    // The detail read is 'referral_opened' (Dr B has treated X by now, so the history rests on their own visits).
    expect(await logged("referral_opened")).toEqual([
      {
        actor_id: users.b,
        clinic_id: clinic.A,
        patient_id: X.id,
        referral_id: active,
        entity_type: "referrals",
        entity_id: active,
        metadata: { via: "detail", role: "receiver", status: "accepted", relationship: "own", history_shared: true },
      },
    ]);
    // 'referral_viewed' is left to the list views.
    const views = await logged("referral_viewed");
    expect(views.length).toBeGreaterThan(0);
    for (const v of views) expect(v).toMatchObject({ clinic_id: clinic.A, patient_id: X.id, metadata: { via: "list", box: "incoming", role: "receiver" } });
    const { data: trail } = await admin.from("audit_events").select("*").in("clinic_id", [clinic.A, clinic.B]);
    expect(JSON.stringify(trail)).not.toContain(SECRET);
  });

  it("lifecycle: out-of-order transitions are refused through the API", async () => {
    const p = await patientWithRecord("A", "a", "a");
    const r = await insertReferral("A", p, "a", "b", "a");
    as("b");
    denied(await actOn(r, { action: "complete" }), [409]); // pending → completed
    expect((await actOn(r, { action: "accept" })).status).toBe(200);
    denied(await actOn(r, { action: "accept" }), [409]); // twice
    denied(await actOn(r, { action: "decline" }), [409]); // after accepting
    denied(await actOn(r, { action: "complete" }), [409]); // before the consultation
    as("a");
    expect((await actOn(r, { action: "revoke", reason: "Red team" })).status).toBe(200);
    denied(await actOn(r, { action: "revoke", reason: "Again" }), [409]);
  });
});

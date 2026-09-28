import { cleanupTestClinics } from "@/test/cleanup-clinics";
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { NextRequest } from "next/server";
import { localDbAvailable } from "@/test/local-db";

/**
 * RED-TEAM suite for referral-based clinical access. Every attack is made
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
 * Cast (clinic A unless noted): Dr A (refers), Dr B (receives), Dr C (no
 * relationship), a receptionist, a manager linked to a doctor record but
 * without the doctor role, Dr K and Dr K2 (clinic B).
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
  let completed: { referral: string; patient: string; own: string };
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
  async function makeDoctor(key: string, clinicKey: "A" | "B", profile: string) {
    const { data, error } = await admin
      .from("doctors")
      .insert({ clinic_id: clinic[clinicKey], profile_id: profile, name: `Dr ${key} ${suffix}`, active: true })
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

    for (const n of ["a", "b", "c"]) await makeUser(n, "A", "doctor");
    await makeUser("receptionist", "A", "receptionist");
    await makeUser("manager", "A", "manager");
    await makeUser("k", "B", "doctor");
    await makeUser("k2", "B", "doctor");
    await makeUser("managerB", "B", "manager");
    for (const n of ["a", "b", "c"]) await makeDoctor(n, "A", users[n]);
    await makeDoctor("k", "B", users.k);
    await makeDoctor("k2", "B", users.k2);
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
    completed = { referral: c4, patient: x4.id, own };

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
    // Every refusal to open the patient is logged.
    const { data: log } = await admin.from("audit_events").select("actor_id").eq("action", "patient_clinical_access_denied").eq("entity_id", Y.id);
    expect((log ?? []).some((r) => r.actor_id === users.b)).toBe(true);
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
  it("6. completed referral IDs: direct care preserves history; closed workflow cannot be revived", async () => {
    as("b");
    const ws = await workspace(completed.patient);
    expect(ws.status).toBe(200); // Dr B's own consultation remains theirs…
    const rec = ws.body.data!.record as { appointments: Array<{ id: string }>; records: Array<{ id: string }> };
    expect(rec.appointments.map((a) => a.id)).toContain(completed.own);
    expect(JSON.stringify(ws.body)).toContain(SECRET); // authorized longitudinal clinical history
    expect((await referral(completed.referral)).status).toBe(200);
    // Past its validity Dr B can't act on it at all (410), never a silent no-op (200).
    for (const action of ["accept", "complete", "decline"]) denied(await actOn(completed.referral, { action }), [409, 410]);
    as("b");
    const incoming = await callList(referralList as ListHandler, "GET", "/api/doctor/referrals?box=incoming");
    expect((incoming.body.data!.referrals as Array<{ id: string }>).map((r) => r.id)).not.toContain(completed.referral);
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
    // The page says a pending referral can't start a consultation — call it anyway.
    const pendingPatient = await patientWithRecord("A", "a", "a");
    await insertReferral("A", pendingPatient, "a", "b", "a");
    as("b");
    denied(await startConsultation(pendingPatient.id, { serviceId: service.A }), [409]);
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
    const { data } = await admin.from("audit_events").select("actor_id, patient_id, clinic_id").eq("action", "patient_clinical_access_denied").eq("entity_id", probe);
    expect(data).toEqual([{ actor_id: users.b, patient_id: null, clinic_id: clinic.A }]);
  });

  it("2b. a legitimate onward handoff opens longitudinal history without sharing authorship", async () => {
    const p = await patientWithRecord("A", "a", "a");
    const toB = await insertReferral("A", p, "a", "b", "a");
    await transition(toB, { status: "accepted", accepted_by: users.b });
    as("b");
    const own = await visit("A", p.id, doctors.b, "in_progress");
    const onward = await callList(referralCreate as ListHandler, "POST", "/api/doctor/referrals", {
      idempotencyKey: randomUUID(),
      appointmentId: own,
      referredToDoctorId: doctors.c,
      reason: "Onward",
      priority: "routine",
    });
    expect(onward.status).toBe(201);
    as("c");
    expect((await actOn((onward.body.data!.referral as { id: string }).id, { action: "accept" })).status).toBe(200);
    const ws = await workspace(p.id);
    expect(ws.status).toBe(200);
    const rec = ws.body.data!.record as { appointments: Array<{ id: string }>; records: Array<{ id: string }> };
    expect(rec.appointments.map((a) => a.id)).toContain(own);
    expect(rec.records.length).toBeGreaterThan(0);
    expect(JSON.stringify(ws.body)).toContain(SECRET);
  });

  // Cross-cutting ----------------------------------------------------------
  it("audit: legitimate reads are logged with actor, clinic, patient and referral; no clinical text in the whole trail", async () => {
    as("b");
    expect((await referral(active)).status).toBe(200);
    const { data: view } = await admin
      .from("audit_events")
      .select("actor_id, clinic_id, patient_id, referral_id")
      .eq("action", "referral_viewed")
      .eq("referral_id", active)
      .eq("actor_id", users.b);
    expect((view ?? []).length).toBeGreaterThan(0);
    expect(view![0]).toEqual({ actor_id: users.b, clinic_id: clinic.A, patient_id: X.id, referral_id: active });
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

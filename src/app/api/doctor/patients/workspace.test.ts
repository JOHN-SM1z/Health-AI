import { cleanupTestClinics } from "@/test/cleanup-clinics";
import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { NextRequest } from "next/server";
import { localDbAvailable } from "@/test/local-db";

/**
 * A doctor's patient workspace, end to end against the local Supabase stack:
 * the doctor's patient list, the patient workspace
 * (GET /api/doctor/patients/[id]) — the patient's longitudinal clinic record:
 * every doctor's consultations and current clinical records, the patient's
 * referrals — clinical records (POST …/records) and starting a consultation
 * (POST …/consultations). A treating relationship (a non-cancelled visit or
 * an authored record) or an open referral gives a doctor the whole history
 * from the moment it exists; without one a doctor sees nothing. Only the
 * session lookup is mocked; every rule runs for real.
 *
 * Cast: Dr A (patient X's doctor), Dr E (also saw X), Dr B (X is referred to
 * them), Dr C (no relationship), a receptionist.
 */

const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const URL = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
// A zone where it is daytime now: walk-ins "now" stay inside one local day.
const TZ = daytimeTimezone();

const session = vi.hoisted(() => ({ ctx: null as unknown }));

vi.mock("@/lib/auth/staff", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/staff")>();
  return { ...actual, getStaffContext: async () => session.ctx };
});

import { GET as listPatients } from "./route";
import { GET as getWorkspace } from "./[id]/route";
import { POST as addRecord } from "./[id]/records/route";
import { POST as startConsultation } from "./[id]/consultations/route";
import { GET as listReferrals, POST as createReferral } from "../referrals/route";
import { PATCH as actOnReferral } from "../referrals/[id]/route";
import { PATCH as setAppointmentStatus } from "../appointments/[id]/route";
import { GET as getAdminPatient } from "@/app/api/admin/patients/route";
import { daytimeTimezone } from "@/test/daytime-timezone";

const describeDb = describe.skipIf(!localDbAvailable());

type Body = { ok: boolean; data?: Record<string, unknown>; code?: string; error?: string };
type Workspace = {
  relationship: string;
  activeReferralIds: string[];
  referralAccessUntil: string | null;
  patient: { id: string; fullName: string | null; phone: string | null };
  appointments: Array<{ id: string; mine: boolean; doctor: { id: string; name: string } | null }>;
  records: Array<{
    id: string;
    type: string;
    summary: string;
    code: string | null;
    mine: boolean;
    author: { id: string; name: string | null };
    createdAt: string;
    appointmentId: string;
    version: number;
    rootRecordId: string;
    stage: string;
    category: string;
  }>;
  referrals: Array<{ id: string; role: string; status: string; reason: string; handoffNote: string | null; allowedActions: string[] }>;
  consultation: {
    current: { appointmentId: string; paymentStatus: string | null } | null;
    booked: { appointmentId: string; paymentStatus: string | null } | null;
    canStartWalkIn: boolean;
  };
};
type AuditRow = {
  actor_id: string | null;
  entity_type: string;
  entity_id: string | null;
  patient_id: string | null;
  referral_id: string | null;
  metadata: Record<string, unknown> | null;
};

/** Minutes until midnight in the clinic's timezone: walk-ins must end within today's working hours. */
const minutesToClinicMidnight = () => {
  const [hour, minute] = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .format(new Date())
    .split(":")
    .map(Number);
  return 24 * 60 - (hour * 60 + minute);
};

describeDb("referred-patient clinical workspace", () => {
  let admin: SupabaseClient;
  const suffix = Date.now().toString(36);
  const users: Record<string, string> = {};
  const doctors: Record<string, string> = {};
  let clinicA: string;
  let serviceA: string;
  let quickService: string;
  let slot = 0;

  const as = (name: string | null, role = "doctor") => {
    session.ctx =
      name === null
        ? null
        : { profileId: users[name], clinicId: clinicA, clinicName: "Workspace Clinic", clinicTimezone: TZ, roles: [role], platformAdmin: false };
  };
  const request = (method: string, path: string, body?: unknown) =>
    new NextRequest(`http://localhost${path}`, {
      method,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const params = (id: string) => ({ params: Promise.resolve({ id }) });
  const read = async (res: Response) => ({ status: res.status, body: (await res.json()) as Body });

  const workspace = async (name: string, patientId: string) => {
    as(name);
    return read(await getWorkspace(request("GET", `/api/doctor/patients/${patientId}`), params(patientId)));
  };
  const ws = (res: { status: number; body: Body }) => {
    expect(res.status).toBe(200);
    return res.body.data!.record as Workspace;
  };
  const record = async (name: string, patientId: string, body: Record<string, unknown>) => {
    as(name);
    return read(
      await addRecord(
        request("POST", `/api/doctor/patients/${patientId}/records`, { idempotencyKey: randomUUID(), recordType: "consultation_note", summary: "Note", ...body }),
        params(patientId),
      ),
    );
  };
  const start = async (name: string, patientId: string, body: Record<string, unknown>) => {
    as(name);
    return read(await startConsultation(request("POST", `/api/doctor/patients/${patientId}/consultations`, body), params(patientId)));
  };
  type PatientRow = { id: string; fullName: string | null; relationship: string; lastVisitAt: string | null; referral: { id: string; status: string; referringDoctorName: string | null } | null };
  const patients = async (name: string, q = "", role = "doctor") => {
    as(name, role);
    const res = await read(await listPatients(request("GET", `/api/doctor/patients?q=${encodeURIComponent(q)}`)));
    return { status: res.status, body: res.body, rows: (res.body.data?.patients ?? []) as PatientRow[] };
  };
  const listed = async (name: string, q = "") => (await patients(name, q)).rows.map((p) => p.id);
  const incoming = async (name: string) => {
    as(name);
    return (await read(await listReferrals(request("GET", "/api/doctor/referrals?box=incoming")))).body.data!.referrals as Array<Record<string, unknown>>;
  };
  const act = async (name: string, referralId: string, body: Record<string, unknown>) => {
    as(name);
    return read(await actOnReferral(request("PATCH", `/api/doctor/referrals/${referralId}`, body), params(referralId)));
  };
  /** The audit rows of one action by one doctor about one entity, oldest first. */
  const audits = async (action: string, actor: string, entityId: string) =>
    ((await admin
      .from("audit_events")
      .select("actor_id, entity_type, entity_id, patient_id, referral_id, metadata")
      .eq("clinic_id", clinicA)
      .eq("action", action)
      .eq("actor_id", users[actor])
      .eq("entity_id", entityId)
      .order("created_at", { ascending: true })).data ?? []) as AuditRow[];

  async function makeUser(name: string, role: string) {
    const { data, error } = await admin.auth.admin.createUser({ email: `ws-${name}-${suffix}@test.local`, password: "Workspace-Test-123!", email_confirm: true });
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

  async function newPatient() {
    const { data } = await admin
      .from("patients")
      .insert({ clinic_id: clinicA, full_name: `Workspace patient ${suffix}`, phone: "+998907776655" })
      .select("id")
      .single();
    return data!.id as string;
  }

  async function visit(patientId: string, doctor: string, status = "completed", startAt?: Date) {
    const startTime = startAt ?? new Date(Date.UTC(2026, 0, 5, 5, 0) + slot++ * 86_400_000);
    const { data, error } = await admin
      .from("appointments")
      .insert({
        clinic_id: clinicA,
        patient_id: patientId,
        doctor_id: doctor,
        service_id: serviceA,
        start_at: startTime.toISOString(),
        end_at: new Date(startTime.getTime() + 30 * 60_000).toISOString(),
        status,
        source: "walk_in",
      })
      .select("id")
      .single();
    expect(error).toBeNull();
    return data!.id as string;
  }

  /** A record written by `name` in their own consultation (through the API). */
  async function writeRecord(name: string, patientId: string, appointmentId: string, body: Record<string, unknown> = {}) {
    const res = await record(name, patientId, { appointmentId, ...body });
    expect(res.status).toBe(201);
    return (res.body.data!.record as { id: string }).id;
  }

  /** Patient X: Dr A's earlier visit and consultation, each with a record, and Dr E's visit with one. */
  async function patientX() {
    const id = await newPatient();
    const earlier = await visit(id, doctors.a);
    const consultation = await visit(id, doctors.a);
    const withE = await visit(id, doctors.e);
    const recEarlier = await writeRecord("a", id, earlier, { recordType: "diagnosis", summary: "Essential hypertension", code: "I10" });
    const recConsultation = await writeRecord("a", id, consultation, { recordType: "lab_result", summary: "HbA1c 7.9%" });
    const recE = await writeRecord("e", id, withE, { recordType: "prescription", summary: "Amlodipine 5 mg daily" });
    return {
      id,
      earlier,
      consultation,
      withE,
      recEarlier,
      recConsultation,
      recE,
      // The patient's whole history: every doctor's visits and records.
      appointmentIds: [earlier, consultation, withE].sort(),
      allRecords: [recEarlier, recConsultation, recE].sort(),
    };
  }

  async function refer(x: { consultation: string }) {
    as("a");
    const res = await read(
      await createReferral(
        request("POST", "/api/doctor/referrals", {
          idempotencyKey: randomUUID(),
          appointmentId: x.consultation,
          referredToDoctorId: doctors.b,
          reason: `Poorly controlled BP despite treatment (${suffix})`,
          handoffNote: `Echo recommended (${suffix})`,
          priority: "urgent",
          validForDays: 30,
        }),
      ),
    );
    expect(res.status).toBe(201);
    return (res.body.data!.referral as { id: string }).id;
  }

  /** A referral from Dr A to Dr B that lapses `ms` from now (straight in the database, as the API only offers days). */
  async function shortLivedReferral(x: { id: string; consultation: string }, ms: number) {
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

  const recordIds = (w: Workspace) => w.records.map((r) => r.id).sort();
  const appointmentIds = (w: Workspace) => w.appointments.map((a) => a.id).sort();

  beforeAll(async () => {
    admin = createClient(URL, SERVICE_KEY, { auth: { persistSession: false } });
    const { data: clinic } = await admin
      .from("clinics")
      .insert({ name: `Workspace Clinic ${suffix}`, slug: `workspace-${suffix}`, timezone: TZ })
      .select("id")
      .single();
    clinicA = clinic!.id;
    for (const name of ["a", "b", "c", "e"]) await makeUser(name, "doctor");
    await makeUser("receptionist", "receptionist");
    for (const name of ["a", "b", "c", "e"]) await makeDoctor(name);
    const { data: services } = await admin
      .from("services")
      .insert([
        { clinic_id: clinicA, name: `Workspace consult ${suffix}`, duration_minutes: 30, price: 100000, active: true },
        { clinic_id: clinicA, name: `Workspace quick visit ${suffix}`, duration_minutes: 5, price: 50000, active: true },
      ])
      .select("id, duration_minutes");
    serviceA = services!.find((s) => s.duration_minutes === 30)!.id;
    quickService = services!.find((s) => s.duration_minutes === 5)!.id;
  });

  afterAll(async () => {
    if (!admin || !clinicA) return;
    await admin.from("patients").delete().eq("clinic_id", clinicA);
    await admin.from("staff_roles").delete().eq("clinic_id", clinicA);
    await admin.from("doctors").delete().eq("clinic_id", clinicA);
    await admin.from("services").delete().eq("clinic_id", clinicA);
    await cleanupTestClinics([clinicA]);
    for (const id of Object.values(users)) await admin.auth.admin.deleteUser(id).catch(() => {});
  });

  it("referred patient appears — in Dr B's incoming referrals, and as a workspace with the whole history before any acceptance", async () => {
    const x = await patientX();
    const referral = await refer(x);

    const card = (await incoming("b")).find((r) => r.id === referral);
    expect(card).toMatchObject({
      patientId: x.id,
      patientName: `Workspace patient ${suffix}`,
      referringDoctor: { id: doctors.a },
      referredToDoctor: { id: doctors.b },
      department: null,
      reason: `Poorly controlled BP despite treatment (${suffix})`,
      handoffNote: `Echo recommended (${suffix})`,
      status: "pending",
      priority: "urgent",
      createdAt: expect.any(String),
      expiresAt: expect.any(String),
      allowedActions: ["accept", "decline"],
    });

    const seen = ws(await workspace("b", x.id));
    expect(seen).toMatchObject({
      relationship: "referred",
      activeReferralIds: [referral],
      // Access resting only on the referral lasts until it expires (or is declined or revoked).
      referralAccessUntil: card!.expiresAt,
      patient: { id: x.id, phone: "+998907776655" },
      referrals: [{ id: referral, role: "receiver", status: "pending", reason: `Poorly controlled BP despite treatment (${suffix})`, allowedActions: ["accept", "decline"] }],
      // A pending referral is no gate: starting the consultation accepts it.
      consultation: { current: null, booked: null, canStartWalkIn: true },
    });
    expect(seen.consultation).not.toHaveProperty("blockedReason");
    // The whole history at once — every doctor's visits and records, Dr E's included; nothing is Dr B's.
    expect(appointmentIds(seen)).toEqual(x.appointmentIds);
    expect(recordIds(seen)).toEqual(x.allRecords);
    expect(seen.records.filter((r) => r.mine)).toEqual([]);

    // The view is logged against the referral it rests on — ids only.
    const views = await audits("clinical_record_viewed", "b", x.id);
    expect(views).toEqual([
      expect.objectContaining({
        actor_id: users.b,
        entity_type: "patients",
        patient_id: x.id,
        referral_id: referral,
        metadata: expect.objectContaining({ via: "workspace", relationship: "referred", referral_ids: [referral], shown_referral_ids: [referral], record_count: 3 }),
      }),
    ]);
    const [viewed] = views;
    expect([...(viewed.metadata!.record_ids as string[])].sort()).toEqual(x.allRecords);
    expect([...(viewed.metadata!.other_author_record_ids as string[])].sort()).toEqual(x.allRecords);
  });

  it("unrelated patient does not appear — not listed, not openable, not writable", async () => {
    const x = await patientX();
    const referral = await refer(x);
    await act("b", referral, { action: "accept" });

    expect((await incoming("c")).map((r) => r.id)).not.toContain(referral);
    const res = await workspace("c", x.id);
    expect(res).toMatchObject({ status: 404, body: { code: "patient_not_found" } });
    expect(JSON.stringify(res.body)).not.toContain("Workspace patient");
    expect(await record("c", x.id, { appointmentId: x.consultation })).toMatchObject({ status: 404 });
    expect(await start("c", x.id, { serviceId: quickService })).toMatchObject({ status: 404 });
    // Every refusal is logged — without turning the probed id into a patient reference.
    const refusal = { actor_id: users.c, entity_type: "patients", entity_id: x.id, patient_id: null, referral_id: null, metadata: { doctor_id: doctors.c, referral_status: null } };
    expect(await audits("unauthorized_clinical_access_attempt", "c", x.id)).toEqual([refusal, refusal, refusal]);
  });

  it("expired referral — resting only on it, Dr B is told it expired and sees nothing; with their own visit, Dr B keeps the whole history", async () => {
    const x = await patientX();
    const y = await patientX();
    // Dr B's own visit with Y, booked for later: a treating relationship of its own.
    const ownY = await visit(y.id, doctors.b, "confirmed", new Date(Date.UTC(2030, 1, 4, 5, 0)));
    const shortX = await shortLivedReferral(x, 4_000);
    const shortY = await shortLivedReferral(y, 4_000);
    await act("b", shortX, { action: "accept" });
    // While it lasts, the referral alone gives Dr B the whole history.
    const during = ws(await workspace("b", x.id));
    expect(during).toMatchObject({ relationship: "referred", activeReferralIds: [shortX] });
    expect(recordIds(during)).toEqual(x.allRecords);

    await new Promise((r) => setTimeout(r, 4_500));

    const res = await workspace("b", x.id);
    expect(res).toMatchObject({ status: 410, body: { code: "referral_expired" } });
    expect(JSON.stringify(res.body)).not.toMatch(/Workspace patient|hypertension|HbA1c|Amlodipine/);
    expect((await incoming("b")).map((r) => r.id)).not.toContain(shortX);
    expect(await start("b", x.id, { serviceId: quickService })).toMatchObject({ status: 410, body: { code: "referral_expired" } });
    expect(await record("b", x.id, { appointmentId: x.consultation })).toMatchObject({ status: 410, body: { code: "referral_expired" } });
    // Each refusal is logged against the lapsed referral — its id and status only.
    const refusal = { actor_id: users.b, entity_type: "patients", entity_id: x.id, patient_id: x.id, referral_id: shortX, metadata: { doctor_id: doctors.b, referral_status: "expired" } };
    expect(await audits("unauthorized_clinical_access_attempt", "b", x.id)).toEqual([refusal, refusal, refusal]);

    // Y: the same expiry, but Dr B's own visit is a treating relationship — the whole history stays (continuity of care).
    const kept = ws(await workspace("b", y.id));
    expect(kept).toMatchObject({ relationship: "own", activeReferralIds: [], referralAccessUntil: null, consultation: { current: null, booked: null } });
    expect(recordIds(kept)).toEqual(y.allRecords);
    expect(appointmentIds(kept)).toEqual([...y.appointmentIds, ownY].sort());
    expect(kept.referrals).toEqual([expect.objectContaining({ id: shortY, role: "receiver", status: "expired", allowedActions: [] })]);
  }, 20_000);

  it("revoked referral — access resting only on it ends; Dr B's own consultation keeps the whole history; a cancelled booking is no relationship", async () => {
    const x = await patientX();
    const referral = await refer(x);
    await act("b", referral, { action: "accept" });
    expect(recordIds(ws(await workspace("b", x.id)))).toEqual(x.allRecords);

    await act("a", referral, { action: "revoke", reason: "Patient transferred" });
    const res = await workspace("b", x.id);
    expect(res).toMatchObject({ status: 410, body: { code: "referral_revoked" } });
    expect(JSON.stringify(res.body)).not.toMatch(/hypertension|HbA1c|Amlodipine|Workspace patient/);
    expect((await incoming("b")).map((r) => r.id)).not.toContain(referral);
    expect(await start("b", x.id, { serviceId: quickService })).toMatchObject({ status: 410, body: { code: "referral_revoked" } });

    // Had Dr B already seen the patient, that consultation is a treating relationship: the whole history stays.
    const y = await patientX();
    const second = await refer(y);
    await act("b", second, { action: "accept" });
    const ownVisit = await visit(y.id, doctors.b, "in_progress");
    const ownRecord = await writeRecord("b", y.id, ownVisit);
    await act("a", second, { action: "revoke", reason: "Patient transferred" });
    const own = ws(await workspace("b", y.id));
    expect(own).toMatchObject({ relationship: "own", activeReferralIds: [], referralAccessUntil: null, consultation: { current: { appointmentId: ownVisit } } });
    expect(recordIds(own)).toEqual([...y.allRecords, ownRecord].sort());
    expect(own.records.filter((r) => r.mine).map((r) => r.id)).toEqual([ownRecord]);
    expect(own.referrals).toEqual([expect.objectContaining({ id: second, role: "receiver", status: "revoked", allowedActions: [] })]);

    // A follow-up that was booked and then cancelled is no relationship: the referral stays Dr B's only link.
    const z = await patientX();
    const third = await refer(z);
    await act("b", third, { action: "accept" });
    const booking = await visit(z.id, doctors.b, "confirmed", new Date(Date.UTC(2030, 2, 4, 5, 0)));
    expect((await admin.from("referrals").update({ follow_up_appointment_id: booking }).eq("id", third)).error).toBeNull();
    expect(ws(await workspace("b", z.id)).relationship).toBe("own");
    expect((await admin.from("appointments").update({ status: "cancelled" }).eq("id", booking)).error).toBeNull();
    expect(ws(await workspace("b", z.id))).toMatchObject({ relationship: "referred", activeReferralIds: [third] });
    await act("a", third, { action: "revoke", reason: "Patient transferred" });
    const lapsed = await workspace("b", z.id);
    expect(lapsed).toMatchObject({ status: 410, body: { code: "referral_revoked" } });
    expect(JSON.stringify(lapsed.body)).not.toMatch(/hypertension|HbA1c|Amlodipine|Workspace patient/);
  });

  it("clinical records are displayed with provenance — every author's current record, to every doctor with a relationship, never to reception", async () => {
    const x = await patientX();
    const referral = await refer(x);

    // Pending: already the whole history — every author's record, attributed to its author.
    const pending = ws(await workspace("b", x.id));
    expect(recordIds(pending)).toEqual(x.allRecords);
    const shown = (id: string) => pending.records.find((r) => r.id === id);
    for (const id of [x.recEarlier, x.recConsultation]) {
      expect(shown(id)).toMatchObject({ mine: false, author: { id: doctors.a, name: `Dr A ${suffix}` }, version: 1, rootRecordId: id, stage: "historical", createdAt: expect.any(String) });
    }
    expect(shown(x.recEarlier)).toMatchObject({ type: "diagnosis", summary: "Essential hypertension", code: "I10", appointmentId: x.earlier, category: "historical_diagnosis" });
    expect(shown(x.recE)).toMatchObject({
      type: "prescription",
      summary: "Amlodipine 5 mg daily",
      mine: false,
      author: { id: doctors.e, name: `Dr E ${suffix}` },
      appointmentId: x.withE,
      version: 1,
      rootRecordId: x.recE,
      stage: "historical",
      category: "prescription",
    });

    // Accepting is a care step, not a gate: exactly the same records.
    await act("b", referral, { action: "accept" });
    expect(ws(await workspace("b", x.id)).records).toEqual(pending.records);

    // Dr B's own consultation and record are Dr B's.
    const followUp = await visit(x.id, doctors.b, "in_progress");
    await admin.from("referrals").update({ follow_up_appointment_id: followUp }).eq("id", referral);
    const bRecord = await writeRecord("b", x.id, followUp, { recordType: "consultation_note", summary: "Echo booked; continue therapy" });
    const withOwn = ws(await workspace("b", x.id));
    expect(withOwn.consultation.current).toMatchObject({ appointmentId: followUp, paymentStatus: null });
    expect(withOwn.records.find((r) => r.id === bRecord)).toMatchObject({ mine: true, author: { id: doctors.b }, appointmentId: followUp, stage: "current", category: "clinical_note" });

    // Dr A and Dr E — each through their own visit — read every author's record; a record is "mine" only for its author.
    const views: Record<string, Workspace> = {};
    for (const [name, theirs] of [
      ["a", [x.recEarlier, x.recConsultation]],
      ["e", [x.recE]],
    ] as const) {
      views[name] = ws(await workspace(name, x.id));
      expect(views[name].relationship, name).toBe("own");
      expect(recordIds(views[name]), name).toEqual([...x.allRecords, bRecord].sort());
      expect(views[name].records.filter((r) => r.mine).map((r) => r.id).sort(), name).toEqual([...theirs].sort());
    }
    // The referral is part of the patient's record: Dr A acts on it as its referrer; Dr E, on neither side, only reads it.
    expect(views.a.referrals).toEqual([expect.objectContaining({ id: referral, role: "referrer", status: "in_progress", allowedActions: ["revoke"] })]);
    expect(views.e.referrals).toEqual([
      expect.objectContaining({ id: referral, role: "observer", status: "in_progress", reason: `Poorly controlled BP despite treatment (${suffix})`, allowedActions: [] }),
    ]);

    // Completed: Dr B's own consultation keeps the whole history.
    await act("b", referral, { action: "complete" });
    const completed = ws(await workspace("b", x.id));
    expect(completed).toMatchObject({ relationship: "own", activeReferralIds: [], referralAccessUntil: null });
    expect(recordIds(completed)).toEqual([...x.allRecords, bRecord].sort());

    // Reception's patient view never carries clinical records.
    as("receptionist", "receptionist");
    const reception = await read(await getAdminPatient(request("GET", `/api/admin/patients?id=${x.id}`)));
    expect(reception.status).toBe(200);
    expect(JSON.stringify(reception.body)).not.toMatch(/hypertension|HbA1c|Amlodipine|Echo booked|Poorly controlled/);
  });

  it("patient ID tampering fails", async () => {
    const x = await patientX();
    const y = await newPatient();
    await visit(y, doctors.a);
    const referral = await refer(x);
    await act("b", referral, { action: "accept" });
    const ownVisit = await visit(x.id, doctors.b, "in_progress");

    // Another patient's id in the URL: no workspace, no consultation, no record.
    expect(await workspace("b", y)).toMatchObject({ status: 404 });
    expect(await start("b", y, { serviceId: quickService })).toMatchObject({ status: 404 });
    expect(await record("b", y, { appointmentId: ownVisit })).toMatchObject({ status: 404 });
    // X's URL with Dr A's consultation, or with a visit of another patient.
    expect(await record("b", x.id, { appointmentId: x.consultation })).toMatchObject({ status: 404, body: { code: "consultation_not_found" } });
    // Writing into another doctor's consultation is an audited mutation attempt — ids only.
    expect(await audits("unauthorized_clinical_mutation_attempt", "b", x.consultation)).toEqual([
      { actor_id: users.b, entity_type: "appointments", entity_id: x.consultation, patient_id: x.id, referral_id: null, metadata: { reason: "not_own_consultation", attempted: "write", doctor_id: doctors.b } },
    ]);
    // Correcting Dr A's record: Dr B may read it, but only its author may correct it.
    expect(await record("b", x.id, { appointmentId: ownVisit, recordType: "lab_result", correctsRecordId: x.recConsultation })).toMatchObject({
      status: 403,
      body: { code: "CLINICAL_RECORD_NOT_OWNED" },
    });
    // Provenance smuggled into the body is ignored: the author is the session's doctor.
    const smuggled = await record("b", x.id, {
      appointmentId: ownVisit,
      authorDoctorId: doctors.a,
      createdBy: users.a,
      patientId: y,
      clinicId: randomUUID(),
      createdAt: "2020-01-01T00:00:00Z",
    });
    expect(smuggled.status).toBe(201);
    const { data: stored } = await admin
      .from("clinical_records")
      .select("author_doctor_id, created_by, patient_id, created_at")
      .eq("id", (smuggled.body.data!.record as { id: string }).id)
      .single();
    expect(stored).toMatchObject({ author_doctor_id: doctors.b, created_by: users.b, patient_id: x.id });
    expect(Date.parse(stored!.created_at)).toBeGreaterThan(Date.now() - 60_000);
    // Malformed ids never reach the database.
    expect(await workspace("b", "../../admin")).toMatchObject({ status: 404 });
    expect(await record("b", "not-a-uuid", { appointmentId: ownVisit })).toMatchObject({ status: 404 });
  });

  it("starts Dr B's own consultation — a pending referral is accepted as it starts, idempotently, linked to the referral", async () => {
    const x = await patientX();
    const referral = await refer(x);

    if (minutesToClinicMidnight() < 15) {
      // A walk-in must end within today's working hours.
      expect(await start("b", x.id, { serviceId: quickService })).toMatchObject({ status: 422, body: { code: "INVALID_TIME", details: { reason: "outside_working_hours" } } });
      return;
    }

    // No acceptance step first: starting to treat the referred patient takes the referral on.
    const first = await start("b", x.id, { serviceId: quickService });
    expect(first).toMatchObject({ status: 201, body: { data: { consultation: { started: true } } } });
    const appointmentId = (first.body.data!.consultation as { appointmentId: string }).appointmentId;
    const again = await start("b", x.id, { serviceId: quickService });
    expect(again).toMatchObject({ status: 200, body: { data: { consultation: { appointmentId, started: false } } } });

    const { data: appointment } = await admin.from("appointments").select("status, doctor_id, patient_id, source").eq("id", appointmentId).single();
    expect(appointment).toEqual({ status: "in_progress", doctor_id: doctors.b, patient_id: x.id, source: "walk_in" });
    // The referral was accepted by Dr B and the consultation became its follow-up: in progress.
    const { data: linked } = await admin
      .from("referrals")
      .select("status, referred_to_doctor_id, accepted_by, started_by, follow_up_appointment_id")
      .eq("id", referral)
      .single();
    expect(linked).toEqual({ status: "in_progress", referred_to_doctor_id: doctors.b, accepted_by: users.b, started_by: users.b, follow_up_appointment_id: appointmentId });
    const { data: trail } = await admin
      .from("audit_events")
      .select("action, actor_id")
      .eq("clinic_id", clinicA)
      .eq("referral_id", referral)
      .in("action", ["referral_created", "referral_accepted", "referral_in_progress", "referral_follow_up_booked"])
      .order("action", { ascending: true });
    // Accepting and starting now happen in one transaction (one audit timestamp), so the two are compared as a set.
    expect(trail).toEqual([
      { action: "referral_accepted", actor_id: users.b },
      { action: "referral_created", actor_id: users.a },
      { action: "referral_in_progress", actor_id: users.b },
    ]);

    // The only payment detail a doctor sees: the status of their own visit in front of them — never another visit's, never an amount.
    expect((await admin.from("payments").insert({ clinic_id: clinicA, appointment_id: x.withE, patient_id: x.id, amount: 175000, status: "paid" })).error).toBeNull();
    const during = ws(await workspace("b", x.id));
    expect(during.consultation).toMatchObject({ current: { appointmentId, paymentStatus: "unpaid" }, booked: null });
    for (const a of during.appointments) expect(Object.keys(a).sort()).toEqual(["doctor", "endAt", "id", "mine", "service", "startAt", "status"]);
    expect(JSON.stringify(during)).not.toMatch(/"amount"|"price"|"paid"/);

    // Document it and finish it.
    await writeRecord("b", x.id, appointmentId, { recordType: "diagnosis", summary: "Hypertensive heart disease", code: "I11.9" });
    as("b");
    const done = await read(await setAppointmentStatus(request("PATCH", `/api/doctor/appointments/${appointmentId}`, { status: "completed" }), params(appointmentId)));
    expect(done.status).toBe(200);
    const after = ws(await workspace("b", x.id));
    expect(after.consultation.current).toBeNull();
    expect(after.records.find((r) => r.summary === "Hypertensive heart disease")).toMatchObject({ mine: true, appointmentId });
  });

  it("starts a visit booked for today instead of adding a walk-in", async () => {
    if (minutesToClinicMidnight() < 60) return; // no room left today for a booked visit
    const x = await patientX();
    const referral = await refer(x);
    await act("b", referral, { action: "accept" });
    const booked = await visit(x.id, doctors.b, "confirmed", new Date(Math.ceil((Date.now() + 10 * 60_000) / 60_000) * 60_000));

    // No payment row for this visit: its status is unknown, not guessed.
    expect(ws(await workspace("b", x.id)).consultation.booked).toEqual(expect.objectContaining({ appointmentId: booked, paymentStatus: null }));
    // Dr A's visit can't be started as Dr B's consultation.
    expect(await start("b", x.id, { appointmentId: x.consultation })).toMatchObject({ status: 404, body: { code: "consultation_not_found" } });
    const res = await start("b", x.id, { appointmentId: booked });
    expect(res).toMatchObject({ status: 201, body: { data: { consultation: { appointmentId: booked, started: true } } } });
    const { data: started } = await admin.from("appointments").select("status").eq("id", booked).single();
    expect(started!.status).toBe("in_progress");
  });

  it("doctor patient list — own and actively referred patients only, gone once the referral lapses", async () => {
    const x = await patientX();
    const referral = await refer(x);

    expect((await patients("a")).rows.find((p) => p.id === x.id)).toMatchObject({ relationship: "own", referral: null });
    expect((await patients("b")).rows.find((p) => p.id === x.id)).toMatchObject({
      relationship: "referred",
      referral: { id: referral, status: "pending", referringDoctorName: `Dr A ${suffix}` },
    });
    // Same clinic, no relationship: never listed.
    expect(await listed("c")).not.toContain(x.id);

    // Every listed patient opens — the list and the workspace share one decision.
    for (const id of await listed("b")) expect((await workspace("b", id)).status).toBe(200);

    await act("b", referral, { action: "accept" });
    expect((await patients("b")).rows.find((p) => p.id === x.id)?.referral?.status).toBe("accepted");
    await act("a", referral, { action: "revoke", reason: "Patient transferred" });
    expect(await listed("b")).not.toContain(x.id);

    // Expired referrals drop out as well.
    const y = await patientX();
    await shortLivedReferral(y, 3_000);
    expect(await listed("b")).toContain(y.id);
    await new Promise((r) => setTimeout(r, 3_500));
    expect(await listed("b")).not.toContain(y.id);
  }, 20_000);

  it("doctor patient list — search by name or phone, and only for linked doctors", async () => {
    const { data: named } = await admin
      .from("patients")
      .insert({ clinic_id: clinicA, full_name: `Zulfiya Karimova ${suffix}`, phone: "+998 90 123-45-67" })
      .select("id")
      .single();
    await visit(named!.id, doctors.a);

    // Last visit: the visit that took place — not a later booking or a later cancelled visit.
    await visit(named!.id, doctors.a, "confirmed", new Date(Date.UTC(2030, 0, 7, 5, 0)));
    await visit(named!.id, doctors.a, "cancelled", new Date(Date.UTC(2026, 7, 1, 5, 0)));
    const { data: held } = await admin
      .from("appointments")
      .select("start_at")
      .eq("patient_id", named!.id)
      .eq("status", "completed")
      .single();
    const row = (await patients("a", `zulfiya karimova ${suffix}`)).rows[0];
    expect(row).toMatchObject({ id: named!.id, relationship: "own" });
    expect(Date.parse(row.lastVisitAt!)).toBe(Date.parse(held!.start_at));
    // A booking alone still makes the patient the doctor's own.
    const { data: booked } = await admin.from("patients").insert({ clinic_id: clinicA, full_name: `Booked only ${suffix}` }).select("id").single();
    await visit(booked!.id, doctors.a, "confirmed", new Date(Date.UTC(2030, 0, 9, 5, 0)));
    expect((await patients("a", `Booked only ${suffix}`)).rows).toMatchObject([{ id: booked!.id, relationship: "own", lastVisitAt: null }]);

    expect(await listed("a", `zulfiya karimova ${suffix}`)).toEqual([named!.id]);
    expect(await listed("a", "4567")).toContain(named!.id);
    expect(await listed("a", `nobody-${suffix}`)).toEqual([]);
    // A search never widens the list: Dr C finds nobody by that name.
    expect(await listed("c", `Zulfiya Karimova ${suffix}`)).toEqual([]);
    // Filter syntax is plain text, not a query.
    expect(await listed("a", "id.neq.0,full_name.ilike.*")).toEqual([]);

    expect(await patients("receptionist", "", "receptionist")).toMatchObject({ status: 403 });
    await makeUser("unlinked", "doctor");
    expect(await patients("unlinked")).toMatchObject({ status: 403, body: { code: "doctor_not_linked" } });
    as(null);
    expect((await read(await listPatients(request("GET", "/api/doctor/patients")))).status).toBe(401);
  });

  it("a record from a consultation older than the 200-visit window still comes with its consultation; older visits without one do not", async () => {
    const x = await patientX();
    const old = await visit(x.id, doctors.a, "completed", new Date(Date.UTC(2024, 0, 10, 5, 0)));
    const oldRecord = await writeRecord("a", x.id, old, { recordType: "medical_history", summary: "Appendectomy 2010" });
    // 200 later visits without records: with X's three, the newest 200 leave the 2024 visit and three 2025 ones out.
    const { error } = await admin.from("appointments").insert(
      Array.from({ length: 200 }, (_, i) => {
        const startAt = new Date(Date.UTC(2025, 0, 1, 5, 0) + i * 86_400_000);
        return {
          clinic_id: clinicA,
          patient_id: x.id,
          doctor_id: doctors.a,
          service_id: serviceA,
          start_at: startAt.toISOString(),
          end_at: new Date(startAt.getTime() + 30 * 60_000).toISOString(),
          status: "completed",
          source: "walk_in",
        };
      }),
    );
    expect(error).toBeNull();
    const { data: all } = await admin.from("appointments").select("id").eq("clinic_id", clinicA).eq("patient_id", x.id).order("start_at", { ascending: false });
    expect(all).toHaveLength(204);
    const window = all!.slice(0, 200).map((a) => a.id);
    expect(window).not.toContain(old);
    // The newest 200 — every doctor's — plus the older consultation a shown record was written in; the rest stays out.
    const expected = [...window, old];

    const own = ws(await workspace("a", x.id));
    expect(own.appointments.map((a) => a.id)).toEqual(expected);
    expect(own.records.find((r) => r.id === oldRecord)).toMatchObject({ appointmentId: old, author: { id: doctors.a }, mine: true });

    // Dr B, referred (not even accepted yet), gets the same history — Dr E's visit and record included.
    await refer(x);
    const referred = ws(await workspace("b", x.id));
    expect(referred.appointments.map((a) => a.id)).toEqual(expected);
    expect(referred.appointments.map((a) => a.id)).toContain(x.withE);
    expect(recordIds(referred)).toEqual([...x.allRecords, oldRecord].sort());
  });
});

import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { NextRequest } from "next/server";
import { localDbAvailable } from "@/test/local-db";

/**
 * The receiving doctor's referred-patient workspace, end to end against the
 * local Supabase stack: the referred-patients list, the patient workspace
 * (GET /api/doctor/patients/[id]), clinical records
 * (POST …/records) and starting a consultation (POST …/consultations).
 * Only the session lookup is mocked; every rule runs for real.
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
  patient: { id: string; fullName: string | null; phone: string | null };
  appointments: Array<{ id: string; mine: boolean }>;
  records: Array<{ id: string; type: string; summary: string; mine: boolean; author: { id: string; name: string | null }; createdAt: string; appointmentId: string }>;
  referrals: Array<{ id: string; role: string; status: string; reason: string; handoffNote: string | null }>;
  consultation: { current: { appointmentId: string } | null; booked: unknown; canStartWalkIn: boolean; blockedReason: string | null };
};

/** Minutes until midnight in the clinic (Tashkent, UTC+5): walk-ins must end within today's working hours. */
const minutesToClinicMidnight = () => {
  const local = new Date(Date.now() + 5 * 3_600_000);
  return 24 * 60 - (local.getUTCHours() * 60 + local.getUTCMinutes());
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
  const ws = (res: { body: Body }) => res.body.data!.record as Workspace;
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
    return { id, earlier, consultation, withE, recEarlier, recConsultation, recE, aRecords: [recEarlier, recConsultation].sort() };
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

  const recordIds = (w: Workspace) => w.records.map((r) => r.id).sort();

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
    await admin.from("clinics").delete().eq("id", clinicA);
    for (const id of Object.values(users)) await admin.auth.admin.deleteUser(id).catch(() => {});
  });

  it("referred patient appears — in Dr B's referred patients and as a workspace", async () => {
    const x = await patientX();
    const referral = await refer(x);

    const card = (await incoming("b")).find((r) => r.id === referral);
    expect(card).toMatchObject({
      patientId: x.id,
      patientName: `Workspace patient ${suffix}`,
      referringDoctor: { id: doctors.a },
      reason: `Poorly controlled BP despite treatment (${suffix})`,
      handoffNote: `Echo recommended (${suffix})`,
      status: "pending",
      priority: "urgent",
      createdAt: expect.any(String),
      expiresAt: expect.any(String),
    });

    const res = await workspace("b", x.id);
    expect(res.status).toBe(200);
    expect(ws(res)).toMatchObject({
      relationship: "referred",
      patient: { id: x.id, phone: "+998907776655" },
      referrals: [{ id: referral, role: "receiver", status: "pending", reason: `Poorly controlled BP despite treatment (${suffix})` }],
      consultation: { current: null, canStartWalkIn: false, blockedReason: "referral_pending" },
    });
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
  });

  it("expired referral is handled correctly — Dr B is told it expired and sees nothing", async () => {
    const x = await patientX();
    const { data: short } = await admin
      .from("referrals")
      .insert({
        clinic_id: clinicA,
        patient_id: x.id,
        referring_doctor_id: doctors.a,
        referred_to_doctor_id: doctors.b,
        originating_appointment_id: x.consultation,
        reason: `Short-lived (${suffix})`,
        created_by: users.a,
        expires_at: new Date(Date.now() + 4_000).toISOString(),
      })
      .select("id")
      .single();
    await act("b", short!.id, { action: "accept" });
    expect(recordIds(ws(await workspace("b", x.id)))).toEqual(x.aRecords);

    await new Promise((r) => setTimeout(r, 4_500));

    const res = await workspace("b", x.id);
    expect(res).toMatchObject({ status: 410, body: { code: "referral_expired" } });
    expect(JSON.stringify(res.body)).not.toMatch(/Workspace patient|hypertension|HbA1c/);
    expect((await incoming("b")).map((r) => r.id)).not.toContain(short!.id);
    expect(await start("b", x.id, { serviceId: quickService })).toMatchObject({ status: 410, body: { code: "referral_expired" } });
    expect(await record("b", x.id, { appointmentId: x.consultation })).toMatchObject({ status: 410, body: { code: "referral_expired" } });
  });

  it("revoked referral is handled correctly — access to Dr A's records ends; Dr B's own consultation stays theirs", async () => {
    const x = await patientX();
    const referral = await refer(x);
    await act("b", referral, { action: "accept" });
    expect(recordIds(ws(await workspace("b", x.id)))).toEqual(x.aRecords);

    await act("a", referral, { action: "revoke", reason: "Patient transferred" });
    const res = await workspace("b", x.id);
    expect(res).toMatchObject({ status: 410, body: { code: "referral_revoked" } });
    expect(JSON.stringify(res.body)).not.toMatch(/hypertension|HbA1c|Workspace patient/);
    expect((await incoming("b")).map((r) => r.id)).not.toContain(referral);

    // Had Dr B already seen the patient, that consultation remains Dr B's own.
    const y = await patientX();
    const second = await refer(y);
    await act("b", second, { action: "accept" });
    const ownVisit = await visit(y.id, doctors.b, "in_progress");
    const ownRecord = await writeRecord("b", y.id, ownVisit);
    await act("a", second, { action: "revoke", reason: "Patient transferred" });
    const own = ws(await workspace("b", y.id));
    expect(own.relationship).toBe("own");
    expect(recordIds(own)).toEqual([ownRecord]);
  });

  it("clinical records are displayed according to authorization, with provenance", async () => {
    const x = await patientX();
    const referral = await refer(x);

    // Pending: only the records of the consultation the referral came from.
    expect(recordIds(ws(await workspace("b", x.id)))).toEqual([x.recConsultation]);

    // Accepted: Dr A's records, attributed to Dr A — never Dr E's.
    await act("b", referral, { action: "accept" });
    const accepted = ws(await workspace("b", x.id));
    expect(recordIds(accepted)).toEqual(x.aRecords);
    for (const r of accepted.records) {
      expect(r).toMatchObject({ mine: false, author: { id: doctors.a, name: `Dr A ${suffix}` }, createdAt: expect.any(String) });
    }
    expect(accepted.records.find((r) => r.id === x.recEarlier)).toMatchObject({ type: "diagnosis", summary: "Essential hypertension" });

    // Dr B's own consultation and record are Dr B's.
    const followUp = await visit(x.id, doctors.b, "in_progress");
    await admin.from("referrals").update({ follow_up_appointment_id: followUp }).eq("id", referral);
    const bRecord = await writeRecord("b", x.id, followUp, { recordType: "consultation_note", summary: "Echo booked; continue therapy" });
    const withOwn = ws(await workspace("b", x.id));
    expect(withOwn.consultation.current).toMatchObject({ appointmentId: followUp });
    expect(withOwn.records.find((r) => r.id === bRecord)).toMatchObject({ mine: true, author: { id: doctors.b }, appointmentId: followUp });

    // Dr A reads Dr B's reply on the follow-up; Dr E still only their own.
    expect(recordIds(ws(await workspace("a", x.id)))).toEqual([...x.aRecords, bRecord].sort());
    expect(recordIds(ws(await workspace("e", x.id)))).toEqual([x.recE]);

    // Completed: Dr B keeps their own record only.
    await act("b", referral, { action: "complete" });
    expect(recordIds(ws(await workspace("b", x.id)))).toEqual([bRecord]);

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
    // Correcting Dr A's record: Dr B may read it through the referral, but only its author may correct it.
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

  it("starts Dr B's own consultation — only once accepted, idempotently, linked to the referral", async () => {
    const x = await patientX();
    const referral = await refer(x);
    expect(await start("b", x.id, { serviceId: quickService })).toMatchObject({ status: 409, body: { code: "referral_not_accepted" } });
    await act("b", referral, { action: "accept" });

    if (minutesToClinicMidnight() < 15) {
      // A walk-in must end within today's working hours.
      expect(await start("b", x.id, { serviceId: quickService })).toMatchObject({ status: 422, body: { code: "INVALID_TIME", details: { reason: "outside_working_hours" } } });
      return;
    }

    const first = await start("b", x.id, { serviceId: quickService });
    expect(first.status).toBe(201);
    const appointmentId = (first.body.data!.consultation as { appointmentId: string }).appointmentId;
    const again = await start("b", x.id, { serviceId: quickService });
    expect(again).toMatchObject({ status: 200, body: { data: { consultation: { appointmentId, started: false } } } });

    const { data: appointment } = await admin.from("appointments").select("status, doctor_id, patient_id, source").eq("id", appointmentId).single();
    expect(appointment).toEqual({ status: "in_progress", doctor_id: doctors.b, patient_id: x.id, source: "walk_in" });
    const { data: linked } = await admin.from("referrals").select("follow_up_appointment_id").eq("id", referral).single();
    expect(linked!.follow_up_appointment_id).toBe(appointmentId);

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

    expect(ws(await workspace("b", x.id)).consultation.booked).toMatchObject({ appointmentId: booked });
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
    const { error } = await admin.from("referrals").insert({
      clinic_id: clinicA,
      patient_id: y.id,
      referring_doctor_id: doctors.a,
      referred_to_doctor_id: doctors.b,
      originating_appointment_id: y.consultation,
      reason: `Short-lived (${suffix})`,
      created_by: users.a,
      expires_at: new Date(Date.now() + 3_000).toISOString(),
    });
    expect(error).toBeNull();
    expect(await listed("b")).toContain(y.id);
    await new Promise((r) => setTimeout(r, 3_500));
    expect(await listed("b")).not.toContain(y.id);
  });

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

  it("a record from a consultation older than the visit window still comes with its consultation", async () => {
    const x = await patientX();
    const old = await visit(x.id, doctors.a, "completed", new Date(Date.UTC(2024, 0, 10, 5, 0)));
    const oldRecord = await writeRecord("a", x.id, old, { recordType: "medical_history", summary: "Appendectomy 2010" });
    const { error } = await admin.from("appointments").insert(
      Array.from({ length: 100 }, (_, i) => {
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

    const own = ws(await workspace("a", x.id));
    expect(own.records.map((r) => r.id)).toContain(oldRecord);
    expect(own.appointments.map((a) => a.id)).toContain(old);

    // Dr B, once accepted, sees it too — Dr E's visit still stays out.
    const referral = await refer(x);
    await act("b", referral, { action: "accept" });
    const referred = ws(await workspace("b", x.id));
    expect(referred.appointments.map((a) => a.id)).toContain(old);
    expect(referred.appointments.map((a) => a.id)).not.toContain(x.withE);
    expect(referred.records.map((r) => r.id)).not.toContain(x.recE);
  });
});

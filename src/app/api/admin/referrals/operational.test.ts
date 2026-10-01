import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import postgres from "postgres";
import { cleanupTestClinics } from "@/test/cleanup-clinics";
import { localDbAvailable } from "@/test/local-db";

/**
 * Referral controls workflow; the booking controls the treating relationship —
 * and management sees what no doctor can take. Through the REAL routes and
 * database:
 *
 *   GET /api/admin/appointments/referral-warnings   a visit booked for a
 *       referral that was revoked or declined STAYS (nothing cancels it, the
 *       doctor keeps the relationship it gives) and is flagged to reception
 *       (REFERRAL_REVOKED / REFERRAL_DECLINED) until it starts or is cancelled
 *   GET /api/admin/referrals/awaiting-doctor        department referrals nobody
 *       can take — owner/admin/manager only, this clinic only, no clinical text
 *   GET /api/admin/dashboard                        the count, for management only
 *
 * Mocked: the staff session lookup.
 */

const session = vi.hoisted(() => ({ ctx: null as unknown }));
vi.mock("@/lib/auth/staff", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/staff")>();
  return { ...actual, getStaffContext: async () => session.ctx };
});

import { GET as warningsRoute } from "@/app/api/admin/appointments/referral-warnings/route";
import { POST as reviewRoute } from "@/app/api/admin/appointments/[id]/referral-warning/route";
import { GET as awaitingRoute } from "./awaiting-doctor/route";
import { GET as dashboardRoute } from "@/app/api/admin/dashboard/route";

const DB_URL = process.env.SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const describeDb = describe.skipIf(!localDbAvailable());

type Json = { ok: boolean; data?: Record<string, unknown>; code?: string };

describeDb("referral booking warnings and the management overview — real routes, real database", () => {
  let sql: postgres.Sql;
  const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
  const clinicA = randomUUID();
  const clinicB = randomUUID();
  const service = randomUUID();
  const serviceB = randomUUID();
  const specialty = { general: randomUUID(), cardiology: randomUUID(), cardiologyB: randomUUID() };
  const profiles = { a: randomUUID(), b: randomUUID(), manager: randomUUID(), reception: randomUUID(), kref: randomUUID(), kdoc: randomUUID(), managerK: randomUUID() };
  const doctors = { a: randomUUID(), b: randomUUID(), kref: randomUUID(), kdoc: randomUUID() };
  const REASON = `Chest pain on exertion, ECG attached (${suffix})`;
  const NOTE = `Handoff note nobody on the front desk may read (${suffix})`;
  let day = 0;

  const asStaff = (profileId: string, clinicId: string, role: string) => {
    session.ctx = { profileId, clinicId, clinicName: "Operational", clinicTimezone: "Asia/Tashkent", roles: [role], platformAdmin: false };
  };
  const read = async (res: Response) => ({ status: res.status, body: (await res.json()) as Json });
  const get = (url: string) => new NextRequest(`http://localhost${url}`);

  async function visit(clinic: string, patient: string, doctor: string, status: string, svc = service) {
    const start = new Date(Date.UTC(2031, 0, 5, 5, 0) + day++ * 86_400_000);
    const [row] = await sql<{ id: string }[]>`
      insert into public.appointments ${sql({
        clinic_id: clinic, patient_id: patient, doctor_id: doctor, service_id: svc, start_at: start,
        end_at: new Date(start.getTime() + 30 * 60_000), status, source: "admin",
      })} returning id`;
    return row.id;
  }
  async function newPatient(clinic: string, name = `Operational patient ${suffix}`) {
    const [row] = await sql<{ id: string }[]>`insert into public.patients (clinic_id, full_name) values (${clinic}, ${name}) returning id`;
    return row.id;
  }
  /** A referral from `refDoctor` (raised from a completed visit of theirs); to a doctor or to a department. */
  async function refer(clinic: string, patient: string, refDoctor: string, refProfile: string, target: { doctor?: string; specialty?: string }, svc = service) {
    const origin = await visit(clinic, patient, refDoctor, "completed", svc);
    const [row] = await sql<{ id: string }[]>`
      insert into public.referrals
        (clinic_id, patient_id, referring_doctor_id, referred_to_doctor_id, referred_to_specialty_id, originating_appointment_id, reason, handoff_note, created_by)
      values (${clinic}, ${patient}, ${refDoctor}, ${target.doctor ?? null}, ${target.specialty ?? null}, ${origin}, ${REASON}, ${NOTE}, ${refProfile})
      returning id`;
    return row.id;
  }
  const link = (referral: string, appointment: string) => sql`update public.referrals set follow_up_appointment_id = ${appointment} where id = ${referral}`;
  const revoke = (referral: string, by: string) => sql`update public.referrals set status = 'revoked', revoked_by = ${by}, revoked_reason = 'Referred in error' where id = ${referral}`;
  const decline = (referral: string, by: string) =>
    sql`update public.referrals set status = 'declined', declined_by = ${by}, declined_reason = 'Not my field' where id = ${referral}`;
  async function warnings(ids: string[], as = () => asStaff(profiles.reception, clinicA, "receptionist")) {
    as();
    return read(await warningsRoute(get(`/api/admin/appointments/referral-warnings?ids=${ids.join(",")}`)));
  }
  const accessOf = async (doctor: string, patient: string) =>
    (await sql<{ own_patient: boolean; full_history: boolean }[]>`select own_patient, full_history from public.doctor_patient_access(${doctor}, ${patient})`)[0];
  const statusOf = async (appointment: string) => (await sql<{ status: string }[]>`select status from public.appointments where id = ${appointment}`)[0].status;

  beforeAll(async () => {
    sql = postgres(DB_URL, { max: 4, onnotice: () => {} });
    await sql`insert into public.clinics ${sql([
      { id: clinicA, name: `Operational A ${suffix}`, slug: `operational-a-${suffix}`, timezone: "Asia/Tashkent" },
      { id: clinicB, name: `Operational B ${suffix}`, slug: `operational-b-${suffix}`, timezone: "Asia/Tashkent" },
    ])}`;
    const users = Object.entries(profiles).map(([name, id]) => ({ id, email: `operational-${name}-${suffix}@test.local` }));
    await sql`insert into auth.users ${sql(users)}`;
    await sql`insert into public.profiles ${sql(users.map((u) => ({ id: u.id, full_name: u.email })))}`;
    await sql`insert into public.staff_roles ${sql([
      { clinic_id: clinicA, profile_id: profiles.a, role: "doctor" },
      { clinic_id: clinicA, profile_id: profiles.b, role: "doctor" },
      { clinic_id: clinicA, profile_id: profiles.manager, role: "manager" },
      { clinic_id: clinicA, profile_id: profiles.reception, role: "receptionist" },
      { clinic_id: clinicB, profile_id: profiles.kref, role: "doctor" },
      { clinic_id: clinicB, profile_id: profiles.kdoc, role: "doctor" },
      { clinic_id: clinicB, profile_id: profiles.managerK, role: "manager" },
    ])}`;
    await sql`insert into public.specialties ${sql([
      { id: specialty.general, clinic_id: clinicA, name: `Terapiya ${suffix}` },
      { id: specialty.cardiology, clinic_id: clinicA, name: `Kardiologiya ${suffix}` },
      { id: specialty.cardiologyB, clinic_id: clinicB, name: `Kardiologiya B ${suffix}` },
    ])}`;
    await sql`insert into public.doctors ${sql([
      { id: doctors.a, clinic_id: clinicA, profile_id: profiles.a, name: `Dr A ${suffix}`, active: true, specialty_id: specialty.general },
      { id: doctors.b, clinic_id: clinicA, profile_id: profiles.b, name: `Dr B ${suffix}`, active: true, specialty_id: specialty.cardiology },
      { id: doctors.kref, clinic_id: clinicB, profile_id: profiles.kref, name: `Dr KR ${suffix}`, active: true, specialty_id: null },
      { id: doctors.kdoc, clinic_id: clinicB, profile_id: profiles.kdoc, name: `Dr KD ${suffix}`, active: true, specialty_id: specialty.cardiologyB },
    ])}`;
    await sql`insert into public.services ${sql([
      { id: service, clinic_id: clinicA, name: `Operational consult ${suffix}`, duration_minutes: 30, price: 100000 },
      { id: serviceB, clinic_id: clinicB, name: `Operational B consult ${suffix}`, duration_minutes: 30, price: 100000 },
    ])}`;
    await sql`insert into public.doctor_working_hours ${sql(
      [[clinicA, doctors.a], [clinicA, doctors.b], [clinicB, doctors.kref], [clinicB, doctors.kdoc]].flatMap(([clinic, doctor]) =>
        [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ clinic_id: clinic, doctor_id: doctor, weekday, start_time: "00:00", end_time: "23:59" })),
      ),
    )}`;
  });

  afterAll(async () => {
    if (!sql) return;
    await cleanupTestClinics([clinicA, clinicB]);
    await sql`delete from auth.users where id in ${sql(Object.values(profiles))}`;
    await sql.end({ timeout: 5 });
  });

  it("a visit booked for a revoked referral STAYS, keeps the doctor's relationship, and reception is warned (REFERRAL_REVOKED)", async () => {
    const patient = await newPatient(clinicA);
    const referral = await refer(clinicA, patient, doctors.a, profiles.a, { doctor: doctors.b });
    const booking = await visit(clinicA, patient, doctors.b, "confirmed");
    await link(referral, booking);
    expect((await warnings([booking])).body.data).toEqual({ warnings: {} }); // the referral is open: nothing to warn about

    await revoke(referral, profiles.a);
    // The referral is over; the booking is not — it is not cancelled, and it still gives Dr B the patient.
    expect(await statusOf(booking)).toBe("confirmed");
    expect(await accessOf(doctors.b, patient)).toMatchObject({ own_patient: true, full_history: true });
    expect((await warnings([booking])).body.data).toEqual({ warnings: { [booking]: "REFERRAL_REVOKED" } });

    // Reception reviews and cancels: the warning goes with the visit.
    await sql`update public.appointments set status = 'cancelled', cancelled_at = now() where id = ${booking}`;
    expect((await warnings([booking])).body.data).toEqual({ warnings: {} });
    // …and with the booking cancelled (the referral long over) the relationship is gone too.
    expect(await accessOf(doctors.b, patient)).toMatchObject({ own_patient: false, full_history: false });
  });

  it("\"I've reviewed this\": the warning is dismissed, who and when are recorded and audited, and the booking is left exactly as it was", async () => {
    const patient = await newPatient(clinicA);
    const referral = await refer(clinicA, patient, doctors.a, profiles.a, { doctor: doctors.b });
    const booking = await visit(clinicA, patient, doctors.b, "confirmed");
    await link(referral, booking);
    const review = async (id: string, as = () => asStaff(profiles.reception, clinicA, "receptionist")) => {
      as();
      return read(await reviewRoute(new NextRequest(`http://localhost/api/admin/appointments/${id}/referral-warning`, { method: "POST" }), { params: Promise.resolve({ id }) }));
    };
    const snapshot = async () =>
      (await sql`select status, start_at, end_at, doctor_id, service_id, patient_id, notes from public.appointments where id = ${booking}`)[0];
    const reviewedAudits = () => sql<{ actor_id: string; referral_id: string }[]>`
      select actor_id, referral_id from public.audit_events where action = 'referral_warning_reviewed' and entity_id = ${booking}`;

    // Nothing to review while the referral is open.
    expect((await review(booking)).status).toBe(409);

    await revoke(referral, profiles.a);
    expect((await warnings([booking])).body.data).toEqual({ warnings: { [booking]: "REFERRAL_REVOKED" } });
    const before = await snapshot();

    // A doctor cannot dismiss it; another clinic's staff cannot even find the visit.
    expect((await review(booking, () => asStaff(profiles.b, clinicA, "doctor"))).status).toBe(403);
    expect((await review(booking, () => asStaff(profiles.managerK, clinicB, "manager"))).status).toBe(404);
    expect((await warnings([booking])).body.data).toEqual({ warnings: { [booking]: "REFERRAL_REVOKED" } });

    // Reception reviews: the warning goes, the booking stays intact, Dr B still has the patient through it.
    expect(await review(booking)).toMatchObject({ status: 200, body: { data: { reviewed: true, already: false } } });
    expect((await warnings([booking])).body.data).toEqual({ warnings: {} });
    expect(await snapshot()).toEqual(before);
    expect(await accessOf(doctors.b, patient)).toMatchObject({ own_patient: true, full_history: true });
    expect(await sql`select referral_warning_reviewed_by from public.appointments where id = ${booking} and referral_warning_reviewed_at is not null`).toEqual([
      { referral_warning_reviewed_by: profiles.reception },
    ]);
    // Audited once, as the receptionist, with the referral — ids only.
    expect(await reviewedAudits()).toEqual([{ actor_id: profiles.reception, referral_id: referral }]);

    // Repeating it changes and audits nothing more.
    expect(await review(booking)).toMatchObject({ status: 200, body: { data: { already: true } } });
    expect(await reviewedAudits()).toHaveLength(1);

    // Management may dismiss one too — but a warning that is not there cannot be reviewed.
    const other = await visit(clinicA, patient, doctors.b, "confirmed");
    expect((await review(other, () => asStaff(profiles.manager, clinicA, "manager"))).status).toBe(409);

    // The review only covers what happened before it: a referral that ended AFTER the review warns again.
    await sql`update public.appointments set referral_warning_reviewed_at = now() - interval '1 day' where id = ${booking}`;
    expect((await warnings([booking])).body.data).toEqual({ warnings: { [booking]: "REFERRAL_REVOKED" } });
  });

  it("a declined referral warns as REFERRAL_DECLINED — until the visit starts; and only this clinic's appointments are ever looked at", async () => {
    const patient = await newPatient(clinicA);
    const referral = await refer(clinicA, patient, doctors.a, profiles.a, { doctor: doctors.b });
    const booking = await visit(clinicA, patient, doctors.b, "pending");
    await link(referral, booking);
    await decline(referral, profiles.b);
    expect(await statusOf(booking)).toBe("pending");
    expect((await warnings([booking])).body.data).toEqual({ warnings: { [booking]: "REFERRAL_DECLINED" } });

    // Another clinic's reception never learns anything about this appointment.
    const foreign = await warnings([booking], () => asStaff(profiles.managerK, clinicB, "manager"));
    expect(foreign.body.data).toEqual({ warnings: {} });
    // Junk ids are ignored; the request still answers.
    expect((await warnings(["not-a-uuid", booking])).body.data).toEqual({ warnings: { [booking]: "REFERRAL_DECLINED" } });

    // Once the visit is under way there is nothing left to review.
    await sql`update public.appointments set status = 'in_progress' where id = ${booking}`;
    expect((await warnings([booking])).body.data).toEqual({ warnings: {} });
  });

  it("the overview lists department referrals nobody can take — management only, this clinic only, never the clinical text", async () => {
    const patient = await newPatient(clinicA, `Kutayotgan Bemor ${suffix}`);
    const referral = await refer(clinicA, patient, doctors.a, profiles.a, { specialty: specialty.cardiology });
    // Another clinic has one awaiting referral of its own.
    const foreignPatient = await newPatient(clinicB);
    await refer(clinicB, foreignPatient, doctors.kref, profiles.kref, { specialty: specialty.cardiologyB }, serviceB);
    const overview = async (as = () => asStaff(profiles.manager, clinicA, "manager")) => {
      as();
      return read(await awaitingRoute());
    };

    // Dr B can take it: not awaiting.
    expect((await overview()).body.data).toMatchObject({ total: 0, departments: [], referrals: [] });

    // The department's only doctor leaves: it is awaiting.
    await sql`update public.doctors set active = false where id = ${doctors.b}`;
    try {
      const listed = await overview();
      expect(listed.status).toBe(200);
      expect(listed.body.data).toMatchObject({
        total: 1,
        departments: [{ id: specialty.cardiology, name: `Kardiologiya ${suffix}`, count: 1 }],
        referrals: [{ id: referral, patientName: `Kutayotgan Bemor ${suffix}`, referringDoctor: `Dr A ${suffix}`, department: { id: specialty.cardiology }, priority: "routine" }],
      });
      // Metadata only: no reason, no handoff note, in any shape.
      const text = JSON.stringify(listed.body);
      expect(text).not.toContain(REASON);
      expect(text).not.toContain(NOTE);
      expect(text).not.toMatch(/"(reason|handoffNote|handoff_note)"/);

      // The clinic that is not this one sees only its own; a receptionist and a doctor see nothing of it.
      const other = await overview(() => asStaff(profiles.managerK, clinicB, "manager"));
      expect(other.body.data).toMatchObject({ total: 0 });
      expect((await overview(() => asStaff(profiles.reception, clinicA, "receptionist"))).status).toBe(403);
      expect((await overview(() => asStaff(profiles.a, clinicA, "doctor"))).status).toBe(403);

      // The dashboard shows the count to management and to nobody else.
      asStaff(profiles.manager, clinicA, "manager");
      expect((await read(await dashboardRoute())).body.data).toMatchObject({ referrals_awaiting_doctor: 1 });
      asStaff(profiles.reception, clinicA, "receptionist");
      expect((await read(await dashboardRoute())).body.data).toMatchObject({ referrals_awaiting_doctor: null });
    } finally {
      await sql`update public.doctors set active = true where id = ${doctors.b}`;
    }
    // The doctor is back (or a new one is staffed): the referral reaches them by itself and is no longer awaiting.
    expect((await overview()).body.data).toMatchObject({ total: 0 });
    await revoke(referral, profiles.a);
  });
});

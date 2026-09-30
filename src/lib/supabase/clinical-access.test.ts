import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { withoutGlobalSweeps } from "@/test/referral-sweep-lock";

/**
 * Longitudinal clinical access — the DATABASE layer
 * (supabase/migrations/20261002000001_longitudinal_history.sql):
 * public.doctor_patient_access() and the patients/appointments/payments RLS
 * policies built on it, exercised directly against Postgres.
 *
 * The decision gives an active doctor-role doctor of the patient's clinic
 * one row, and the patient's WHOLE clinical history in the clinic — every
 * doctor's visits — for a legitimate clinical relationship: a treating
 * relationship (any appointment with the patient that was not cancelled, or
 * a record the doctor wrote) or an open, unexpired referral to them or,
 * while nobody has taken it, to their department — from the moment the
 * referral is created. Without one, nothing; across clinics, not even a row.
 * No doctor reads payment rows.
 *
 * Doctor sessions are simulated the way PostgREST runs every request:
 * `set local role authenticated` plus the JWT claims auth.uid() reads. So
 * every "as doctor" read below is exactly what a doctor gets when they call
 * the Supabase REST API directly with their own token — no app code in
 * between. Server writes run as service_role, like the app's admin client.
 *
 * Cast: Dr A sees patient X (their own patient), Dr E also saw X (a treating
 * doctor too), Dr B is the doctor X is referred to and Dr B2 their colleague
 * in cardiology, Dr C works in the same clinic (another department) with no
 * relationship to X, Dr K works in another clinic.
 *
 * Connects with SUPABASE_DB_URL (default: the Supabase CLI local database);
 * skips with a warning when the database or the migration is missing.
 */

const DB_URL = process.env.SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

async function probeDatabase(): Promise<string | null> {
  const probe = postgres(DB_URL, { max: 1, connect_timeout: 3, onnotice: () => {} });
  try {
    const [row] = await probe<{ has_access_fn: boolean; can_switch_roles: boolean }[]>`
      select
        to_regprocedure('public.doctor_patient_access(uuid, uuid)') is not null as has_access_fn,
        pg_has_role(current_user, 'anon', 'MEMBER')
          and pg_has_role(current_user, 'authenticated', 'MEMBER')
          and pg_has_role(current_user, 'service_role', 'MEMBER') as can_switch_roles`;
    if (!row.has_access_fn) return "clinical access migration not applied — run `npm run db:reset-local`";
    if (!row.can_switch_roles) return "database user cannot switch to anon/authenticated/service_role";
    return null;
  } catch (e) {
    return `database unreachable via SUPABASE_DB_URL — ${e instanceof Error ? e.message : String(e)}`;
  } finally {
    await probe.end({ timeout: 1 });
  }
}

const unavailable = await probeDatabase();
if (unavailable) {
  process.stderr.write(`\n⚠️  clinical access database suite SKIPPED (${unavailable})\n\n`);
}

const describeDb = describe.skipIf(unavailable !== null);

type Tx = postgres.TransactionSql;
type Values = Record<string, unknown>;
type Access = {
  clinic_id: string;
  own_patient: boolean;
  active_referral_ids: string[];
  full_history: boolean;
};

async function pgError(run: () => Promise<unknown>): Promise<postgres.PostgresError> {
  try {
    await run();
  } catch (e) {
    if (e instanceof postgres.PostgresError) return e;
    throw e;
  }
  throw new Error("expected the database to reject the statement");
}

const ROLLBACK = Symbol("rollback");

describeDb("longitudinal clinical access — database layer (doctor_patient_access + RLS)", () => {
  let sql: postgres.Sql;
  const suffix = Date.now().toString(36);
  const clinicA = randomUUID();
  const clinicB = randomUUID();
  const serviceA = randomUUID();
  const serviceB = randomUUID();
  const cardiology = randomUUID();
  const general = randomUUID();

  const profiles = {
    a: randomUUID(),
    b: randomUUID(),
    b2: randomUUID(),
    c: randomUUID(),
    e: randomUUID(),
    k: randomUUID(),
    receptionist: randomUUID(),
    manager: randomUUID(),
  };
  const doctors = { a: randomUUID(), b: randomUUID(), b2: randomUUID(), c: randomUUID(), e: randomUUID(), k: randomUUID() };
  let day = 0;

  async function as<T>(role: "anon" | "authenticated" | "service_role", sub: string | null, run: (tx: Tx) => Promise<T>): Promise<T> {
    return (await sql.begin(async (tx) => {
      await tx.unsafe(`set local role ${role}`);
      await tx`select set_config('request.jwt.claims', ${JSON.stringify(sub ? { sub, role } : { role })}, true)`;
      return run(tx);
    })) as T;
  }
  const asServer = <T>(run: (tx: Tx) => Promise<T>) => as("service_role", null, run);
  const asUser = <T>(profileId: string, run: (tx: Tx) => Promise<T>) => as("authenticated", profileId, run);

  async function newPatient(clinicId = clinicA): Promise<string> {
    const id = randomUUID();
    await sql`insert into public.patients (id, clinic_id, full_name, phone) values (${id}, ${clinicId}, ${`Access patient ${suffix}`}, '+998900000000')`;
    return id;
  }

  /**
   * A visit of `patient` with `doctor` — completed unless stated — on its own
   * day so slots never collide: a past day, or one ahead for a booking.
   */
  async function visit(patient: string, doctor: string, clinicId = clinicA, status = "completed", when: "past" | "booked" = "past", source = "walk_in"): Promise<string> {
    const base = when === "past" ? Date.UTC(2026, 0, 5, 5, 0) : Date.UTC(new Date().getUTCFullYear() + 2, 0, 5, 5, 0);
    const start = new Date(base + day++ * 86_400_000);
    const [row] = await sql<{ id: string }[]>`
      insert into public.appointments ${sql({
        clinic_id: clinicId,
        patient_id: patient,
        doctor_id: doctor,
        service_id: clinicId === clinicA ? serviceA : serviceB,
        start_at: start,
        end_at: new Date(start.getTime() + 30 * 60_000),
        status,
        source,
      })}
      returning id`;
    return row.id;
  }

  /** Patient X: Dr A's patient (two visits) who also saw Dr E once. */
  async function patientX() {
    const id = await newPatient();
    const consultation = await visit(id, doctors.a);
    const earlierWithA = await visit(id, doctors.a);
    const withE = await visit(id, doctors.e);
    return { id, consultation, withE, all: [consultation, earlierWithA, withE].sort() };
  }

  function refer(patient: string, consultation: string, overrides: Values = {}) {
    return asServer(async (tx) => {
      const [row] = await tx<{ id: string }[]>`insert into public.referrals ${tx({
        clinic_id: clinicA,
        patient_id: patient,
        referring_doctor_id: doctors.a,
        referred_to_doctor_id: doctors.b,
        originating_appointment_id: consultation,
        reason: `Access test referral (${suffix})`,
        priority: "routine",
        created_by: profiles.a,
        ...overrides,
      })} returning id`;
      return row.id;
    });
  }

  const transition = (id: string, patch: Values) =>
    asServer((tx) => tx`update public.referrals set ${tx(patch)} where id = ${id}`);
  const accept = (id: string) => transition(id, { status: "accepted", accepted_by: profiles.b });
  /** Dr B's consultation for the referral starts: linked as its follow-up, the referral is in progress. */
  async function startHandoff(id: string, patient: string): Promise<string> {
    const consultation = await visit(patient, doctors.b, clinicA, "in_progress");
    await transition(id, { follow_up_appointment_id: consultation });
    return consultation;
  }
  const revoke = (id: string, by = profiles.a) =>
    transition(id, { status: "revoked", revoked_by: by, revoked_reason: "No longer needed" });

  /** A clinical record `doctor` wrote in their own consultation (server-side, like the app). */
  const writeRecord = (doctor: keyof typeof doctors, patient: string, consultation: string) =>
    asServer((tx) => tx`insert into public.clinical_records ${tx({
      clinic_id: clinicA,
      patient_id: patient,
      author_doctor_id: doctors[doctor],
      appointment_id: consultation,
      record_type: "consultation_note",
      summary: `Access test note (${suffix})`,
      created_by: profiles[doctor],
    })}`);

  async function access(doctorId: string, patientId: string): Promise<Access | null> {
    const rows = await asServer((tx) => tx<Access[]>`select * from public.doctor_patient_access(${doctorId}, ${patientId})`);
    return rows[0] ?? null;
  }

  /** What `profileId` gets through RLS: patients, appointments and payments of `patientId`. */
  async function seenBy(profileId: string, patientId: string) {
    return asUser(profileId, async (tx) => ({
      patient: (await tx`select id from public.patients where id = ${patientId}`).length === 1,
      appointments: (await tx<{ id: string }[]>`select id from public.appointments where patient_id = ${patientId}`)
        .map((r) => r.id)
        .sort(),
      payments: (await tx`select id from public.payments where patient_id = ${patientId}`).length,
    }));
  }

  const nothing = { patient: false, appointments: [], payments: 0 };
  /** What a doctor with full history reads: the patient and every one of their appointments — never a payment row. */
  const wholeHistory = (...appointmentIds: string[]) => ({ patient: true, appointments: appointmentIds.sort(), payments: 0 });

  /** The decision for a doctor of clinic A: no relationship, their own patient (with any open referrals), or open referrals only. */
  const noRelationship: Access = { clinic_id: clinicA, own_patient: false, active_referral_ids: [], full_history: false };
  const ownPatient = (...referralIds: string[]): Access => ({ clinic_id: clinicA, own_patient: true, active_referral_ids: referralIds, full_history: true });
  const referredOnly = (...referralIds: string[]): Access => ({ clinic_id: clinicA, own_patient: false, active_referral_ids: referralIds, full_history: true });

  beforeAll(async () => {
    sql = postgres(DB_URL, { max: 4, onnotice: () => {} });

    await sql`insert into public.clinics ${sql([
      { id: clinicA, name: `Access Clinic A ${suffix}`, slug: `access-a-${suffix}`, timezone: "Asia/Tashkent" },
      { id: clinicB, name: `Access Clinic B ${suffix}`, slug: `access-b-${suffix}`, timezone: "Asia/Tashkent" },
    ])}`;
    const users = Object.entries(profiles).map(([name, id]) => ({ id, email: `access-${name}-${suffix}@test.local` }));
    await sql`insert into auth.users ${sql(users)}`;
    await sql`insert into public.profiles ${sql(users.map((u) => ({ id: u.id, full_name: u.email })))}`;
    await sql`insert into public.staff_roles ${sql([
      { clinic_id: clinicA, profile_id: profiles.a, role: "doctor" },
      { clinic_id: clinicA, profile_id: profiles.b, role: "doctor" },
      { clinic_id: clinicA, profile_id: profiles.b2, role: "doctor" },
      { clinic_id: clinicA, profile_id: profiles.c, role: "doctor" },
      { clinic_id: clinicA, profile_id: profiles.e, role: "doctor" },
      { clinic_id: clinicA, profile_id: profiles.receptionist, role: "receptionist" },
      { clinic_id: clinicA, profile_id: profiles.manager, role: "manager" },
      { clinic_id: clinicB, profile_id: profiles.k, role: "doctor" },
    ])}`;
    await sql`insert into public.specialties ${sql([
      { id: cardiology, clinic_id: clinicA, name: `Access cardiology ${suffix}` },
      { id: general, clinic_id: clinicA, name: `Access general ${suffix}` },
    ])}`;
    await sql`insert into public.doctors ${sql([
      { id: doctors.a, clinic_id: clinicA, profile_id: profiles.a, name: `Dr A ${suffix}`, specialty_id: null, active: true },
      { id: doctors.b, clinic_id: clinicA, profile_id: profiles.b, name: `Dr B ${suffix}`, specialty_id: cardiology, active: true },
      { id: doctors.b2, clinic_id: clinicA, profile_id: profiles.b2, name: `Dr B2 ${suffix}`, specialty_id: cardiology, active: true },
      { id: doctors.c, clinic_id: clinicA, profile_id: profiles.c, name: `Dr C ${suffix}`, specialty_id: general, active: true },
      { id: doctors.e, clinic_id: clinicA, profile_id: profiles.e, name: `Dr E ${suffix}`, specialty_id: null, active: true },
      { id: doctors.k, clinic_id: clinicB, profile_id: profiles.k, name: `Dr K ${suffix}`, specialty_id: null, active: true },
    ])}`;
    await sql`insert into public.services ${sql([
      { id: serviceA, clinic_id: clinicA, name: `Access consult A ${suffix}`, duration_minutes: 30, price: 100000 },
      { id: serviceB, clinic_id: clinicB, name: `Access consult B ${suffix}`, duration_minutes: 30, price: 100000 },
    ])}`;
    const hours = Object.entries(doctors).flatMap(([key, doctorId]) =>
      [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({
        clinic_id: key === "k" ? clinicB : clinicA,
        doctor_id: doctorId,
        weekday,
        start_time: "00:00",
        end_time: "23:59",
      })),
    );
    await sql`insert into public.doctor_working_hours ${sql(hours)}`;
  });

  afterAll(async () => {
    if (!sql) return;
    const clinics = [clinicA, clinicB];
    await sql`delete from public.clinical_records where clinic_id in ${sql(clinics)}`;
    await sql`delete from public.referrals where clinic_id in ${sql(clinics)}`;
    await sql`delete from public.payments where clinic_id in ${sql(clinics)}`;
    await sql`delete from public.appointments where clinic_id in ${sql(clinics)}`;
    await sql`delete from public.staff_roles where clinic_id in ${sql(clinics)}`;
    await sql`delete from public.doctors where clinic_id in ${sql(clinics)}`;
    await sql`delete from public.patients where clinic_id in ${sql(clinics)}`;
    await sql`delete from public.services where clinic_id in ${sql(clinics)}`;
    await sql`delete from public.clinics where id in ${sql(clinics)}`;
    await sql`delete from auth.users where id in ${sql(Object.values(profiles))}`;
    await sql.end({ timeout: 5 });
  });

  it("1. Doctor A sees their own patient's whole history — every doctor's visits — but no payment row, not even their own visit's", async () => {
    const x = await patientX();
    await asServer((tx) => tx`insert into public.payments ${tx({ clinic_id: clinicA, appointment_id: x.consultation, patient_id: x.id, amount: 100000 })}`);

    expect(await access(doctors.a, x.id)).toEqual(ownPatient());
    // The patient record and every visit — Dr E's too. The payment of Dr A's
    // own consultation stays out of reach: no doctor reads payment rows.
    expect(await seenBy(profiles.a, x.id)).toEqual(wholeHistory(...x.all));
    // The payment row is there: operational staff read it.
    expect(await seenBy(profiles.receptionist, x.id)).toEqual({ patient: true, appointments: x.all, payments: 1 });
  });

  it("2. Doctor B sees the whole history of a patient referred to them — from the referral's creation, no acceptance needed", async () => {
    const x = await patientX();
    await asServer((tx) => tx`insert into public.payments ${tx({ clinic_id: clinicA, appointment_id: x.consultation, patient_id: x.id, amount: 100000 })}`);
    const referral = await refer(x.id, x.consultation);

    // Pending: Dr A's visits and Dr E's at once, without anyone's approval —
    // never payments.
    expect(await access(doctors.b, x.id)).toEqual(referredOnly(referral));
    expect(await seenBy(profiles.b, x.id)).toEqual(wholeHistory(...x.all));

    // Accepted: the same — acceptance is a care step, never a gate on the history.
    await accept(referral);
    expect(await access(doctors.b, x.id)).toEqual(referredOnly(referral));
    expect(await seenBy(profiles.b, x.id)).toEqual(wholeHistory(...x.all));
  });

  it("3. Doctor C cannot access that patient when not referred", async () => {
    const x = await patientX();
    const referral = await refer(x.id, x.consultation);
    await accept(referral);

    // Same clinic, doctor role, no relationship: a decision row without history…
    expect(await access(doctors.c, x.id)).toEqual(noRelationship);
    // …and RLS shows nothing — not the patient, not a visit; the referral
    // itself is never readable directly by any signed-in session.
    expect(await seenBy(profiles.c, x.id)).toEqual(nothing);
    expect((await pgError(() => asUser(profiles.c, (tx) => tx`select id from public.referrals where id = ${referral}`))).code).toBe("42501");
  });

  it("4. Doctor B loses access at the referral's expiry — pending or accepted — when it was their only link, before any sweep records it", async () => {
    await withoutGlobalSweeps(async () => {
      const pendingX = await patientX();
      const acceptedX = await patientX();
      // Both expire in three seconds (the DB clock); one is accepted before that.
      const [pendingReferral, acceptedReferral] = await asServer(async (tx) => {
        const [{ soon }] = await tx<{ soon: Date }[]>`select now() + interval '3 seconds' as soon`;
        const ids: string[] = [];
        for (const x of [pendingX, acceptedX]) {
          const [row] = await tx<{ id: string }[]>`insert into public.referrals ${tx({
            clinic_id: clinicA,
            patient_id: x.id,
            referring_doctor_id: doctors.a,
            referred_to_doctor_id: doctors.b,
            originating_appointment_id: x.consultation,
            reason: `Short-lived referral (${suffix})`,
            priority: "routine",
            created_by: profiles.a,
            expires_at: soon,
          })} returning id`;
          ids.push(row.id);
        }
        return ids;
      });
      await accept(acceptedReferral);
      expect(await access(doctors.b, pendingX.id)).toEqual(referredOnly(pendingReferral));
      expect(await seenBy(profiles.b, pendingX.id)).toEqual(wholeHistory(...pendingX.all));
      expect(await access(doctors.b, acceptedX.id)).toEqual(referredOnly(acceptedReferral));
      expect(await seenBy(profiles.b, acceptedX.id)).toEqual(wholeHistory(...acceptedX.all));

      // Wait out the validity on the database's clock.
      const [{ ms }] = await sql<{ ms: number }[]>`
        select ceil(extract(epoch from (max(expires_at) - now())) * 1000)::int as ms
        from public.referrals where id in ${sql([pendingReferral, acceptedReferral])}`;
      await new Promise((r) => setTimeout(r, Math.max(ms, 0) + 300));

      // Still stored as pending and accepted (no sweep has run), yet access has ended.
      const stored = await sql<{ id: string; status: string }[]>`
        select id, status from public.referrals where id in ${sql([pendingReferral, acceptedReferral])}`;
      expect(Object.fromEntries(stored.map((r) => [r.id, r.status]))).toEqual({ [pendingReferral]: "pending", [acceptedReferral]: "accepted" });
      for (const x of [pendingX, acceptedX]) {
        expect(await access(doctors.b, x.id)).toEqual(noRelationship);
        expect(await seenBy(profiles.b, x.id)).toEqual(nothing);
      }
    });
  }, 20_000);

  it("5. Doctor B loses access when a referral that was their only link is revoked or declined", async () => {
    // Revoked by the referring doctor or by clinic management — accepted, or still pending.
    for (const [revoker, acceptFirst] of [
      [profiles.a, true],
      [profiles.manager, true],
      [profiles.a, false],
    ] as const) {
      const x = await patientX();
      const referral = await refer(x.id, x.consultation);
      if (acceptFirst) await accept(referral);
      expect(await seenBy(profiles.b, x.id)).toEqual(wholeHistory(...x.all));

      await revoke(referral, revoker);
      expect(await access(doctors.b, x.id)).toEqual(noRelationship);
      expect(await seenBy(profiles.b, x.id)).toEqual(nothing);
    }

    // Declined: the pending referral showed the whole history; declining ends it at once.
    const declinedX = await patientX();
    const declined = await refer(declinedX.id, declinedX.consultation);
    expect(await seenBy(profiles.b, declinedX.id)).toEqual(wholeHistory(...declinedX.all));
    await transition(declined, { status: "declined", declined_by: profiles.b });
    expect(await access(doctors.b, declinedX.id)).toEqual(noRelationship);
    expect(await seenBy(profiles.b, declinedX.id)).toEqual(nothing);
  });

  it("5b. completing the referral ends referral-based access: Dr B keeps the whole history through their own consultation — not once that visit is cancelled", async () => {
    const x = await patientX();
    const referral = await refer(x.id, x.consultation);
    await accept(referral);
    const followUp = await startHandoff(referral, x.id);
    // In progress: Dr B's own consultation is under way, beside the open referral.
    expect(await access(doctors.b, x.id)).toEqual(ownPatient(referral));
    expect(await seenBy(profiles.b, x.id)).toEqual(wholeHistory(...x.all, followUp));

    // Completed: the referral no longer counts; Dr B's own consultation keeps
    // X theirs, with the whole history — Dr A's and Dr E's visits included.
    await transition(referral, { status: "completed", completed_by: profiles.b });
    expect(await access(doctors.b, x.id)).toEqual(ownPatient());
    expect(await seenBy(profiles.b, x.id)).toEqual(wholeHistory(...x.all, followUp));

    // Completed without an own visit — Dr B's consultation was cancelled — leaves Dr B nothing.
    const y = await patientX();
    const referralY = await refer(y.id, y.consultation);
    await accept(referralY);
    const cancelledFollowUp = await startHandoff(referralY, y.id);
    await sql`update public.appointments set status = 'cancelled' where id = ${cancelledFollowUp}`;
    expect(await access(doctors.b, y.id)).toEqual(referredOnly(referralY));
    await transition(referralY, { status: "completed", completed_by: profiles.b });
    expect(await access(doctors.b, y.id)).toEqual(noRelationship);
    expect(await seenBy(profiles.b, y.id)).toEqual(nothing);
  });

  it("6. Doctor B cannot access patients from another clinic", async () => {
    const z = await newPatient(clinicB);
    const zVisit = await visit(z, doctors.k, clinicB);

    // No decision row at all across clinics.
    expect(await access(doctors.b, z)).toBeNull();
    expect(await seenBy(profiles.b, z)).toEqual(nothing);

    // Nor the other way round: Dr K (clinic B) never sees clinic A's referred patient.
    const x = await patientX();
    await accept(await refer(x.id, x.consultation));
    expect(await access(doctors.k, x.id)).toBeNull();
    expect(await seenBy(profiles.k, x.id)).toEqual(nothing);

    // A doctor record in clinic B linked to Dr B's account, without the
    // doctor role there, grants nothing either — even with a visit on it.
    const bInB = randomUUID();
    await sql`insert into public.doctors ${sql({ id: bInB, clinic_id: clinicB, profile_id: profiles.b, name: `Dr B in B ${suffix}`, active: true })}`;
    await sql`insert into public.doctor_working_hours ${sql(
      [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ clinic_id: clinicB, doctor_id: bInB, weekday, start_time: "00:00", end_time: "23:59" })),
    )}`;
    await visit(z, bInB, clinicB);
    expect(await access(bInB, z)).toBeNull();
    expect(await seenBy(profiles.b, z)).toEqual(nothing);
    expect(zVisit).toBeTruthy();
  });

  it("7. A doctor cannot modify another doctor's referral unless authorized", async () => {
    const x = await patientX();
    const referral = await refer(x.id, x.consultation);

    // No signed-in role can write referrals at all — not a bystander, not
    // the receiving doctor, not even the referring doctor.
    for (const profileId of [profiles.c, profiles.b, profiles.a]) {
      const update = await pgError(() =>
        asUser(profileId, (tx) => tx`update public.referrals set status = 'accepted', accepted_by = ${profileId} where id = ${referral}`),
      );
      expect(update.code).toBe("42501");
      const del = await pgError(() => asUser(profileId, (tx) => tx`delete from public.referrals where id = ${referral}`));
      expect(del.code).toBe("42501");
    }
    const insert = await pgError(() =>
      asUser(profiles.c, (tx) => tx`insert into public.referrals ${tx({
        clinic_id: clinicA,
        patient_id: x.id,
        referring_doctor_id: doctors.a,
        referred_to_doctor_id: doctors.c,
        originating_appointment_id: x.consultation,
        reason: "Forged",
        created_by: profiles.a,
      })}`),
    );
    expect(insert.code).toBe("42501");

    // Even server writes must name an authorized actor.
    const acceptedByC = await pgError(() => transition(referral, { status: "accepted", accepted_by: profiles.c }));
    expect(acceptedByC.message).toMatch(/only the receiving doctor/);
    const revokedByC = await pgError(() => revoke(referral, profiles.c));
    expect(revokedByC.message).toMatch(/only the referring doctor or clinic management can revoke/);
    const acceptedByA = await pgError(() => transition(referral, { status: "accepted", accepted_by: profiles.a }));
    expect(acceptedByA.message).toMatch(/only the receiving doctor/);

    const [{ status }] = await sql<{ status: string }[]>`select status from public.referrals where id = ${referral}`;
    expect(status).toBe("pending");
  });

  it("8. Patient IDs cannot be swapped to bypass authorization", async () => {
    const x = await patientX();
    const y = await newPatient();
    const yVisit = await visit(y, doctors.a);
    const referral = await refer(x.id, x.consultation);
    await accept(referral);
    const ownVisitOfB = await visit(await newPatient(), doctors.b);

    // The referral opens X's whole history, never Dr A's other patient Y.
    expect(await seenBy(profiles.b, x.id)).toEqual(wholeHistory(...x.all));
    expect(await access(doctors.b, y)).toEqual(noRelationship);
    expect(await seenBy(profiles.b, y)).toEqual(nothing);
    // Made-up ids get no decision row at all.
    expect(await access(randomUUID(), x.id)).toBeNull();
    expect(await access(doctors.b, randomUUID())).toBeNull();

    // Re-pointing Dr B's own appointment at Y to become "Y's doctor" changes nothing…
    // (No signed-in token writes appointments at all: 20260930000002_server_only_booking_writes.)
    const swapped = await pgError(() => asUser(profiles.b, (tx) => tx`update public.appointments set patient_id = ${y} where id = ${ownVisitOfB} returning id`));
    expect(swapped.code).toBe("42501");
    const [{ patient_id: stillOwner }] = await sql<{ patient_id: string }[]>`select patient_id from public.appointments where id = ${ownVisitOfB}`;
    expect(stillOwner).not.toBe(y);
    // …Dr A's appointments Dr B can read through the referral stay read-only…
    const touched = await pgError(() => asUser(profiles.b, (tx) => tx`update public.appointments set status = 'completed' where id = ${x.consultation} returning id`));
    expect(touched.code).toBe("42501");
    // …and the referral's own patient can't be rewritten to another patient.
    const repoint = await pgError(() => transition(referral, { patient_id: y }));
    expect(repoint.code).toMatch(/23503|P0001/);
    expect(await seenBy(profiles.b, y)).toEqual(nothing);
    expect(yVisit).toBeTruthy();
  });

  it("9. Direct API access is denied without referral", async () => {
    const x = await patientX();

    // A doctor's own token, straight at the tables and the decision function.
    expect(await seenBy(profiles.c, x.id)).toEqual(nothing);
    const probe = await pgError(() =>
      asUser(profiles.c, (tx) => tx`select * from public.doctor_patient_access(${doctors.a}, ${x.id})`),
    );
    expect(probe.code).toBe("42501");
    // The caller-scoped helpers only ever answer for the caller — and for an
    // appointment exactly as for its patient: the appointment's doctor and id
    // no longer narrow it (not even a made-up one).
    const helpers = (profileId: string) =>
      asUser(profileId, (tx) => tx<{ patient: boolean; appointment: boolean; any_appointment: boolean }[]>`
        select public.doctor_can_read_patient(${clinicA}, ${x.id}) as patient,
               public.doctor_can_read_appointment(${clinicA}, ${x.id}, ${doctors.e}, ${x.withE}) as appointment,
               public.doctor_can_read_appointment(${clinicA}, ${x.id}, ${randomUUID()}, ${randomUUID()}) as any_appointment`);
    expect(await helpers(profiles.c)).toEqual([{ patient: false, appointment: false, any_appointment: false }]);
    expect(await helpers(profiles.a)).toEqual([{ patient: true, appointment: true, any_appointment: true }]);

    // Without any token: no table access whatsoever.
    for (const table of ["patients", "appointments", "referrals"]) {
      const anon = await pgError(() => as("anon", null, (tx) => tx.unsafe(`select id from public.${table} limit 1`)));
      expect(anon.code).toBe("42501");
    }
    const anonProbe = await pgError(() => as("anon", null, (tx) => tx`select public.doctor_can_read_patient(${clinicA}, ${x.id})`));
    expect(anonProbe.code).toBe("42501");
  });

  it("10. RLS denies unauthorized access", async () => {
    const x = await patientX();
    const referral = await refer(x.id, x.consultation);
    await accept(referral);

    // RLS is on for every table a doctor could reach patient data through.
    const rls = await sql<{ relname: string; relrowsecurity: boolean }[]>`
      select relname, relrowsecurity from pg_class
      where relnamespace = 'public'::regnamespace
        and relname in ('patients', 'appointments', 'payments', 'referrals', 'conversations', 'messages', 'voice_messages')`;
    expect(rls).toHaveLength(7);
    expect(rls.every((r) => r.relrowsecurity)).toBe(true);

    // The whole matrix for patient X: the treating doctors — Dr A, and Dr E
    // who saw X once — and Dr B, whom X is referred to, see the whole history;
    // operational staff see the patient and the bookings for their work.
    for (const doctor of [profiles.a, profiles.e, profiles.b]) expect(await seenBy(doctor, x.id)).toEqual(wholeHistory(...x.all));
    expect(await seenBy(profiles.receptionist, x.id)).toEqual({ patient: true, appointments: x.all, payments: 0 });
    // A same-clinic doctor without a relationship — Dr C, and Dr B2 although a
    // referral names their colleague — and another clinic's doctor: nothing.
    for (const denied of [profiles.c, profiles.b2, profiles.k]) expect(await seenBy(denied, x.id)).toEqual(nothing);

    // Doctors never see a patient's conversations, even their own patient's.
    await asServer((tx) => tx`insert into public.conversations ${tx({ clinic_id: clinicA, patient_id: x.id })}`);
    for (const doctor of [profiles.a, profiles.b]) {
      expect(await asUser(doctor, (tx) => tx`select id from public.conversations where patient_id = ${x.id}`)).toHaveLength(0);
    }
    await sql`delete from public.conversations where patient_id = ${x.id}`;
  });

  // ---------- Hardening (20260927000004_clinical_access_hardening.sql) ----------

  it("11. Voice recordings are readable only by operational staff, never by doctors", async () => {
    // One always-rolled-back transaction: Supabase Storage forbids deleting
    // storage.objects rows directly, so the fixture must never be committed.
    const path = `${clinicA}/${randomUUID()}.ogg`;
    const seen: Record<string, boolean> = {};
    const cast = { receptionist: profiles.receptionist, manager: profiles.manager, a: profiles.a, b: profiles.b, c: profiles.c, k: profiles.k };
    await sql
      .begin(async (tx) => {
        await tx`insert into storage.objects (bucket_id, name) values ('voice-messages', ${path})`;
        for (const [name, profileId] of Object.entries(cast)) {
          await tx.unsafe("set local role authenticated");
          await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: profileId, role: "authenticated" })}, true)`;
          seen[name] = (await tx`select name from storage.objects where name = ${path}`).length === 1;
          await tx.unsafe("reset role");
        }
        throw ROLLBACK;
      })
      .catch((e) => {
        if (e !== ROLLBACK) throw e;
      });
    expect(seen).toEqual({ receptionist: true, manager: true, a: false, b: false, c: false, k: false });
  });

  it("12. A deactivated doctor loses clinical access at the database, like at the API", async () => {
    const x = await patientX();
    await asServer((tx) => tx`insert into public.payments ${tx({ clinic_id: clinicA, appointment_id: x.consultation, patient_id: x.id, amount: 100000 })}`);
    const referral = await refer(x.id, x.consultation);
    await accept(referral);

    await sql`update public.doctors set active = false where id in ${sql([doctors.a, doctors.b])}`;
    try {
      expect(await access(doctors.a, x.id)).toBeNull();
      expect(await access(doctors.b, x.id)).toBeNull();
      expect(await seenBy(profiles.a, x.id)).toEqual(nothing);
      expect(await seenBy(profiles.b, x.id)).toEqual(nothing);
    } finally {
      await sql`update public.doctors set active = true where id in ${sql([doctors.a, doctors.b])}`;
    }
    // Reactivated: the whole history again — and still never the payment row.
    expect(await access(doctors.a, x.id)).toEqual(ownPatient());
    expect(await access(doctors.b, x.id)).toEqual(referredOnly(referral));
    expect(await seenBy(profiles.a, x.id)).toEqual(wholeHistory(...x.all));
    expect(await seenBy(profiles.b, x.id)).toEqual(wholeHistory(...x.all));
  });

  it("13. Doctors cannot write appointments directly — status changes go through the server", async () => {
    const x = await patientX();
    for (const change of [
      { status: "cancelled" },
      { status: "pending" },
      { status: "completed" },
    ]) {
      const refused = await pgError(() => asUser(profiles.a, (tx) => tx`update public.appointments set ${tx(change)} where id = ${x.consultation} returning id`));
      expect(refused.code).toBe("42501");
    }
    const del = await pgError(() => asUser(profiles.a, (tx) => tx`delete from public.appointments where id = ${x.consultation} returning id`));
    expect(del.code).toBe("42501");
    const [{ status }] = await sql<{ status: string }[]>`select status from public.appointments where id = ${x.consultation}`;
    expect(status).toBe("completed");
  });

  it("14. A follow-up booked for a referral is part of every treating doctor's view, and Dr B's own visit: it keeps the history after a revocation, until it is cancelled", async () => {
    const x = await patientX();
    const referral = await refer(x.id, x.consultation);
    await accept(referral);
    const followUp = await visit(x.id, doctors.b, clinicA, "confirmed");
    await transition(referral, { follow_up_appointment_id: followUp });

    // The referrer (Dr A) and Dr E, who also saw X, see the follow-up with Dr B like every other visit.
    expect(await access(doctors.a, x.id)).toEqual(ownPatient());
    for (const doctor of [profiles.a, profiles.e]) expect(await seenBy(doctor, x.id)).toEqual(wholeHistory(...x.all, followUp));
    // For Dr B the booking is their own appointment with X, beside the open referral.
    expect(await access(doctors.b, x.id)).toEqual(ownPatient(referral));

    // Revoked: the booking keeps Dr B X's doctor, with the whole history…
    await revoke(referral);
    expect(await access(doctors.b, x.id)).toEqual(ownPatient());
    expect(await seenBy(profiles.b, x.id)).toEqual(wholeHistory(...x.all, followUp));
    // …until it is cancelled: then Dr B has nothing, while the cancelled
    // booking stays part of X's history for the treating doctors.
    await sql`update public.appointments set status = 'cancelled' where id = ${followUp}`;
    expect(await access(doctors.b, x.id)).toEqual(noRelationship);
    expect(await seenBy(profiles.b, x.id)).toEqual(nothing);
    expect(await seenBy(profiles.a, x.id)).toEqual(wholeHistory(...x.all, followUp));
  });

  // ---------- The treating relationship and department referrals (20261002000001_longitudinal_history.sql) ----------

  it("15. Any appointment that was not cancelled — past or booked, whatever its status — is a treating relationship with the whole history", async () => {
    for (const [status, when] of [
      ["completed", "past"],
      ["no_show", "past"],
      ["checked_in", "past"],
      ["in_progress", "past"],
      ["confirmed", "booked"],
      ["pending", "booked"],
    ] as const) {
      const p = await newPatient();
      const withE = await visit(p, doctors.e);
      const mine = await visit(p, doctors.a, clinicA, status, when);
      expect(await access(doctors.a, p), status).toEqual(ownPatient());
      expect(await seenBy(profiles.a, p), status).toEqual(wholeHistory(mine, withE));
    }
  });

  it("16. A doctor whose only appointment with the patient was cancelled has no relationship — and cancelling a booking ends the one it gave", async () => {
    const p = await newPatient();
    const withE = await visit(p, doctors.e);
    const cancelled = await visit(p, doctors.a, clinicA, "cancelled");
    expect(await access(doctors.a, p)).toEqual(noRelationship);
    expect(await seenBy(profiles.a, p)).toEqual(nothing);
    // The history is there: a treating doctor sees both visits, the cancelled one included.
    expect(await seenBy(profiles.e, p)).toEqual(wholeHistory(withE, cancelled));

    const q = await newPatient();
    const booking = await visit(q, doctors.a, clinicA, "confirmed", "booked");
    expect(await access(doctors.a, q)).toEqual(ownPatient());
    await sql`update public.appointments set status = 'cancelled' where id = ${booking}`;
    expect(await access(doctors.a, q)).toEqual(noRelationship);
    expect(await seenBy(profiles.a, q)).toEqual(nothing);
  });

  it("16b. An unconfirmed website booking is no treating relationship — it is made without proof of who the visitor is — until staff confirm it", async () => {
    const p = await newPatient();
    const withE = await visit(p, doctors.e);
    // Anyone can book on the website naming a patient's name and phone: the booked doctor learns nothing from that.
    const web = await visit(p, doctors.a, clinicA, "pending", "booked", "web");
    expect(await access(doctors.a, p)).toEqual(noRelationship);
    expect(await seenBy(profiles.a, p)).toEqual(nothing);
    // The same booking through any verified channel counts at once…
    const q = await newPatient();
    await visit(q, doctors.a, clinicA, "pending", "booked", "telegram_mini_app");
    expect(await access(doctors.a, q)).toEqual(ownPatient());
    // …and a website booking once staff have confirmed it.
    await sql`update public.appointments set status = 'confirmed' where id = ${web}`;
    expect(await access(doctors.a, p)).toEqual(ownPatient());
    expect(await seenBy(profiles.a, p)).toEqual(wholeHistory(withE, web));
  });

  it("17. A record the doctor wrote is a treating relationship by itself — even once its consultation is cancelled", async () => {
    const p = await newPatient();
    const withE = await visit(p, doctors.e);
    const consultation = await visit(p, doctors.a, clinicA, "in_progress");
    await writeRecord("a", p, consultation);
    await sql`update public.appointments set status = 'cancelled' where id = ${consultation}`;

    // No appointment of Dr A's with the patient counts any more…
    const [{ live }] = await sql<{ live: number }[]>`
      select count(*)::int as live from public.appointments
      where patient_id = ${p} and doctor_id = ${doctors.a} and status <> 'cancelled'`;
    expect(live).toBe(0);
    // …yet the record Dr A wrote keeps the patient theirs, with the whole history.
    expect(await access(doctors.a, p)).toEqual(ownPatient());
    expect(await seenBy(profiles.a, p)).toEqual(wholeHistory(consultation, withE));
  });

  it("18. A department referral opens the whole history to every doctor of the department — until one of them takes it", async () => {
    const x = await patientX();
    const toCardiology = { referred_to_doctor_id: null, referred_to_specialty_id: cardiology };

    // Untaken: every cardiologist sees X's whole history at once; another department nothing.
    const first = await refer(x.id, x.consultation, toCardiology);
    for (const [doctorId, profileId] of [
      [doctors.b, profiles.b],
      [doctors.b2, profiles.b2],
    ]) {
      expect(await access(doctorId, x.id)).toEqual(referredOnly(first));
      expect(await seenBy(profileId, x.id)).toEqual(wholeHistory(...x.all));
    }
    expect(await access(doctors.c, x.id)).toEqual(noRelationship);
    expect(await seenBy(profiles.c, x.id)).toEqual(nothing);

    // Revoked while untaken: every cardiologist loses it at once.
    await revoke(first);
    for (const doctorId of [doctors.b, doctors.b2]) expect(await access(doctorId, x.id)).toEqual(noRelationship);

    // A new one. Dr C, outside the department, cannot take it to gain access…
    const second = await refer(x.id, x.consultation, toCardiology);
    const takenByC = await pgError(() => transition(second, { status: "accepted", accepted_by: profiles.c, referred_to_doctor_id: doctors.c }));
    expect(takenByC.message).toMatch(/does not belong to that department/);
    expect(await access(doctors.c, x.id)).toEqual(noRelationship);
    // …Dr B takes it by accepting: from then on it is Dr B's alone, and Dr B2 sees nothing.
    await transition(second, { status: "accepted", accepted_by: profiles.b, referred_to_doctor_id: doctors.b });
    expect(await access(doctors.b, x.id)).toEqual(referredOnly(second));
    expect(await seenBy(profiles.b, x.id)).toEqual(wholeHistory(...x.all));
    expect(await access(doctors.b2, x.id)).toEqual(noRelationship);
    expect(await seenBy(profiles.b2, x.id)).toEqual(nothing);
  });
});

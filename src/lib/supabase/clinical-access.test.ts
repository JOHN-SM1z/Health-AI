import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";

/**
 * Referral-based clinical access — the DATABASE layer
 * (supabase/migrations/20260927000003_referral_clinical_access.sql):
 * public.doctor_patient_access() and the patients/appointments RLS policies
 * built on it, exercised directly against Postgres.
 *
 * Doctor sessions are simulated the way PostgREST runs every request:
 * `set local role authenticated` plus the JWT claims auth.uid() reads. So
 * every "as doctor" read below is exactly what a doctor gets when they call
 * the Supabase REST API directly with their own token — no app code in
 * between. Server writes run as service_role, like the app's admin client.
 *
 * Cast: Dr A sees patient X (their own patient), Dr E also saw X, Dr B is
 * the doctor X is referred to, Dr C works in the same clinic with no
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
  history_doctor_ids: string[];
  referral_appointment_ids: string[];
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

describeDb("referral-based clinical access — database layer (doctor_patient_access + RLS)", () => {
  let sql: postgres.Sql;
  const suffix = Date.now().toString(36);
  const clinicA = randomUUID();
  const clinicB = randomUUID();
  const serviceA = randomUUID();
  const serviceB = randomUUID();

  const profiles = {
    a: randomUUID(),
    b: randomUUID(),
    c: randomUUID(),
    e: randomUUID(),
    k: randomUUID(),
    receptionist: randomUUID(),
    manager: randomUUID(),
  };
  const doctors = { a: randomUUID(), b: randomUUID(), c: randomUUID(), e: randomUUID(), k: randomUUID() };
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

  /** A completed visit of `patient` with `doctor`, on its own day so slots never collide. */
  async function visit(patient: string, doctor: string, clinicId = clinicA, status = "completed"): Promise<string> {
    const start = new Date(Date.UTC(2026, 0, 5, 5, 0) + day++ * 86_400_000);
    const [row] = await sql<{ id: string }[]>`
      insert into public.appointments ${sql({
        clinic_id: clinicId,
        patient_id: patient,
        doctor_id: doctor,
        service_id: clinicId === clinicA ? serviceA : serviceB,
        start_at: start,
        end_at: new Date(start.getTime() + 30 * 60_000),
        status,
        source: "walk_in",
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
    return { id, consultation, withA: [consultation, earlierWithA], withE };
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
      { clinic_id: clinicA, profile_id: profiles.c, role: "doctor" },
      { clinic_id: clinicA, profile_id: profiles.e, role: "doctor" },
      { clinic_id: clinicA, profile_id: profiles.receptionist, role: "receptionist" },
      { clinic_id: clinicA, profile_id: profiles.manager, role: "manager" },
      { clinic_id: clinicB, profile_id: profiles.k, role: "doctor" },
    ])}`;
    await sql`insert into public.doctors ${sql([
      { id: doctors.a, clinic_id: clinicA, profile_id: profiles.a, name: `Dr A ${suffix}`, active: true },
      { id: doctors.b, clinic_id: clinicA, profile_id: profiles.b, name: `Dr B ${suffix}`, active: true },
      { id: doctors.c, clinic_id: clinicA, profile_id: profiles.c, name: `Dr C ${suffix}`, active: true },
      { id: doctors.e, clinic_id: clinicA, profile_id: profiles.e, name: `Dr E ${suffix}`, active: true },
      { id: doctors.k, clinic_id: clinicB, profile_id: profiles.k, name: `Dr K ${suffix}`, active: true },
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

  it("1. Doctor A can access their authorized patient", async () => {
    const x = await patientX();
    await asServer((tx) => tx`insert into public.payments ${tx({ clinic_id: clinicA, appointment_id: x.consultation, patient_id: x.id, amount: 100000 })}`);

    expect(await access(doctors.a, x.id)).toMatchObject({ clinic_id: clinicA, own_patient: true, active_referral_ids: [], history_doctor_ids: [] });
    // The patient record, their own visits and their own payments — not Dr E's visit.
    expect(await seenBy(profiles.a, x.id)).toEqual({ patient: true, appointments: [...x.withA].sort(), payments: 1 });
  });

  it("2. Doctor B can access a patient actively referred to Doctor B", async () => {
    const x = await patientX();
    await asServer((tx) => tx`insert into public.payments ${tx({ clinic_id: clinicA, appointment_id: x.consultation, patient_id: x.id, amount: 100000 })}`);
    const referral = await refer(x.id, x.consultation);

    // Pending: the patient record and the consultation it came from, so Dr B can decide.
    expect(await access(doctors.b, x.id)).toMatchObject({
      own_patient: false,
      active_referral_ids: [referral],
      history_doctor_ids: [],
      referral_appointment_ids: [x.consultation],
    });
    expect(await seenBy(profiles.b, x.id)).toEqual({ patient: true, appointments: [x.consultation], payments: 0 });

    // Accepted: also X's visits with the referring doctor — never Dr E's
    // visit, never payments.
    await accept(referral);
    expect(await access(doctors.b, x.id)).toMatchObject({ active_referral_ids: [referral], history_doctor_ids: [doctors.a] });
    expect(await seenBy(profiles.b, x.id)).toEqual({ patient: true, appointments: [...x.withA].sort(), payments: 0 });
  });

  it("3. Doctor C cannot access that patient when not referred", async () => {
    const x = await patientX();
    const referral = await refer(x.id, x.consultation);
    await accept(referral);

    // Same clinic, doctor role, no relationship: the decision is empty…
    expect(await access(doctors.c, x.id)).toMatchObject({ own_patient: false, active_referral_ids: [], history_doctor_ids: [] });
    // …and RLS shows nothing — not the patient, not a visit, not the referral.
    expect(await seenBy(profiles.c, x.id)).toEqual(nothing);
    expect(await asUser(profiles.c, (tx) => tx`select id from public.referrals where id = ${referral}`)).toHaveLength(0);
  });

  it("4. Doctor B loses access after referral expiration", async () => {
    const x = await patientX();
    // Expires in two seconds (the DB clock), accepted before that.
    const referral = await asServer(async (tx) => {
      const [{ soon }] = await tx<{ soon: Date }[]>`select now() + interval '2 seconds' as soon`;
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
      return row.id;
    });
    await accept(referral);
    expect((await seenBy(profiles.b, x.id)).appointments).toEqual([...x.withA].sort());

    await new Promise((r) => setTimeout(r, 2_500));

    // Still stored as accepted (no sweep has run), yet access has ended.
    const [{ status }] = await sql<{ status: string }[]>`select status from public.referrals where id = ${referral}`;
    expect(status).toBe("accepted");
    expect(await access(doctors.b, x.id)).toMatchObject({ active_referral_ids: [], history_doctor_ids: [] });
    expect(await seenBy(profiles.b, x.id)).toEqual(nothing);
  });

  it("5. Doctor B loses access after referral revocation", async () => {
    for (const revoker of [profiles.a, profiles.manager]) {
      const x = await patientX();
      const referral = await refer(x.id, x.consultation);
      await accept(referral);
      expect((await seenBy(profiles.b, x.id)).patient).toBe(true);

      await revoke(referral, revoker);
      expect(await access(doctors.b, x.id)).toMatchObject({ active_referral_ids: [], history_doctor_ids: [] });
      expect(await seenBy(profiles.b, x.id)).toEqual(nothing);
    }

    // A declined referral never granted history, and grants nothing once declined.
    const declinedX = await patientX();
    const declined = await refer(declinedX.id, declinedX.consultation);
    await transition(declined, { status: "declined", declined_by: profiles.b });
    expect(await seenBy(profiles.b, declinedX.id)).toEqual(nothing);
  });

  it("5b. completing the referral ends the handoff; Dr B's own consultation makes the patient theirs", async () => {
    const x2 = await patientX();
    const referral2 = await refer(x2.id, x2.consultation);
    await accept(referral2);
    const followUp = await startHandoff(referral2, x2.id);
    // In progress: Dr A's history stays shared while Dr B consults.
    expect(await access(doctors.b, x2.id)).toMatchObject({ own_patient: true, history_doctor_ids: [doctors.a] });
    expect(await seenBy(profiles.b, x2.id)).toMatchObject({ appointments: [...x2.withA, followUp].sort() });

    await transition(referral2, { status: "completed", completed_by: profiles.b });
    // Own relationship now: the record and Dr B's own visit — not Dr A's history.
    expect(await access(doctors.b, x2.id)).toMatchObject({ own_patient: true, history_doctor_ids: [] });
    expect(await seenBy(profiles.b, x2.id)).toEqual({ patient: true, appointments: [followUp], payments: 0 });
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

    // The referral opens X, never Dr A's other patient Y.
    expect(await access(doctors.b, y)).toMatchObject({ own_patient: false, active_referral_ids: [], history_doctor_ids: [] });
    expect(await seenBy(profiles.b, y)).toEqual(nothing);

    // Re-pointing Dr B's own appointment at Y to become "Y's doctor" changes nothing…
    const swapped = await asUser(profiles.b, (tx) => tx`update public.appointments set patient_id = ${y} where id = ${ownVisitOfB} returning id`);
    expect(swapped).toHaveLength(0);
    const [{ patient_id: stillOwner }] = await sql<{ patient_id: string }[]>`select patient_id from public.appointments where id = ${ownVisitOfB}`;
    expect(stillOwner).not.toBe(y);
    // …Dr A's appointments Dr B can read through the referral stay read-only…
    const touched = await asUser(profiles.b, (tx) => tx`update public.appointments set status = 'completed' where id = ${x.consultation} returning id`);
    expect(touched).toHaveLength(0);
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
    // The caller-scoped helpers only ever answer for the caller.
    const [{ allowed }] = await asUser(profiles.c, (tx) => tx<{ allowed: boolean }[]>`select public.doctor_can_read_patient(${clinicA}, ${x.id}) as allowed`);
    expect(allowed).toBe(false);

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

    // The whole matrix for patient X.
    expect((await seenBy(profiles.a, x.id)).patient).toBe(true); // own
    expect((await seenBy(profiles.b, x.id)).patient).toBe(true); // referred
    expect((await seenBy(profiles.receptionist, x.id)).patient).toBe(true); // operational role, not a doctor
    for (const denied of [profiles.c, profiles.e, profiles.k]) {
      // Dr E saw X once: that is their own visit, not the rest of X's history.
      const seen = await seenBy(denied, x.id);
      expect(seen.appointments).not.toEqual(expect.arrayContaining([x.consultation]));
      if (denied !== profiles.e) expect(seen).toEqual(nothing);
    }
    expect((await seenBy(profiles.e, x.id)).appointments).toEqual([x.withE]);

    // Doctors never see a patient's conversations, even their own patient's.
    await asServer((tx) => tx`insert into public.conversations ${tx({ clinic_id: clinicA, patient_id: x.id })}`);
    for (const doctor of [profiles.a, profiles.b]) {
      expect(await asUser(doctor, (tx) => tx`select id from public.conversations where patient_id = ${x.id}`)).toHaveLength(0);
    }
    await sql`delete from public.conversations where patient_id = ${x.id}`;
  });

  // ---------- Hardening (20260927000004_clinical_access_hardening.sql) ----------

  it("11. Voice recordings are readable only by operational staff, never by doctors", async () => {
    const path = `${clinicA}/${randomUUID()}.ogg`;
    await sql`insert into storage.objects (bucket_id, name) values ('voice-messages', ${path})`;
    try {
      const readable = (profileId: string) =>
        asUser(profileId, async (tx) => (await tx`select name from storage.objects where name = ${path}`).length === 1);
      expect(await readable(profiles.receptionist)).toBe(true);
      expect(await readable(profiles.manager)).toBe(true);
      for (const doctor of [profiles.a, profiles.b, profiles.c, profiles.k]) expect(await readable(doctor)).toBe(false);
    } finally {
      await sql`delete from storage.objects where name = ${path}`;
    }
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
    expect(await seenBy(profiles.a, x.id)).toEqual({ patient: true, appointments: [...x.withA].sort(), payments: 1 });
  });

  it("13. Doctors cannot write appointments directly — status changes go through the server", async () => {
    const x = await patientX();
    for (const change of [
      { status: "cancelled" },
      { status: "pending" },
      { status: "completed" },
    ]) {
      const rows = await asUser(profiles.a, (tx) => tx`update public.appointments set ${tx(change)} where id = ${x.consultation} returning id`);
      expect(rows).toHaveLength(0);
    }
    const del = await asUser(profiles.a, (tx) => tx`delete from public.appointments where id = ${x.consultation} returning id`);
    expect(del).toHaveLength(0);
    const [{ status }] = await sql<{ status: string }[]>`select status from public.appointments where id = ${x.consultation}`;
    expect(status).toBe("completed");
  });

  it("14. Referral-linked appointments: the receiver sees the consultation while active, the referrer sees the follow-up", async () => {
    const x = await patientX();
    const referral = await refer(x.id, x.consultation);
    await accept(referral);
    const followUp = await visit(x.id, doctors.b, clinicA, "confirmed");
    await transition(referral, { follow_up_appointment_id: followUp });

    // Dr A sees their own visits plus the follow-up with Dr B — not Dr E's visit.
    expect(await access(doctors.a, x.id)).toMatchObject({ referral_appointment_ids: [followUp] });
    expect(await seenBy(profiles.a, x.id)).toMatchObject({ appointments: [...x.withA, followUp].sort() });

    // The booked follow-up starts (moving the referral in progress); once
    // completed, Dr B keeps only their own visit.
    await sql`update public.appointments set status = 'in_progress' where id = ${followUp}`;
    await transition(referral, { status: "completed", completed_by: profiles.b });
    expect(await access(doctors.b, x.id)).toMatchObject({ own_patient: true, referral_appointment_ids: [], history_doctor_ids: [] });
    expect(await seenBy(profiles.b, x.id)).toMatchObject({ appointments: [followUp] });
    // Dr E, who also saw X, gains nothing from any of this.
    expect(await seenBy(profiles.e, x.id)).toMatchObject({ appointments: [x.withE] });
  });
});

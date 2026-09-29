import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";

/**
 * Department referrals at the DATABASE layer (20261002000001_longitudinal_history.sql):
 * a referral goes to a department (a specialty), a doctor, or both. While no
 * doctor has taken a department referral, every active doctor of the
 * department has the patient's history and can accept it; the first
 * acceptance makes that doctor the receiving doctor — the only way
 * referred_to_doctor_id is ever set. Until then nobody can decline, start or
 * complete it; the referring doctor and clinic management can revoke it.
 *
 * Cast (clinic A): Dr A refers (general medicine); Dr B, Dr B2 receive
 * (cardiology), Dr BX is a cardiologist who is inactive; Dr D (dermatology)
 * and Dr N (no department) are unrelated; a manager. Clinic B: Dr K with a
 * department of the same name.
 */

const DB_URL = process.env.SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

async function probeDatabase(): Promise<string | null> {
  const probe = postgres(DB_URL, { max: 1, connect_timeout: 3, onnotice: () => {} });
  try {
    const [row] = await probe<{ ready: boolean }[]>`
      select exists (select 1 from information_schema.columns where table_name = 'referrals' and column_name = 'referred_to_specialty_id') as ready`;
    return row.ready ? null : "longitudinal history migration not applied — run `npm run db:reset-local`";
  } catch (e) {
    return `database unreachable via SUPABASE_DB_URL — ${e instanceof Error ? e.message : String(e)}`;
  } finally {
    await probe.end({ timeout: 1 });
  }
}

const unavailable = await probeDatabase();
if (unavailable) {
  process.stderr.write(`\n⚠️  department referral database suite SKIPPED (${unavailable})\n\n`);
}
const describeDb = describe.skipIf(unavailable !== null);

type Tx = postgres.TransactionSql;
type Values = Record<string, unknown>;
type Access = { clinic_id: string; own_patient: boolean; active_referral_ids: string[]; full_history: boolean };
type AuditRow = {
  action: string;
  actor_id: string | null;
  old_values: Record<string, unknown> | null;
  new_values: Record<string, unknown> | null;
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

describeDb("department referrals — claim by acceptance, access and revocation (database layer)", () => {
  let sql: postgres.Sql;
  const suffix = Date.now().toString(36);
  const clinicA = randomUUID();
  const clinicB = randomUUID();
  const service = randomUUID();
  const specialty = { general: randomUUID(), cardiology: randomUUID(), dermatology: randomUUID(), cardiologyB: randomUUID() };
  const profiles = { a: randomUUID(), b: randomUUID(), b2: randomUUID(), bx: randomUUID(), d: randomUUID(), n: randomUUID(), manager: randomUUID(), k: randomUUID() };
  const doctors = { a: randomUUID(), b: randomUUID(), b2: randomUUID(), bx: randomUUID(), d: randomUUID(), n: randomUUID(), k: randomUUID() };
  const REASON = `Chest pain on exertion, please assess (${suffix})`;
  let day = 0;

  async function serverTx<T>(run: (tx: Tx) => Promise<T>): Promise<T> {
    return (await sql.begin(async (tx) => {
      await tx.unsafe("set local role service_role");
      await tx`select set_config('request.jwt.claims', ${JSON.stringify({ role: "service_role" })}, true)`;
      return run(tx);
    })) as T;
  }

  async function newPatient() {
    const id = randomUUID();
    await sql`insert into public.patients (id, clinic_id, full_name) values (${id}, ${clinicA}, ${`Department patient ${suffix}`})`;
    // Dr A's consultation the referral is raised from.
    const start = new Date(Date.UTC(2026, 0, 5, 5, 0) + day++ * 86_400_000);
    const [visit] = await sql<{ id: string }[]>`
      insert into public.appointments ${sql({
        clinic_id: clinicA,
        patient_id: id,
        doctor_id: doctors.a,
        service_id: service,
        start_at: start,
        end_at: new Date(start.getTime() + 30 * 60_000),
        status: "completed",
        source: "walk_in",
      })} returning id`;
    return { id, consultation: visit.id };
  }

  /** A referral to the cardiology department, from Dr A, valid for `validFor` by the database clock. */
  const referToCardiology = (x: { id: string; consultation: string }, validFor = "30 days") =>
    serverTx(async (tx) => {
      const [row] = await tx<{ id: string }[]>`
        insert into public.referrals
          (clinic_id, patient_id, referring_doctor_id, referred_to_specialty_id, originating_appointment_id, reason, handoff_note, created_by, expires_at)
        values
          (${clinicA}, ${x.id}, ${doctors.a}, ${specialty.cardiology}, ${x.consultation}, ${REASON}, ${`ECG attached (${suffix})`}, ${profiles.a}, now() + ${validFor}::interval)
        returning id`;
      return row.id;
    });

  const transition = (id: string, patch: Values) => serverTx((tx) => tx`update public.referrals set ${tx(patch)} where id = ${id}`);
  const claim = (id: string, by: "b" | "b2") => transition(id, { status: "accepted", accepted_by: profiles[by], referred_to_doctor_id: doctors[by] });
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

  async function access(doctorId: string, patientId: string): Promise<Access | null> {
    const rows = await serverTx((tx) => tx<Access[]>`select * from public.doctor_patient_access(${doctorId}, ${patientId})`);
    return rows[0] ?? null;
  }
  const row = async (id: string) =>
    (await sql<{ status: string; referred_to_doctor_id: string | null; referred_to_specialty_id: string | null }[]>`
      select status, referred_to_doctor_id, referred_to_specialty_id from public.referrals where id = ${id}`)[0];
  const audits = (referralId: string) =>
    sql<AuditRow[]>`select action, actor_id, old_values, new_values from public.audit_events where referral_id = ${referralId} order by created_at, action`;

  beforeAll(async () => {
    sql = postgres(DB_URL, { max: 4, onnotice: () => {} });
    await sql`insert into public.clinics ${sql([
      { id: clinicA, name: `Department Clinic A ${suffix}`, slug: `department-a-${suffix}`, timezone: "Asia/Tashkent" },
      { id: clinicB, name: `Department Clinic B ${suffix}`, slug: `department-b-${suffix}`, timezone: "Asia/Tashkent" },
    ])}`;
    await sql`insert into public.specialties ${sql([
      { id: specialty.general, clinic_id: clinicA, name: `Terapiya ${suffix}` },
      { id: specialty.cardiology, clinic_id: clinicA, name: `Kardiologiya ${suffix}` },
      { id: specialty.dermatology, clinic_id: clinicA, name: `Dermatologiya ${suffix}` },
      { id: specialty.cardiologyB, clinic_id: clinicB, name: `Kardiologiya ${suffix}` },
    ])}`;
    const users = Object.entries(profiles).map(([name, id]) => ({ id, email: `department-${name}-${suffix}@test.local` }));
    await sql`insert into auth.users ${sql(users)}`;
    await sql`insert into public.profiles ${sql(users.map((u) => ({ id: u.id, full_name: u.email })))}`;
    const roles: Array<{ clinic_id: string; profile_id: string; role: string }> = [
      ...(["a", "b", "b2", "bx", "d", "n"] as const).map((n) => ({ clinic_id: clinicA, profile_id: profiles[n], role: "doctor" })),
      { clinic_id: clinicA, profile_id: profiles.manager, role: "manager" },
      { clinic_id: clinicB, profile_id: profiles.k, role: "doctor" },
    ];
    await sql`insert into public.staff_roles ${sql(roles)}`;
    await sql`insert into public.doctors ${sql([
      { id: doctors.a, clinic_id: clinicA, profile_id: profiles.a, name: `Dr A ${suffix}`, active: true, specialty_id: specialty.general },
      { id: doctors.b, clinic_id: clinicA, profile_id: profiles.b, name: `Dr B ${suffix}`, active: true, specialty_id: specialty.cardiology },
      { id: doctors.b2, clinic_id: clinicA, profile_id: profiles.b2, name: `Dr B2 ${suffix}`, active: true, specialty_id: specialty.cardiology },
      { id: doctors.bx, clinic_id: clinicA, profile_id: profiles.bx, name: `Dr BX ${suffix}`, active: false, specialty_id: specialty.cardiology },
      { id: doctors.d, clinic_id: clinicA, profile_id: profiles.d, name: `Dr D ${suffix}`, active: true, specialty_id: specialty.dermatology },
      { id: doctors.n, clinic_id: clinicA, profile_id: profiles.n, name: `Dr N ${suffix}`, active: true, specialty_id: null },
      { id: doctors.k, clinic_id: clinicB, profile_id: profiles.k, name: `Dr K ${suffix}`, active: true, specialty_id: specialty.cardiologyB },
    ])}`;
    await sql`insert into public.services ${sql({ id: service, clinic_id: clinicA, name: `Department consult ${suffix}`, duration_minutes: 30, price: 100000 })}`;
    // The consultations the referrals are raised from are booked with Dr A and Dr B.
    await sql`insert into public.doctor_working_hours ${sql(
      [doctors.a, doctors.b].flatMap((doctorId) =>
        [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ clinic_id: clinicA, doctor_id: doctorId, weekday, start_time: "00:00", end_time: "23:59" })),
      ),
    )}`;
  });

  afterAll(async () => {
    if (!sql) return;
    const clinics = [clinicA, clinicB];
    await sql`delete from public.referrals where clinic_id in ${sql(clinics)}`;
    await sql`delete from public.clinical_records where clinic_id in ${sql(clinics)}`;
    await sql`delete from public.appointments where clinic_id in ${sql(clinics)}`;
    await sql`delete from public.staff_roles where clinic_id in ${sql(clinics)}`;
    await sql`delete from public.doctors where clinic_id in ${sql(clinics)}`;
    await sql`delete from public.patients where clinic_id in ${sql(clinics)}`;
    await sql`delete from public.services where clinic_id in ${sql(clinics)}`;
    await sql`delete from public.specialties where clinic_id in ${sql(clinics)}`;
    await sql`delete from public.clinics where id in ${sql(clinics)}`;
    await sql`delete from auth.users where id in ${sql(Object.values(profiles))}`;
    await sql.end({ timeout: 5 });
  });

  // ---------- (a) The recipient rules ----------

  it("a referral needs a doctor or a department; a department alone is valid; the doctor must belong to a named department", async () => {
    const x = await newPatient();

    const neither = await pgError(() => serverTx((tx) => tx`
      insert into public.referrals (clinic_id, patient_id, referring_doctor_id, originating_appointment_id, reason, created_by)
      values (${clinicA}, ${x.id}, ${doctors.a}, ${x.consultation}, ${REASON}, ${profiles.a})`));
    expect(neither.code).toBe("23514");
    expect(neither.constraint_name).toBe("referrals_recipient_check");

    // A department of another clinic — even one with the same name — is refused by the composite foreign key.
    const foreign = await pgError(() => serverTx((tx) => tx`
      insert into public.referrals (clinic_id, patient_id, referring_doctor_id, referred_to_specialty_id, originating_appointment_id, reason, created_by)
      values (${clinicA}, ${x.id}, ${doctors.a}, ${specialty.cardiologyB}, ${x.consultation}, ${REASON}, ${profiles.a})`));
    expect(foreign.code).toBe("23503");
    expect(foreign.constraint_name).toBe("referrals_referred_to_specialty_fkey");

    // Doctor and department together: the doctor must be in the department.
    const mismatch = await pgError(() => serverTx((tx) => tx`
      insert into public.referrals (clinic_id, patient_id, referring_doctor_id, referred_to_doctor_id, referred_to_specialty_id, originating_appointment_id, reason, created_by)
      values (${clinicA}, ${x.id}, ${doctors.a}, ${doctors.d}, ${specialty.cardiology}, ${x.consultation}, ${REASON}, ${profiles.a})`));
    expect(mismatch.message).toMatch(/does not belong to that department/);

    const id = await referToCardiology(x);
    expect(await row(id)).toEqual({ status: "pending", referred_to_doctor_id: null, referred_to_specialty_id: specialty.cardiology });
  });

  // ---------- (b) Access while untaken ----------

  it("while untaken, every active doctor of the department has the patient's whole history — nobody else does", async () => {
    const x = await newPatient();
    const id = await referToCardiology(x);

    for (const doctor of [doctors.b, doctors.b2]) {
      expect(await access(doctor, x.id)).toMatchObject({ own_patient: false, active_referral_ids: [id], full_history: true });
    }
    // Another department, no department, an inactive cardiologist, another clinic: nothing.
    for (const doctor of [doctors.d, doctors.n]) {
      expect(await access(doctor, x.id)).toMatchObject({ own_patient: false, active_referral_ids: [], full_history: false });
    }
    expect(await access(doctors.bx, x.id)).toBeNull();
    expect(await access(doctors.k, x.id)).toBeNull();
  });

  it("a doctor never receives the department referral they raised themselves", async () => {
    const x = await newPatient();
    // Dr B (cardiology) refers to their own department: the other cardiologist receives it, Dr B does not.
    const start = new Date(Date.UTC(2026, 0, 5, 5, 0) + day++ * 86_400_000);
    const [visit] = await sql<{ id: string }[]>`
      insert into public.appointments ${sql({
        clinic_id: clinicA, patient_id: x.id, doctor_id: doctors.b, service_id: service,
        start_at: start, end_at: new Date(start.getTime() + 30 * 60_000), status: "completed", source: "walk_in",
      })} returning id`;
    const id = await serverTx(async (tx) => {
      const [r] = await tx<{ id: string }[]>`
        insert into public.referrals (clinic_id, patient_id, referring_doctor_id, referred_to_specialty_id, originating_appointment_id, reason, created_by)
        values (${clinicA}, ${x.id}, ${doctors.b}, ${specialty.cardiology}, ${visit.id}, ${REASON}, ${profiles.b}) returning id`;
      return r.id;
    });

    expect(await access(doctors.b2, x.id)).toMatchObject({ active_referral_ids: [id], full_history: true });
    expect(await access(doctors.b, x.id)).toMatchObject({ own_patient: true, active_referral_ids: [] });
    await transition(id, { status: "revoked", revoked_by: profiles.b, revoked_reason: "Test cleanup" });
  });

  // ---------- (c)(d) The claim ----------

  it("the first acceptance names the receiving doctor — the only way referred_to_doctor_id is ever set", async () => {
    const x = await newPatient();
    const id = await referToCardiology(x);

    // Naming a doctor without accepting is refused.
    const named = await pgError(() => transition(id, { referred_to_doctor_id: doctors.b }));
    expect(named.message).toMatch(/department referral is taken by accepting/);
    // An acceptance naming a doctor outside the department is refused.
    const outsider = await pgError(() => transition(id, { status: "accepted", accepted_by: profiles.d, referred_to_doctor_id: doctors.d }));
    expect(outsider.message).toMatch(/does not belong to that department/);
    // An acceptance by someone other than the doctor it names is refused.
    const forged = await pgError(() => transition(id, { status: "accepted", accepted_by: profiles.b2, referred_to_doctor_id: doctors.b }));
    expect(forged.message).toMatch(/only the receiving doctor can mark the referral accepted/);
    // The department's inactive doctor cannot take it.
    const inactive = await pgError(() => transition(id, { status: "accepted", accepted_by: profiles.bx, referred_to_doctor_id: doctors.bx }));
    expect(inactive.message).toMatch(/only the receiving doctor can mark the referral accepted/);
    expect(await row(id)).toMatchObject({ status: "pending", referred_to_doctor_id: null });

    await claim(id, "b2");
    expect(await row(id)).toEqual({ status: "accepted", referred_to_doctor_id: doctors.b2, referred_to_specialty_id: specialty.cardiology });
    // Once taken it can never change hands.
    const retaken = await pgError(() => transition(id, { referred_to_doctor_id: doctors.b }));
    expect(retaken.message).toMatch(/cannot be edited/);

    // The claimer keeps the referral's history; the other cardiologist no longer has it.
    expect(await access(doctors.b2, x.id)).toMatchObject({ active_referral_ids: [id], full_history: true });
    expect(await access(doctors.b, x.id)).toMatchObject({ active_referral_ids: [], full_history: false });
  });

  // ---------- (e) While untaken: no decline, start or completion; revocation and expiry end it ----------

  it("nobody can decline, start or complete an untaken department referral; the referring doctor or management revoke it and everyone loses access", async () => {
    const x = await newPatient();
    const id = await referToCardiology(x);

    const declined = await pgError(() => transition(id, { status: "declined", declined_by: profiles.b }));
    expect(declined.message).toMatch(/only the receiving doctor can mark the referral declined/);
    for (const to of ["in_progress", "completed"]) {
      const err = await pgError(() => transition(id, { status: to, started_by: profiles.b, completed_by: profiles.b }));
      expect(err.message, to).toMatch(/invalid status transition/);
    }
    expect(await row(id)).toMatchObject({ status: "pending", referred_to_doctor_id: null });

    // Dr D (another department) cannot revoke; Dr A can.
    const stranger = await pgError(() => transition(id, { status: "revoked", revoked_by: profiles.d, revoked_reason: "No" }));
    expect(stranger.message).toMatch(/only the referring doctor or clinic management can revoke/);
    await transition(id, { status: "revoked", revoked_by: profiles.a, revoked_reason: "Referred in error" });
    for (const doctor of [doctors.b, doctors.b2]) expect(await access(doctor, x.id)).toMatchObject({ active_referral_ids: [], full_history: false });

    // Management can revoke another one.
    const y = await newPatient();
    const second = await referToCardiology(y);
    await transition(second, { status: "revoked", revoked_by: profiles.manager, revoked_reason: "Duplicate" });
    expect((await row(second)).status).toBe("revoked");
  });

  it("access to an untaken department referral ends at expires_at, before any sweep runs", async () => {
    const x = await newPatient();
    const id = await referToCardiology(x, "2 seconds");
    expect(await access(doctors.b, x.id)).toMatchObject({ full_history: true });
    await wait(2_300);
    for (const doctor of [doctors.b, doctors.b2]) expect(await access(doctor, x.id)).toMatchObject({ active_referral_ids: [], full_history: false });
    expect((await row(id)).status).toBe("pending");
  }, 20_000);

  // ---------- (f) One open department referral per patient, referring doctor and department ----------

  it("a second open untaken referral to the same department is refused; allowed again once the first is closed", async () => {
    const x = await newPatient();
    const first = await referToCardiology(x);
    const duplicate = await pgError(() => referToCardiology(x));
    expect(duplicate.code).toBe("23505");
    expect(duplicate.constraint_name).toBe("referrals_one_open_per_department");

    await transition(first, { status: "revoked", revoked_by: profiles.a, revoked_reason: "Reissued" });
    const again = await referToCardiology(x);
    expect(again).not.toBe(first);
  });

  // ---------- (g) Audit ----------

  it("the acceptance that takes a department referral is audited as the accepting doctor — ids only, never the reason", async () => {
    const x = await newPatient();
    const id = await referToCardiology(x);
    await claim(id, "b");

    const trail = await audits(id);
    expect(trail.map((a) => a.action)).toEqual(["referral_created", "referral_accepted"]);
    const accepted = trail[1];
    expect(accepted.actor_id).toBe(profiles.b);
    expect(accepted.old_values).toEqual({ status: "pending", referred_to_doctor_id: null });
    expect(accepted.new_values).toMatchObject({
      status: "accepted",
      referred_to_doctor_id: doctors.b,
      referred_to_specialty_id: specialty.cardiology,
      referring_doctor_id: doctors.a,
    });
    expect(trail[0].new_values).toMatchObject({ referred_to_doctor_id: null, referred_to_specialty_id: specialty.cardiology });
    expect(JSON.stringify(trail)).not.toMatch(/Chest pain|ECG attached/);
  });

  // ---------- (h) Signed-in roles never read referral text ----------

  it("a department doctor's own session cannot read referrals directly — clinical text is read only through the server", async () => {
    const x = await newPatient();
    const id = await referToCardiology(x);
    const err = await pgError(() =>
      sql.begin(async (tx) => {
        await tx.unsafe("set local role authenticated");
        await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: profiles.b, role: "authenticated" })}, true)`;
        await tx`select id from public.referrals where id = ${id}`;
      }),
    );
    expect(err.code).toBe("42501");
  });
});

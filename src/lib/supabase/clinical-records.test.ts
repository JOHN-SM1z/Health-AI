import { cleanupTestClinics } from "@/test/cleanup-clinics";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { withoutGlobalSweeps } from "@/test/referral-sweep-lock";

/**
 * Doctor-authored clinical records — the DATABASE guarantees of
 * supabase/migrations/20260927000005_clinical_records.sql,
 * 20261001000001_clinical_record_governance.sql and
 * 20261002000001_longitudinal_history.sql: provenance that cannot be forged,
 * immutability (only the author corrects, as the record's next version), a
 * redacted audit trail, and RLS that shows a patient's records — every
 * doctor's — to each doctor with a legitimate clinical relationship to the
 * patient (a treating relationship, or an open referral from the moment it
 * is created), and to nobody else. The records belong to the patient's
 * longitudinal clinic record, not to the consultation or referral they came
 * from.
 *
 * Doctor and staff sessions are simulated the way PostgREST runs requests
 * (`set local role authenticated` + JWT claims), so every "as …" read is what
 * that person gets calling the Supabase REST API with their own token.
 *
 * Cast: Dr A (patient X's doctor), Dr E (also saw X — a treating doctor too),
 * Dr B (X is referred to them), Dr C (no relationship), Dr K (another clinic),
 * and the clinic's receptionist, manager and owner.
 */

const DB_URL = process.env.SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

async function probeDatabase(): Promise<string | null> {
  const probe = postgres(DB_URL, { max: 1, connect_timeout: 3, onnotice: () => {} });
  try {
    const [row] = await probe<{ has_records: boolean; can_switch_roles: boolean }[]>`
      select
        to_regclass('public.clinical_records') is not null as has_records,
        pg_has_role(current_user, 'anon', 'MEMBER')
          and pg_has_role(current_user, 'authenticated', 'MEMBER')
          and pg_has_role(current_user, 'service_role', 'MEMBER') as can_switch_roles`;
    if (!row.has_records) return "clinical records migration not applied — run `npm run db:reset-local`";
    if (!row.can_switch_roles) return "database user cannot switch to anon/authenticated/service_role";
    return null;
  } catch (e) {
    return `database unreachable via SUPABASE_DB_URL — ${e instanceof Error ? e.message : String(e)}`;
  } finally {
    await probe.end({ timeout: 1 });
  }
}

const unavailable = await probeDatabase();
if (unavailable) process.stderr.write(`\n⚠️  clinical records database suite SKIPPED (${unavailable})\n\n`);

const describeDb = describe.skipIf(unavailable !== null);

type Tx = postgres.TransactionSql;
type Values = Record<string, unknown>;
type RecordRow = { id: string; created_at: Date; created_by: string; author_doctor_id: string; summary: string };

async function pgError(run: () => Promise<unknown>): Promise<postgres.PostgresError> {
  try {
    await run();
  } catch (e) {
    if (e instanceof postgres.PostgresError) return e;
    throw e;
  }
  throw new Error("expected the database to reject the statement");
}

describeDb("clinical records — database layer", () => {
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
    owner: randomUUID(),
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

  async function newPatient(clinicId = clinicA) {
    const id = randomUUID();
    await sql`insert into public.patients (id, clinic_id, full_name) values (${id}, ${clinicId}, ${`Records patient ${suffix}`})`;
    return id;
  }

  async function visit(patient: string, doctor: string, status = "completed", clinicId = clinicA) {
    const start = new Date(Date.UTC(2026, 0, 5, 5, 0) + day++ * 86_400_000);
    const [row] = await sql<{ id: string }[]>`insert into public.appointments ${sql({
      clinic_id: clinicId,
      patient_id: patient,
      doctor_id: doctor,
      service_id: clinicId === clinicA ? serviceA : serviceB,
      start_at: start,
      end_at: new Date(start.getTime() + 30 * 60_000),
      status,
      source: "walk_in",
    })} returning id`;
    return row.id;
  }

  const profileOf: Record<string, string> = {};

  /** A record written by `doctor` in `appointment` (server-side, like the app). */
  function write(doctor: string, patient: string, appointment: string, overrides: Values = {}) {
    return asServer(async (tx) => {
      const [row] = await tx<RecordRow[]>`insert into public.clinical_records ${tx({
        clinic_id: clinicA,
        patient_id: patient,
        author_doctor_id: doctor,
        appointment_id: appointment,
        record_type: "diagnosis",
        summary: `Essential hypertension (${suffix})`,
        details: `BP 160/100 on two readings (${suffix})`,
        code: "I10",
        created_by: profileOf[doctor],
        ...overrides,
      })} returning id, created_at, created_by, author_doctor_id, summary`;
      return row;
    });
  }

  function refer(patient: string, consultation: string, overrides: Values = {}) {
    return asServer(async (tx) => {
      const [row] = await tx<{ id: string }[]>`insert into public.referrals ${tx({
        clinic_id: clinicA,
        patient_id: patient,
        referring_doctor_id: doctors.a,
        referred_to_doctor_id: doctors.b,
        originating_appointment_id: consultation,
        reason: `Records test referral (${suffix})`,
        created_by: profiles.a,
        ...overrides,
      })} returning id`;
      return row.id;
    });
  }
  const transition = (id: string, patch: Values) => asServer((tx) => tx`update public.referrals set ${tx(patch)} where id = ${id}`);

  /** The record ids of `patient` that `profileId` can read with their own token. */
  /**
   * What the RLS policy alone lets `profileId` read. Signed-in roles have no
   * SELECT on clinical_records (reads go through the audited API), so the
   * grant is added inside a transaction that is always rolled back — the
   * policy is checked as the backstop it is.
   */
  const ROLLBACK = Symbol("rollback");
  async function readable(profileId: string, patient: string): Promise<string[]> {
    let ids: string[] = [];
    await sql
      .begin(async (tx) => {
        await tx.unsafe("grant select on public.clinical_records to authenticated");
        await tx.unsafe("set local role authenticated");
        await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: profileId, role: "authenticated" })}, true)`;
        ids = (await tx<{ id: string }[]>`select id from public.clinical_records where patient_id = ${patient}`).map((r) => r.id).sort();
        throw ROLLBACK;
      })
      .catch((e) => {
        if (e !== ROLLBACK) throw e;
      });
    return ids;
  }

  /** Patient X: Dr A's two consultations (each with a record) and Dr E's (with one). */
  async function patientX() {
    const id = await newPatient();
    const earlier = await visit(id, doctors.a);
    const consultation = await visit(id, doctors.a);
    const withE = await visit(id, doctors.e);
    const recEarlier = (await write(doctors.a, id, earlier)).id;
    const recConsultation = (await write(doctors.a, id, consultation, { record_type: "lab_result", summary: "HbA1c 7.9%", code: null })).id;
    const recE = (await write(doctors.e, id, withE, { record_type: "prescription", summary: "Amlodipine 5 mg daily", code: null })).id;
    return { id, earlier, consultation, withE, recEarlier, recConsultation, recE };
  }

  beforeAll(async () => {
    sql = postgres(DB_URL, { max: 4, onnotice: () => {} });
    await sql`insert into public.clinics ${sql([
      { id: clinicA, name: `Records Clinic A ${suffix}`, slug: `records-a-${suffix}`, timezone: "Asia/Tashkent" },
      { id: clinicB, name: `Records Clinic B ${suffix}`, slug: `records-b-${suffix}`, timezone: "Asia/Tashkent" },
    ])}`;
    const users = Object.entries(profiles).map(([name, id]) => ({ id, email: `records-${name}-${suffix}@test.local` }));
    await sql`insert into auth.users ${sql(users)}`;
    await sql`insert into public.profiles ${sql(users.map((u) => ({ id: u.id, full_name: u.email })))}`;
    const roles: Array<{ clinic_id: string; profile_id: string; role: string }> = [
      ...(["a", "b", "c", "e"] as const).map((k) => ({ clinic_id: clinicA, profile_id: profiles[k], role: "doctor" })),
      { clinic_id: clinicA, profile_id: profiles.receptionist, role: "receptionist" },
      { clinic_id: clinicA, profile_id: profiles.manager, role: "manager" },
      { clinic_id: clinicA, profile_id: profiles.owner, role: "owner" },
      { clinic_id: clinicB, profile_id: profiles.k, role: "doctor" },
    ];
    await sql`insert into public.staff_roles ${sql(roles)}`;
    await sql`insert into public.doctors ${sql(
      (Object.keys(doctors) as Array<keyof typeof doctors>).map((k) => ({
        id: doctors[k],
        clinic_id: k === "k" ? clinicB : clinicA,
        profile_id: profiles[k],
        name: `Dr ${k.toUpperCase()} ${suffix}`,
        active: true,
      })),
    )}`;
    for (const k of Object.keys(doctors) as Array<keyof typeof doctors>) profileOf[doctors[k]] = profiles[k];
    await sql`insert into public.services ${sql([
      { id: serviceA, clinic_id: clinicA, name: `Records consult A ${suffix}`, duration_minutes: 30, price: 100000 },
      { id: serviceB, clinic_id: clinicB, name: `Records consult B ${suffix}`, duration_minutes: 30, price: 100000 },
    ])}`;
    await sql`insert into public.doctor_working_hours ${sql(
      (Object.keys(doctors) as Array<keyof typeof doctors>).flatMap((k) =>
        [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({
          clinic_id: k === "k" ? clinicB : clinicA,
          doctor_id: doctors[k],
          weekday,
          start_time: "00:00",
          end_time: "23:59",
        })),
      ),
    )}`;
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
    await cleanupTestClinics(clinics);
    await sql`delete from auth.users where id in ${sql(Object.values(profiles))}`;
    await sql.end({ timeout: 5 });
  });

  it("keeps server-set provenance and an audit trail without clinical text", async () => {
    const patient = await newPatient();
    const consultation = await visit(patient, doctors.a, "in_progress");
    const record = await write(doctors.a, patient, consultation, { created_at: new Date("2020-01-01T00:00:00Z") });

    // The database's clock, not the caller's.
    expect(record.created_at.getTime()).toBeGreaterThan(Date.now() - 60_000);
    expect(record).toMatchObject({ author_doctor_id: doctors.a, created_by: profiles.a });

    const audit = await sql<{ action: string; actor_id: string; new_values: Record<string, unknown> }[]>`
      select action, actor_id, new_values from public.audit_events where entity_type = 'clinical_records' and entity_id = ${record.id}`;
    expect(audit).toEqual([
      expect.objectContaining({ action: "clinical_record_created", actor_id: profiles.a, new_values: expect.objectContaining({ record_type: "diagnosis" }) }),
    ]);
    expect(JSON.stringify(audit)).not.toContain("hypertension");
    expect(JSON.stringify(audit)).not.toContain("160/100");
  });

  it("cannot be filed under another doctor, another patient, another clinic or a visit that has not happened", async () => {
    const x = await patientX();
    const other = await newPatient();

    // Another doctor's name on Dr A's consultation, or Dr A's record under Dr B.
    expect((await pgError(() => write(doctors.b, x.id, x.consultation))).code).toBe("23503");
    expect((await pgError(() => write(doctors.a, x.id, x.consultation, { created_by: profiles.b }))).message).toMatch(
      /created_by must be the author/,
    );
    // Another patient's consultation.
    expect((await pgError(() => write(doctors.a, other, x.consultation))).code).toBe("23503");
    // Another clinic's doctor.
    expect((await pgError(() => write(doctors.k, x.id, x.consultation))).code).toMatch(/23503|P0001/);
    // A consultation that is only booked.
    const booked = await visit(x.id, doctors.a, "confirmed");
    expect((await pgError(() => write(doctors.a, x.id, booked))).message).toMatch(/must be in progress or completed/);
    // A deactivated doctor record.
    await sql`update public.doctors set active = false where id = ${doctors.e}`;
    try {
      expect((await pgError(() => write(doctors.e, x.id, x.withE))).message).toMatch(/active doctor/);
    } finally {
      await sql`update public.doctors set active = true where id = ${doctors.e}`;
    }
  });

  it("is immutable: no edits, no deletes, corrections only as new records by the author", async () => {
    const x = await patientX();

    // Not even the server may update (no grant), and the trigger stops the
    // database owner as well.
    expect((await pgError(() => asServer((tx) => tx`update public.clinical_records set summary = 'Changed' where id = ${x.recEarlier}`))).code).toBe(
      "42501",
    );
    expect((await pgError(() => sql`update public.clinical_records set summary = 'Changed' where id = ${x.recEarlier}`)).message).toMatch(
      /cannot be edited/,
    );
    for (const statement of [
      (tx: Tx) => tx`update public.clinical_records set summary = 'Changed' where id = ${x.recEarlier}`,
      (tx: Tx) => tx`delete from public.clinical_records where id = ${x.recEarlier}`,
      (tx: Tx) => tx`insert into public.clinical_records ${tx({
        clinic_id: clinicA,
        patient_id: x.id,
        author_doctor_id: doctors.a,
        appointment_id: x.earlier,
        record_type: "diagnosis",
        summary: "Forged",
        created_by: profiles.a,
      })}`,
    ]) {
      expect((await pgError(() => asUser(profiles.a, statement))).code).toBe("42501");
    }
    expect((await pgError(() => asServer((tx) => tx`delete from public.clinical_records where id = ${x.recEarlier}`))).code).toBe("42501");

    // The author corrects their own record, in its consultation and type, as
    // its next version; the version it replaces can't be corrected again.
    const correction = await write(doctors.a, x.id, x.earlier, { summary: "Secondary hypertension", corrects_record_id: x.recEarlier });
    expect(correction.summary).toBe("Secondary hypertension");
    expect((await pgError(() => write(doctors.a, x.id, x.earlier, { corrects_record_id: x.recEarlier }))).code).toBe("CRVER");
    expect(
      (await pgError(() => write(doctors.a, x.id, x.consultation, { corrects_record_id: x.recConsultation, record_type: "diagnosis" }))).message,
    ).toMatch(/keeps the consultation and the record type/);
    // Nobody corrects someone else's record.
    const notOwned = await pgError(() => write(doctors.e, x.id, x.withE, { corrects_record_id: x.recConsultation }));
    expect(notOwned.code).toBe("CRNOT");
    expect(notOwned.message).toMatch(/only the author can correct/);
    const [{ summary }] = await sql<{ summary: string }[]>`select summary from public.clinical_records where id = ${x.recEarlier}`;
    expect(summary).toBe(`Essential hypertension (${suffix})`);
  });

  it("keeps every version: a correction is the next version of the same record, and only the latest is current", async () => {
    const x = await patientX();
    const v2 = await write(doctors.a, x.id, x.earlier, { summary: "Secondary hypertension", corrects_record_id: x.recEarlier });
    const v3 = await write(doctors.a, x.id, x.earlier, { summary: "Renovascular hypertension", corrects_record_id: v2.id });
    // Version numbers and the lineage come from the database, never the caller.
    const forged = await write(doctors.a, x.id, x.consultation, { record_type: "lab_result", version: 7, root_record_id: x.recEarlier });

    const versions = await sql<{ id: string; version: number; root_record_id: string; status: string; summary: string; created_by: string }[]>`
      select id, version, root_record_id, status, summary, created_by from public.clinical_record_versions
      where root_record_id = ${x.recEarlier} order by version`;
    expect(versions.map((v) => [v.id, v.version, v.status, v.created_by])).toEqual([
      [x.recEarlier, 1, "superseded", profiles.a],
      [v2.id, 2, "superseded", profiles.a],
      [v3.id, 3, "current", profiles.a],
    ]);
    expect(versions[0].summary).toBe(`Essential hypertension (${suffix})`);
    const [own] = await sql<{ version: number; root_record_id: string }[]>`select version, root_record_id from public.clinical_records where id = ${forged.id}`;
    expect(own).toEqual({ version: 1, root_record_id: forged.id });

    // Each correction is audited as a new version of the record, naming the
    // version it replaces — ids and version numbers only, never the text.
    const audit = await sql<{ entity_id: string; action: string; actor_id: string; old_values: Values; new_values: Values }[]>`
      select entity_id, action, actor_id, old_values, new_values from public.audit_events
      where entity_type = 'clinical_records' and entity_id in ${sql([v2.id, v3.id])}
      order by created_at`;
    expect(audit.map((a) => [a.entity_id, a.action, a.actor_id, a.old_values])).toEqual([
      [v2.id, "clinical_record_version_created", profiles.a, { record_id: x.recEarlier, version: 1, author_doctor_id: doctors.a, created_by: profiles.a }],
      [v3.id, "clinical_record_version_created", profiles.a, { record_id: v2.id, version: 2, author_doctor_id: doctors.a, created_by: profiles.a }],
    ]);
    expect(audit.map((a) => a.new_values)).toEqual([
      expect.objectContaining({ corrects_record_id: x.recEarlier, root_record_id: x.recEarlier, version: 2, author_doctor_id: doctors.a }),
      expect.objectContaining({ corrects_record_id: v2.id, root_record_id: x.recEarlier, version: 3, author_doctor_id: doctors.a }),
    ]);
    expect(JSON.stringify(audit)).not.toMatch(/hypertension/i);

    // Two corrections of the same (current) version at once: exactly one lands.
    const race = await Promise.allSettled(
      ["first", "second"].map((label) => write(doctors.a, x.id, x.earlier, { summary: `Race ${label}`, corrects_record_id: v3.id })),
    );
    expect(race.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const lost = race.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(["CRVER", "23505"]).toContain((lost.reason as postgres.PostgresError).code);
    const [{ current }] = await sql<{ current: number }[]>`
      select count(*)::int as current from public.clinical_record_versions where root_record_id = ${x.recEarlier} and status = 'current'`;
    expect(current).toBe(1);
  });

  it("keeps a doctor record's authorship: it can't be re-linked to another login, and even then no one else could correct", async () => {
    const x = await patientX();
    // Dr C's login can't take over Dr A's doctor record once it holds Dr A's records.
    await sql`update public.doctors set profile_id = null where id = ${doctors.c}`;
    try {
      expect((await pgError(() => asServer((tx) => tx`update public.doctors set profile_id = ${profiles.c} where id = ${doctors.a}`))).code).toBe(
        "CRLNK",
      );
      // Defence in depth, in a transaction that is rolled back: with that guard
      // switched off, the new login still can't correct the old login's record.
      let refused: postgres.PostgresError | null = null;
      await sql
        .begin(async (tx) => {
          await tx.unsafe("alter table public.doctors disable trigger doctors_keep_record_authors");
          await tx`update public.doctors set profile_id = ${profiles.c} where id = ${doctors.a}`;
          refused = await pgError(() =>
            tx`insert into public.clinical_records ${tx({
              clinic_id: clinicA,
              patient_id: x.id,
              author_doctor_id: doctors.a,
              appointment_id: x.earlier,
              record_type: "diagnosis",
              summary: "Rewritten by another login",
              corrects_record_id: x.recEarlier,
              created_by: profiles.c,
            })}`,
          );
          throw ROLLBACK;
        })
        .catch((e) => {
          if (e !== ROLLBACK) throw e;
        });
      expect(refused!.code).toBe("CRNOT");
    } finally {
      await sql`update public.doctors set profile_id = ${profiles.c} where id = ${doctors.c}`;
    }
    const [{ profile_id }] = await sql<{ profile_id: string }[]>`select profile_id from public.doctors where id = ${doctors.a}`;
    expect(profile_id).toBe(profiles.a);
  });

  it("never lets a patient deletion take bookings, payments, referrals or records along", async () => {
    const keys = await sql<{ table: string; action: string }[]>`
      select c.conrelid::regclass::text as table, c.confdeltype as action
      from pg_constraint c
      where c.contype = 'f' and c.confrelid = 'public.patients'::regclass
        and c.conrelid::regclass::text in ('appointments', 'payments', 'referrals', 'clinical_records')
      order by 1`;
    // 'a' = NO ACTION: the patient can't go while any of these exist, yet a
    // whole clinic (which removes them in the same statement) still can.
    expect(keys).toEqual(["appointments", "clinical_records", "payments", "referrals"].map((table) => ({ table, action: "a" })));

    // A patient with only a booking and its payment is kept, and so are they.
    const patient = await newPatient();
    const booked = await visit(patient, doctors.a, "confirmed");
    await sql`insert into public.payments ${sql({ clinic_id: clinicA, appointment_id: booked, patient_id: patient, amount: 100000, status: "unpaid" })}`;
    expect((await pgError(() => asServer((tx) => tx`delete from public.patients where id = ${patient}`))).code).toBe("23503");
    const [{ appointments, payments }] = await sql<{ appointments: number; payments: number }[]>`
      select (select count(*)::int from public.appointments where patient_id = ${patient}) as appointments,
             (select count(*)::int from public.payments where patient_id = ${patient}) as payments`;
    expect({ appointments, payments }).toEqual({ appointments: 1, payments: 1 });
  });

  it("keeps the audit trail, the version view and the retention rules out of reach of every API role", async () => {
    const x = await patientX();
    for (const [role, sub] of [
      ["authenticated", profiles.owner],
      ["authenticated", profiles.a],
      ["service_role", null],
    ] as const) {
      for (const statement of [
        (tx: Tx) => tx`update public.audit_events set action = 'tampered' where entity_id = ${x.recEarlier}`,
        (tx: Tx) => tx`delete from public.audit_events where entity_id = ${x.recEarlier}`,
      ]) {
        expect((await pgError(() => as(role, sub, statement))).code).toBe("42501");
      }
    }
    for (const sub of [profiles.a, profiles.owner]) {
      expect((await pgError(() => asUser(sub, (tx) => tx`select id from public.clinical_record_versions limit 1`))).code).toBe("42501");
      expect((await pgError(() => asUser(sub, (tx) => tx`select clinic_id from public.retention_policies limit 1`))).code).toBe("42501");
    }
    // No retention period is assumed: a clinic has none until one is confirmed.
    const [{ count }] = await sql<{ count: number }[]>`select count(*)::int as count from public.retention_policies where clinic_id = ${clinicA}`;
    expect(count).toBe(0);
  });

  it("shows every doctor's records to each doctor with a relationship to the patient — a referral from its creation — and to nobody else", async () => {
    const x = await patientX();
    const all = [x.recEarlier, x.recConsultation, x.recE].sort();

    // The treating doctors each see the whole record, every author's: Dr A
    // sees Dr E's prescription, Dr E sees Dr A's diagnosis and lab result.
    expect(await readable(profiles.a, x.id)).toEqual(all);
    expect(await readable(profiles.e, x.id)).toEqual(all);
    expect(await readable(profiles.b, x.id)).toEqual([]);

    // Pending referral: Dr B sees all of it at once — no acceptance, no approval from anyone.
    const referral = await refer(x.id, x.consultation);
    expect(await readable(profiles.b, x.id)).toEqual(all);
    // Accepted: the same.
    await transition(referral, { status: "accepted", accepted_by: profiles.b });
    expect(await readable(profiles.b, x.id)).toEqual(all);

    // Dr B's own consultation and record join the patient's history for every treating doctor.
    const followUp = await visit(x.id, doctors.b, "in_progress");
    await transition(referral, { follow_up_appointment_id: followUp });
    const bRecord = (await write(doctors.b, x.id, followUp, { record_type: "consultation_note", summary: "Seen for the referral", code: null })).id;
    const withB = [...all, bRecord].sort();
    for (const profileId of [profiles.a, profiles.b, profiles.e]) {
      expect(await readable(profileId, x.id)).toEqual(withB);
    }

    // Revoked: Dr B keeps the whole history through their own consultation
    // and record, and Dr A keeps seeing Dr B's record.
    await transition(referral, { status: "revoked", revoked_by: profiles.a, revoked_reason: "Handled elsewhere" });
    expect(await readable(profiles.b, x.id)).toEqual(withB);
    expect(await readable(profiles.a, x.id)).toEqual(withB);

    // A referral that is a doctor's only link: everything while pending,
    // nothing once declined.
    const toC = await refer(x.id, x.consultation, { referred_to_doctor_id: doctors.c });
    expect(await readable(profiles.c, x.id)).toEqual(withB);
    await transition(toC, { status: "declined", declined_by: profiles.c });

    // No relationship (Dr C now), another clinic, and every operational role: nothing.
    for (const profileId of [profiles.c, profiles.k, profiles.receptionist, profiles.manager, profiles.owner]) {
      expect(await readable(profileId, x.id)).toEqual([]);
    }
    expect((await pgError(() => as("anon", null, (tx) => tx`select id from public.clinical_records limit 1`))).code).toBe("42501");
  });

  it("are never read directly by a signed-in session — only through the audited API", async () => {
    const x = await patientX();
    for (const profileId of [profiles.a, profiles.e, profiles.b, profiles.owner, profiles.manager]) {
      const err = await pgError(() => asUser(profileId, (tx) => tx`select id from public.clinical_records where patient_id = ${x.id}`));
      expect(err.code).toBe("42501");
    }
    // The grant is gone for good — the policy check above ran in rolled-back transactions.
    const [{ granted }] = await sql<{ granted: boolean }[]>`select has_table_privilege('authenticated', 'public.clinical_records', 'select') as granted`;
    expect(granted).toBe(false);
  });

  it("stops showing the records to a doctor whose only link was the referral once it expires, without waiting for the sweep", async () => {
    await withoutGlobalSweeps(async () => {
      const x = await patientX();
      const all = [x.recEarlier, x.recConsultation, x.recE].sort();
      const referral = await asServer(async (tx) => {
        const [{ soon }] = await tx<{ soon: Date }[]>`select now() + interval '3 seconds' as soon`;
        const [row] = await tx<{ id: string }[]>`insert into public.referrals ${tx({
          clinic_id: clinicA,
          patient_id: x.id,
          referring_doctor_id: doctors.a,
          referred_to_doctor_id: doctors.b,
          originating_appointment_id: x.consultation,
          reason: `Short-lived (${suffix})`,
          created_by: profiles.a,
          expires_at: soon,
        })} returning id`;
        return row.id;
      });
      // Every doctor's record while it is open — pending, then accepted.
      expect(await readable(profiles.b, x.id)).toEqual(all);
      await transition(referral, { status: "accepted", accepted_by: profiles.b });
      expect(await readable(profiles.b, x.id)).toEqual(all);

      // Wait out the validity on the database's clock.
      const [{ ms }] = await sql<{ ms: number }[]>`
        select ceil(extract(epoch from (expires_at - now())) * 1000)::int as ms from public.referrals where id = ${referral}`;
      await new Promise((r) => setTimeout(r, Math.max(ms, 0) + 300));

      // Still stored as accepted — no sweep has recorded the expiry — yet nothing is readable.
      const [{ status }] = await sql<{ status: string }[]>`select status from public.referrals where id = ${referral}`;
      expect(status).toBe("accepted");
      expect(await readable(profiles.b, x.id)).toEqual([]);
    });
  }, 20_000);

  it("are never erased with the patient: the patient cannot be deleted from under them", async () => {
    const x = await patientX();
    const err = await pgError(() => sql`delete from public.patients where id = ${x.id}`);
    expect(err.code).toBe("23503");
    const [{ count }] = await sql<{ count: string }[]>`select count(*) from public.clinical_records where patient_id = ${x.id}`;
    expect(Number(count)).toBe(3);
  });
});

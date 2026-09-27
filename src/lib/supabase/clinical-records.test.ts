import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";

/**
 * Doctor-authored clinical records — the DATABASE guarantees of
 * supabase/migrations/20260927000005_clinical_records.sql: provenance that
 * cannot be forged, immutability, a redacted audit trail, and RLS that shows
 * a record exactly where its consultation is visible (the Phase 3 decision).
 *
 * Doctor and staff sessions are simulated the way PostgREST runs requests
 * (`set local role authenticated` + JWT claims), so every "as …" read is what
 * that person gets calling the Supabase REST API with their own token.
 *
 * Cast: Dr A (patient X's doctor), Dr E (also saw X), Dr B (X is referred to
 * them), Dr C (no relationship), Dr K (another clinic), and the clinic's
 * receptionist, manager and owner.
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
  const readable = (profileId: string, patient: string) =>
    asUser(profileId, async (tx) =>
      (await tx<{ id: string }[]>`select id from public.clinical_records where patient_id = ${patient}`).map((r) => r.id).sort(),
    );

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
    await sql`delete from public.appointments where clinic_id in ${sql(clinics)}`;
    await sql`delete from public.staff_roles where clinic_id in ${sql(clinics)}`;
    await sql`delete from public.doctors where clinic_id in ${sql(clinics)}`;
    await sql`delete from public.patients where clinic_id in ${sql(clinics)}`;
    await sql`delete from public.services where clinic_id in ${sql(clinics)}`;
    await sql`delete from public.clinics where id in ${sql(clinics)}`;
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

    // The author corrects their own record once, in its consultation and type.
    const correction = await write(doctors.a, x.id, x.earlier, { summary: "Secondary hypertension", corrects_record_id: x.recEarlier });
    expect(correction.summary).toBe("Secondary hypertension");
    expect((await pgError(() => write(doctors.a, x.id, x.earlier, { corrects_record_id: x.recEarlier }))).code).toBe("23505");
    expect(
      (await pgError(() => write(doctors.a, x.id, x.consultation, { corrects_record_id: x.recConsultation, record_type: "diagnosis" }))).message,
    ).toMatch(/keeps the consultation and the record type/);
    // Nobody corrects someone else's record.
    expect((await pgError(() => write(doctors.e, x.id, x.withE, { corrects_record_id: x.recConsultation }))).message).toMatch(
      /only the author can correct/,
    );
    const [{ summary }] = await sql<{ summary: string }[]>`select summary from public.clinical_records where id = ${x.recEarlier}`;
    expect(summary).toBe(`Essential hypertension (${suffix})`);
  });

  it("shows each record exactly where its consultation is visible", async () => {
    const x = await patientX();
    const aRecords = [x.recEarlier, x.recConsultation].sort();

    expect(await readable(profiles.a, x.id)).toEqual(aRecords);
    expect(await readable(profiles.e, x.id)).toEqual([x.recE]);
    expect(await readable(profiles.b, x.id)).toEqual([]);

    // Pending referral: only the records of the consultation it came from.
    const referral = await refer(x.id, x.consultation);
    expect(await readable(profiles.b, x.id)).toEqual([x.recConsultation]);

    // Accepted: all of Dr A's records for X — never Dr E's.
    await transition(referral, { status: "accepted", accepted_by: profiles.b });
    expect(await readable(profiles.b, x.id)).toEqual(aRecords);

    // Dr B's own consultation and record; Dr A sees it as the referral's follow-up.
    const followUp = await visit(x.id, doctors.b, "in_progress");
    await transition(referral, { follow_up_appointment_id: followUp });
    const bRecord = (await write(doctors.b, x.id, followUp, { record_type: "consultation_note", summary: "Seen for the referral", code: null })).id;
    expect(await readable(profiles.a, x.id)).toEqual([...aRecords, bRecord].sort());
    expect(await readable(profiles.b, x.id)).toEqual([...aRecords, bRecord].sort());
    expect(await readable(profiles.e, x.id)).toEqual([x.recE]);

    // Revoked: Dr B keeps only their own.
    await transition(referral, { status: "revoked", revoked_by: profiles.a, revoked_reason: "Handled elsewhere" });
    expect(await readable(profiles.b, x.id)).toEqual([bRecord]);

    // No relationship, another clinic, and every operational role: nothing.
    for (const profileId of [profiles.c, profiles.k, profiles.receptionist, profiles.manager, profiles.owner]) {
      expect(await readable(profileId, x.id)).toEqual([]);
    }
    expect((await pgError(() => as("anon", null, (tx) => tx`select id from public.clinical_records limit 1`))).code).toBe("42501");
  });

  it("stops showing a referral's records once it expires, without waiting for the sweep", async () => {
    const x = await patientX();
    const referral = await asServer(async (tx) => {
      const [{ soon }] = await tx<{ soon: Date }[]>`select now() + interval '2 seconds' as soon`;
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
    await transition(referral, { status: "accepted", accepted_by: profiles.b });
    expect(await readable(profiles.b, x.id)).toEqual([x.recEarlier, x.recConsultation].sort());

    await new Promise((r) => setTimeout(r, 2_500));
    expect(await readable(profiles.b, x.id)).toEqual([]);
  });

  it("are erased with the patient", async () => {
    const x = await patientX();
    await sql`delete from public.patients where id = ${x.id}`;
    const [{ count }] = await sql<{ count: string }[]>`select count(*) from public.clinical_records where patient_id = ${x.id}`;
    expect(Number(count)).toBe(0);
  });
});

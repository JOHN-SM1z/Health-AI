import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";

/**
 * The referral lifecycle at the DATABASE layer — every transition, what it
 * does to each doctor's access, and the audit row it leaves
 * (supabase/migrations/20260929000001_referral_lifecycle_hardening.sql):
 *
 *   PENDING → ACCEPTED → IN_PROGRESS → COMPLETED
 *   PENDING → DECLINED;  PENDING | ACCEPTED | IN_PROGRESS → REVOKED | EXPIRED
 *
 * Access is read three ways: the decision (doctor_patient_access), what a
 * doctor's own token gets through RLS (patients, appointments), and what the
 * clinical_records / referrals policies alone would allow — those tables have
 * no direct SELECT for signed-in roles, so their policies are checked with a
 * grant inside an always-rolled-back transaction.
 *
 * Cast: Dr A refers, Dr B receives, Dr C has no relationship; a manager and a
 * receptionist of clinic A; a manager and Dr K in clinic B.
 */

const DB_URL = process.env.SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

async function probeDatabase(): Promise<string | null> {
  const probe = postgres(DB_URL, { max: 1, connect_timeout: 3, onnotice: () => {} });
  try {
    const [row] = await probe<{ ready: boolean }[]>`select to_regprocedure('public.expire_due_referrals(uuid)') is not null as ready`;
    return row.ready ? null : "lifecycle hardening migration not applied — run `npm run db:reset-local`";
  } catch (e) {
    return `database unreachable via SUPABASE_DB_URL — ${e instanceof Error ? e.message : String(e)}`;
  } finally {
    await probe.end({ timeout: 1 });
  }
}

const unavailable = await probeDatabase();
if (unavailable) process.stderr.write(`\n⚠️  referral lifecycle database suite SKIPPED (${unavailable})\n\n`);
const describeDb = describe.skipIf(unavailable !== null);

type Tx = postgres.TransactionSql;
type Values = Record<string, unknown>;
type Access = { own_patient: boolean; active_referral_ids: string[]; history_doctor_ids: string[]; referral_appointment_ids: string[] };
type AuditRow = {
  action: string;
  actor_id: string | null;
  actor_type: string;
  clinic_id: string;
  patient_id: string | null;
  referral_id: string | null;
  entity_type: string;
  entity_id: string;
  old_values: Record<string, unknown> | null;
  new_values: Record<string, unknown> | null;
  metadata: Record<string, unknown>;
  created_at: Date;
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

describeDb("referral lifecycle — transitions, access termination and audit (database layer)", () => {
  let sql: postgres.Sql;
  const suffix = Date.now().toString(36);
  const clinicA = randomUUID();
  const clinicB = randomUUID();
  const service = randomUUID();
  const profiles = {
    a: randomUUID(),
    b: randomUUID(),
    c: randomUUID(),
    manager: randomUUID(),
    receptionist: randomUUID(),
    managerB: randomUUID(),
    k: randomUUID(),
  };
  const doctors = { a: randomUUID(), b: randomUUID(), c: randomUUID(), k: randomUUID() };
  let day = 0;

  async function as<T>(role: "authenticated" | "service_role", sub: string | null, run: (tx: Tx) => Promise<T>): Promise<T> {
    return (await sql.begin(async (tx) => {
      await tx.unsafe(`set local role ${role}`);
      await tx`select set_config('request.jwt.claims', ${JSON.stringify(sub ? { sub, role } : { role })}, true)`;
      return run(tx);
    })) as T;
  }
  const asServer = <T>(run: (tx: Tx) => Promise<T>) => as("service_role", null, run);
  const asUser = <T>(profileId: string, run: (tx: Tx) => Promise<T>) => as("authenticated", profileId, run);

  /** What the table's RLS policy alone lets `profileId` read (grant rolled back with the transaction). */
  async function underPolicy<T>(table: string, profileId: string, run: (tx: Tx) => Promise<T>): Promise<T> {
    let out!: T;
    await sql
      .begin(async (tx) => {
        await tx.unsafe(`grant select on public.${table} to authenticated`);
        await tx.unsafe("set local role authenticated");
        await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: profileId, role: "authenticated" })}, true)`;
        out = await run(tx);
        throw ROLLBACK;
      })
      .catch((e) => {
        if (e !== ROLLBACK) throw e;
      });
    return out;
  }

  async function newPatient(clinicId = clinicA) {
    const id = randomUUID();
    await sql`insert into public.patients (id, clinic_id, full_name) values (${id}, ${clinicId}, ${`Lifecycle patient ${suffix}`})`;
    return id;
  }

  async function visit(patient: string, doctor: string, status = "completed") {
    const start = new Date(Date.UTC(2026, 0, 5, 5, 0) + day++ * 86_400_000);
    const [row] = await sql<{ id: string }[]>`insert into public.appointments ${sql({
      clinic_id: clinicA,
      patient_id: patient,
      doctor_id: doctor,
      service_id: service,
      start_at: start,
      end_at: new Date(start.getTime() + 30 * 60_000),
      status,
      source: "walk_in",
    })} returning id`;
    return row.id;
  }

  async function record(patient: string, doctor: keyof typeof doctors, appointment: string, summary: string) {
    const [row] = await asServer((tx) => tx<{ id: string }[]>`insert into public.clinical_records ${tx({
      clinic_id: clinicA,
      patient_id: patient,
      author_doctor_id: doctors[doctor],
      appointment_id: appointment,
      record_type: "diagnosis",
      summary,
      created_by: profiles[doctor as keyof typeof profiles],
    })} returning id`);
    return row.id;
  }

  /** Patient X: Dr A's earlier visit and the consultation they refer from, each with a record. */
  async function patientX() {
    const id = await newPatient();
    const earlier = await visit(id, doctors.a);
    const consultation = await visit(id, doctors.a);
    const recEarlier = await record(id, "a", earlier, `Essential hypertension (${suffix})`);
    const recConsultation = await record(id, "a", consultation, `Suspected LVH (${suffix})`);
    return { id, earlier, consultation, recEarlier, recConsultation, aVisits: [earlier, consultation].sort(), aRecords: [recEarlier, recConsultation].sort() };
  }

  /** A referral from Dr A's consultation to Dr B, valid for `validFor` by the database clock. */
  async function refer(x: { id: string; consultation: string }, validFor = "30 days") {
    return asServer(async (tx) => {
      const [row] = await tx<{ id: string }[]>`
        insert into public.referrals
          (clinic_id, patient_id, referring_doctor_id, referred_to_doctor_id, originating_appointment_id, reason, handoff_note, created_by, expires_at)
        values
          (${clinicA}, ${x.id}, ${doctors.a}, ${doctors.b}, ${x.consultation}, ${`Uncontrolled BP, please assess (${suffix})`},
           ${`Home readings attached (${suffix})`}, ${profiles.a}, now() + ${validFor}::interval)
        returning id`;
      return row.id;
    });
  }

  const transition = (id: string, patch: Values) => asServer((tx) => tx`update public.referrals set ${tx(patch)} where id = ${id}`);
  const accept = (id: string) => transition(id, { status: "accepted", accepted_by: profiles.b });
  /** Dr B's consultation for the referral starts (linked as its follow-up → in progress). */
  async function start(id: string, patient: string) {
    const consultation = await visit(patient, doctors.b, "in_progress");
    await transition(id, { follow_up_appointment_id: consultation });
    return consultation;
  }
  const status = async (id: string) => (await sql<{ status: string }[]>`select status from public.referrals where id = ${id}`)[0].status;
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

  async function access(doctorId: string, patientId: string): Promise<Access | null> {
    const rows = await asServer((tx) => tx<Access[]>`select * from public.doctor_patient_access(${doctorId}, ${patientId})`);
    return rows[0] ?? null;
  }

  /** Everything `profileId` gets of the patient: RLS reads plus what the records/referral policies would allow. */
  async function reach(profileId: string, patientId: string, referralId: string) {
    const rls = await asUser(profileId, async (tx) => ({
      patient: (await tx`select id from public.patients where id = ${patientId}`).length === 1,
      appointments: (await tx<{ id: string }[]>`select id from public.appointments where patient_id = ${patientId}`).map((r) => r.id).sort(),
    }));
    const records = await underPolicy("clinical_records", profileId, async (tx) =>
      (await tx<{ id: string }[]>`select id from public.clinical_records where patient_id = ${patientId}`).map((r) => r.id).sort(),
    );
    const referral = await underPolicy("referrals", profileId, async (tx) => (await tx`select id from public.referrals where id = ${referralId}`).length === 1);
    return { ...rls, records, referral };
  }
  const nothing = { patient: false, appointments: [], records: [], referral: false };

  const audits = (referralId: string) =>
    sql<AuditRow[]>`select * from public.audit_events where referral_id = ${referralId} and entity_type = 'referrals' order by created_at, action`;
  const lastAudit = async (referralId: string) => (await audits(referralId)).at(-1)!;

  /** Every referral audit row names clinic, actor, patient, referral, action and time — and no clinical text. */
  function expectWellFormed(row: AuditRow, patientId: string, referralId: string, action: string, actor: string | null) {
    expect(row).toMatchObject({
      action,
      clinic_id: clinicA,
      patient_id: patientId,
      referral_id: referralId,
      entity_type: "referrals",
      entity_id: referralId,
      actor_id: actor,
      actor_type: actor ? "staff" : "system",
    });
    expect(Date.now() - row.created_at.getTime()).toBeLessThan(60_000);
    expect(JSON.stringify(row)).not.toMatch(/Uncontrolled BP|Home readings/);
  }

  beforeAll(async () => {
    sql = postgres(DB_URL, { max: 4, onnotice: () => {} });
    await sql`insert into public.clinics ${sql([
      { id: clinicA, name: `Lifecycle Clinic A ${suffix}`, slug: `lifecycle-a-${suffix}`, timezone: "Asia/Tashkent" },
      { id: clinicB, name: `Lifecycle Clinic B ${suffix}`, slug: `lifecycle-b-${suffix}`, timezone: "Asia/Tashkent" },
    ])}`;
    const users = Object.entries(profiles).map(([name, id]) => ({ id, email: `lifecycle-${name}-${suffix}@test.local` }));
    await sql`insert into auth.users ${sql(users)}`;
    await sql`insert into public.profiles ${sql(users.map((u) => ({ id: u.id, full_name: u.email })))}`;
    await sql`insert into public.staff_roles ${sql([
      { clinic_id: clinicA, profile_id: profiles.a, role: "doctor" },
      { clinic_id: clinicA, profile_id: profiles.b, role: "doctor" },
      { clinic_id: clinicA, profile_id: profiles.c, role: "doctor" },
      { clinic_id: clinicA, profile_id: profiles.manager, role: "manager" },
      { clinic_id: clinicA, profile_id: profiles.receptionist, role: "receptionist" },
      { clinic_id: clinicB, profile_id: profiles.managerB, role: "manager" },
      { clinic_id: clinicB, profile_id: profiles.k, role: "doctor" },
    ])}`;
    await sql`insert into public.doctors ${sql([
      { id: doctors.a, clinic_id: clinicA, profile_id: profiles.a, name: `Dr A ${suffix}`, active: true },
      { id: doctors.b, clinic_id: clinicA, profile_id: profiles.b, name: `Dr B ${suffix}`, active: true },
      { id: doctors.c, clinic_id: clinicA, profile_id: profiles.c, name: `Dr C ${suffix}`, active: true },
      { id: doctors.k, clinic_id: clinicB, profile_id: profiles.k, name: `Dr K ${suffix}`, active: true },
    ])}`;
    await sql`insert into public.services ${sql({ id: service, clinic_id: clinicA, name: `Lifecycle consult ${suffix}`, duration_minutes: 30, price: 100000 })}`;
    await sql`insert into public.doctor_working_hours ${sql(
      [doctors.a, doctors.b, doctors.c].flatMap((doctorId) =>
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
    await sql`delete from public.clinics where id in ${sql(clinics)}`;
    await sql`delete from auth.users where id in ${sql(Object.values(profiles))}`;
    await sql.end({ timeout: 5 });
  });

  // ---------- Transitions ----------

  it("created → PENDING: Dr B sees the patient and the consultation it came from — nothing else", async () => {
    const x = await patientX();
    const referral = await refer(x);

    expectWellFormed(await lastAudit(referral), x.id, referral, "referral_created", profiles.a);
    expect(await access(doctors.b, x.id)).toMatchObject({ own_patient: false, active_referral_ids: [referral], history_doctor_ids: [] });
    expect(await reach(profiles.b, x.id, referral)).toEqual({ patient: true, appointments: [x.consultation], records: [x.recConsultation], referral: true });
    expect(await reach(profiles.c, x.id, referral)).toEqual(nothing);
  });

  it("PENDING → ACCEPTED: Dr A's history opens to Dr B", async () => {
    const x = await patientX();
    const referral = await refer(x);
    await accept(referral);

    expectWellFormed(await lastAudit(referral), x.id, referral, "referral_accepted", profiles.b);
    expect(await access(doctors.b, x.id)).toMatchObject({ history_doctor_ids: [doctors.a] });
    expect(await reach(profiles.b, x.id, referral)).toEqual({ patient: true, appointments: x.aVisits, records: x.aRecords, referral: true });
  });

  it("PENDING → DECLINED: Dr B loses everything at once", async () => {
    const x = await patientX();
    const referral = await refer(x);
    await transition(referral, { status: "declined", declined_by: profiles.b, declined_reason: "Outside my specialty" });

    expectWellFormed(await lastAudit(referral), x.id, referral, "referral_declined", profiles.b);
    expect(JSON.stringify(await lastAudit(referral))).not.toContain("Outside my specialty");
    expect(await access(doctors.b, x.id)).toMatchObject({ own_patient: false, active_referral_ids: [], referral_appointment_ids: [] });
    expect(await reach(profiles.b, x.id, referral)).toEqual(nothing);
  });

  it("PENDING → REVOKED by the referring doctor or by management: immediate", async () => {
    for (const by of [profiles.a, profiles.manager]) {
      const x = await patientX();
      const referral = await refer(x);
      expect((await reach(profiles.b, x.id, referral)).patient).toBe(true);
      await transition(referral, { status: "revoked", revoked_by: by, revoked_reason: "Referred in error" });

      expectWellFormed(await lastAudit(referral), x.id, referral, "referral_revoked", by);
      expect(await reach(profiles.b, x.id, referral)).toEqual(nothing);
    }
  });

  it("PENDING → EXPIRED: access ends at expires_at, before anything records it; the sweep records it once, as the system", async () => {
    const x = await patientX();
    const referral = await refer(x, "2 seconds");
    expect((await reach(profiles.b, x.id, referral)).patient).toBe(true);
    await wait(2_300);

    expect(await status(referral)).toBe("pending");
    expect(await access(doctors.b, x.id)).toMatchObject({ active_referral_ids: [], referral_appointment_ids: [] });
    expect(await reach(profiles.b, x.id, referral)).toEqual(nothing);

    // The sweep: scoped to another clinic it touches nothing; then it records the expiry exactly once.
    await asServer((tx) => tx`select public.expire_due_referrals(${clinicB})`);
    expect(await status(referral)).toBe("pending");
    const [{ n }] = await asServer((tx) => tx<{ n: number }[]>`select public.expire_due_referrals(${clinicA}) as n`);
    expect(n).toBeGreaterThanOrEqual(1);
    expect(await status(referral)).toBe("expired");
    const row = await lastAudit(referral);
    expectWellFormed(row, x.id, referral, "referral_expired", null);
    expect(row.metadata).toEqual({ cause: "validity_elapsed" });
    await asServer((tx) => tx`select public.expire_due_referrals()`);
    expect((await audits(referral)).filter((a) => a.action === "referral_expired")).toHaveLength(1);
  });

  it("ACCEPTED → IN_PROGRESS: Dr B's consultation starts; Dr A sees it as the referral's follow-up", async () => {
    const x = await patientX();
    const referral = await refer(x);
    await accept(referral);
    const own = await start(referral, x.id);

    expect(await status(referral)).toBe("in_progress");
    expectWellFormed(await lastAudit(referral), x.id, referral, "referral_in_progress", profiles.b);
    expect(await reach(profiles.b, x.id, referral)).toMatchObject({ appointments: [...x.aVisits, own].sort(), records: x.aRecords });
    expect((await reach(profiles.a, x.id, referral)).appointments).toEqual([...x.aVisits, own].sort());
  });

  it("ACCEPTED → REVOKED and ACCEPTED → EXPIRED: the history closes immediately", async () => {
    const x = await patientX();
    const revoked = await refer(x);
    await accept(revoked);
    await transition(revoked, { status: "revoked", revoked_by: profiles.a, revoked_reason: "Patient transferred" });
    expectWellFormed(await lastAudit(revoked), x.id, revoked, "referral_revoked", profiles.a);
    expect(await reach(profiles.b, x.id, revoked)).toEqual(nothing);

    const y = await patientX();
    const expiring = await refer(y, "2 seconds");
    await accept(expiring);
    expect((await reach(profiles.b, y.id, expiring)).records).toEqual(y.aRecords);
    await wait(2_300);
    expect(await reach(profiles.b, y.id, expiring)).toEqual(nothing);
    await asServer((tx) => tx`select public.expire_due_referrals(${clinicA})`);
    expectWellFormed(await lastAudit(expiring), y.id, expiring, "referral_expired", null);
  });

  it("IN_PROGRESS → COMPLETED: no more referral-based access for Dr B — their own consultation stays theirs", async () => {
    const x = await patientX();
    const referral = await refer(x);
    await accept(referral);
    const own = await start(referral, x.id);
    const ownRecord = await record(x.id, "b", own, `Hypertensive heart disease (${suffix})`);
    await transition(referral, { status: "completed", completed_by: profiles.b });

    expectWellFormed(await lastAudit(referral), x.id, referral, "referral_completed", profiles.b);
    // Nothing of Dr A's any more: not the history, not the originating consultation.
    expect(await access(doctors.b, x.id)).toMatchObject({ own_patient: true, active_referral_ids: [], history_doctor_ids: [], referral_appointment_ids: [] });
    expect(await reach(profiles.b, x.id, referral)).toEqual({ patient: true, appointments: [own], records: [ownRecord], referral: true });
    // Dr A receives the outcome — that one consultation — while the referral is valid.
    expect(await reach(profiles.a, x.id, referral)).toMatchObject({ appointments: [...x.aVisits, own].sort(), records: [...x.aRecords, ownRecord].sort() });
  });

  it("COMPLETED is bounded too: past expires_at Dr B no longer reads the referral and Dr A no longer sees the follow-up", async () => {
    const x = await patientX();
    const referral = await refer(x, "3 seconds");
    await accept(referral);
    const own = await start(referral, x.id);
    const ownRecord = await record(x.id, "b", own, `Follow-up note (${suffix})`);
    await transition(referral, { status: "completed", completed_by: profiles.b });
    expect((await reach(profiles.b, x.id, referral)).referral).toBe(true);
    await wait(3_300);

    // Only the own relationship remains, for each doctor — nothing referral-based.
    expect(await reach(profiles.b, x.id, referral)).toEqual({ patient: true, appointments: [own], records: [ownRecord], referral: false });
    expect(await reach(profiles.a, x.id, referral)).toEqual({ patient: true, appointments: x.aVisits, records: x.aRecords, referral: true });
    // A completed referral is final: the sweep leaves it alone.
    await asServer((tx) => tx`select public.expire_due_referrals(${clinicA})`);
    expect(await status(referral)).toBe("completed");
  });

  it("IN_PROGRESS → REVOKED and IN_PROGRESS → EXPIRED: Dr B keeps only their own consultation; Dr A loses the follow-up", async () => {
    const x = await patientX();
    const revoked = await refer(x);
    await accept(revoked);
    const own = await start(revoked, x.id);
    await transition(revoked, { status: "revoked", revoked_by: profiles.manager, revoked_reason: "Duplicate referral" });
    expectWellFormed(await lastAudit(revoked), x.id, revoked, "referral_revoked", profiles.manager);
    expect(await reach(profiles.b, x.id, revoked)).toEqual({ patient: true, appointments: [own], records: [], referral: false });
    expect((await reach(profiles.a, x.id, revoked)).appointments).toEqual(x.aVisits);

    const y = await patientX();
    const expiring = await refer(y, "2 seconds");
    await accept(expiring);
    const ownY = await start(expiring, y.id);
    await wait(2_300);
    expect(await reach(profiles.b, y.id, expiring)).toEqual({ patient: true, appointments: [ownY], records: [], referral: false });
    expect((await reach(profiles.a, y.id, expiring)).appointments).toEqual(y.aVisits);
    await asServer((tx) => tx`select public.expire_due_referrals(${clinicA})`);
    expect(await status(expiring)).toBe("expired");
    expectWellFormed(await lastAudit(expiring), y.id, expiring, "referral_expired", null);
  });

  it("terminal states are final: nothing leaves declined, revoked, expired or completed", async () => {
    const make = async (to: "declined" | "revoked" | "expired" | "completed") => {
      const x = await patientX();
      const id = await refer(x, to === "expired" ? "1 second" : "30 days");
      if (to === "declined") await transition(id, { status: "declined", declined_by: profiles.b });
      if (to === "revoked") await transition(id, { status: "revoked", revoked_by: profiles.a, revoked_reason: "Not needed" });
      if (to === "expired") {
        await wait(1_200);
        await asServer((tx) => tx`select public.expire_due_referrals(${clinicA})`);
      }
      if (to === "completed") {
        await accept(id);
        await start(id, x.id);
        await transition(id, { status: "completed", completed_by: profiles.b });
      }
      expect(await status(id)).toBe(to);
      return id;
    };
    for (const terminal of ["declined", "revoked", "expired", "completed"] as const) {
      const id = await make(terminal);
      for (const patch of [
        { status: "pending" },
        { status: "accepted", accepted_by: profiles.b },
        { status: "in_progress", started_by: profiles.b },
        { status: "completed", completed_by: profiles.b },
        { status: "revoked", revoked_by: profiles.a, revoked_reason: "Late" },
        { status: "expired" },
      ].filter((p) => p.status !== terminal)) {
        const err = await pgError(() => transition(id, patch));
        expect(err.message, `${terminal} -> ${patch.status}`).toMatch(/invalid status transition/);
      }
    }
  });

  it("a cancelled booking is not a relationship: a revoked referral's cancelled follow-up leaves Dr B nothing", async () => {
    const x = await patientX();
    const referral = await refer(x);
    await accept(referral);
    const booked = await visit(x.id, doctors.b, "confirmed");
    await transition(referral, { follow_up_appointment_id: booked });
    await transition(referral, { status: "revoked", revoked_by: profiles.a, revoked_reason: "Seen elsewhere" });
    // While the visit is booked Dr B is the patient's doctor for it…
    expect(await reach(profiles.b, x.id, referral)).toEqual({ patient: true, appointments: [booked], records: [], referral: false });
    // …once reception cancels it, nothing is left.
    await sql`update public.appointments set status = 'cancelled' where id = ${booked}`;
    expect(await access(doctors.b, x.id)).toMatchObject({ own_patient: false });
    expect(await reach(profiles.b, x.id, referral)).toEqual(nothing);
  });

  it("no referral is open-ended: validity is at most 180 days and can never be extended", async () => {
    const x = await patientX();
    const tooLong = await pgError(() => refer(x, "181 days"));
    expect(tooLong.constraint_name).toBe("referrals_expiry_window_check");
    const referral = await refer(x, "180 days");
    const extend = await pgError(() => transition(referral, { expires_at: new Date(Date.now() + 179 * 86_400_000) }));
    expect(extend.message).toMatch(/cannot be edited/);
  });

  // ---------- The audit trail itself ----------

  it("a full lifecycle leaves one well-formed row per step, in order", async () => {
    const x = await patientX();
    const referral = await refer(x);
    await accept(referral);
    const own = await start(referral, x.id);
    const ownRecord = await record(x.id, "b", own, `Written in the referral's consultation (${suffix})`);
    await transition(referral, { status: "completed", completed_by: profiles.b });
    const trail = await audits(referral);
    expect(trail.map((a) => [a.action, a.actor_id])).toEqual([
      ["referral_created", profiles.a],
      ["referral_accepted", profiles.b],
      ["referral_in_progress", profiles.b],
      ["referral_completed", profiles.b],
    ]);
    trail.forEach((row) => expectWellFormed(row, x.id, referral, row.action, row.actor_id));
    // A record written in the referral's consultation names the referral too — never its text.
    const recordRows = await sql<AuditRow[]>`select * from public.audit_events where entity_type = 'clinical_records' and entity_id = ${ownRecord}`;
    expect(recordRows).toHaveLength(1);
    expect(recordRows[0]).toMatchObject({ action: "clinical_record_created", actor_id: profiles.b, clinic_id: clinicA, patient_id: x.id, referral_id: referral });
    expect(JSON.stringify(recordRows[0])).not.toContain("Written in the referral's consultation");
  });

  it("audit rows are read only by the clinic's own management — never across clinics, never by doctors or reception", async () => {
    const x = await patientX();
    const referral = await refer(x);
    const read = (profileId: string) =>
      asUser(profileId, async (tx) => (await tx`select id from public.audit_events where referral_id = ${referral}`).length);
    expect(await read(profiles.manager)).toBeGreaterThan(0);
    for (const outsider of [profiles.managerB, profiles.k, profiles.a, profiles.b, profiles.receptionist]) {
      expect(await read(outsider)).toBe(0);
    }
  });

  it("audit rows are append-only for every API role and cannot be filed under another clinic", async () => {
    const x = await patientX();
    const referral = await refer(x);

    // Signed-in sessions: no writes at all.
    for (const [name, stmt] of [
      ["insert", (tx: Tx) => tx`insert into public.audit_events (clinic_id, action, entity_type) values (${clinicA}, 'forged', 'referrals')`],
      ["update", (tx: Tx) => tx`update public.audit_events set action = 'forged' where referral_id = ${referral}`],
      ["delete", (tx: Tx) => tx`delete from public.audit_events where referral_id = ${referral}`],
    ] as const) {
      expect((await pgError(() => asUser(profiles.manager, stmt))).code, name).toBe("42501");
    }
    // The server may append — but never rewrite or remove.
    expect((await pgError(() => asServer((tx) => tx`update public.audit_events set action = 'forged' where referral_id = ${referral}`))).code).toBe("42501");
    expect((await pgError(() => asServer((tx) => tx`delete from public.audit_events where referral_id = ${referral}`))).code).toBe("42501");

    // Tenant consistency on insert: a patient or referral must belong to the row's clinic (and to each other).
    const other = await newPatient(clinicB);
    const y = await patientX();
    for (const [label, values, message] of [
      ["patient of another clinic", { clinic_id: clinicA, patient_id: other }, /patient .* is not in clinic/],
      ["referral filed under another clinic", { clinic_id: clinicB, referral_id: referral }, /referral .* is not in clinic/],
      ["referral with the wrong patient", { clinic_id: clinicA, patient_id: y.id, referral_id: referral }, /referral .* for that patient/],
    ] as const) {
      const err = await pgError(() =>
        asServer((tx) => tx`insert into public.audit_events ${tx({ action: "forged", entity_type: "referrals", ...values })}`),
      );
      expect(err.message, label).toMatch(message);
    }
    // The time is the database's, never the caller's.
    const [stamped] = await asServer((tx) => tx<{ created_at: Date }[]>`insert into public.audit_events ${tx({
      clinic_id: clinicA,
      action: "time_check",
      entity_type: "referrals",
      patient_id: x.id,
      referral_id: referral,
      created_at: new Date("2000-01-01T00:00:00Z"),
    })} returning created_at`);
    expect(Math.abs(Date.now() - stamped.created_at.getTime())).toBeLessThan(60_000);
  });

  it("clinical text is never read directly: referrals and clinical records have no SELECT for signed-in sessions", async () => {
    const x = await patientX();
    const referral = await refer(x);
    await accept(referral);
    for (const profileId of [profiles.a, profiles.b, profiles.manager]) {
      expect((await pgError(() => asUser(profileId, (tx) => tx`select id from public.referrals where id = ${referral}`))).code).toBe("42501");
      expect((await pgError(() => asUser(profileId, (tx) => tx`select id from public.clinical_records where patient_id = ${x.id}`))).code).toBe("42501");
    }
    // The sweep is the server's alone.
    expect((await pgError(() => asUser(profiles.manager, (tx) => tx`select public.expire_due_referrals()`))).code).toBe("42501");
  });
});

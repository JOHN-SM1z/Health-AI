import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { daytimeTimezone } from "@/test/daytime-timezone";

/**
 * Starting a consultation at the DATABASE layer
 * (supabase/migrations/20260930000001_consultation_start.sql): the status
 * change, the referral link and the 'consultation_started' audit row are one
 * transaction — none without the others — and a start happens exactly once.
 *
 * Cast: Dr A refers, Dr B receives; a receptionist of clinic A; Dr K in
 * clinic B.
 */

// A zone where it is daytime now: walk-ins "now" stay inside one local day.
const TZ = daytimeTimezone();
const DB_URL = process.env.SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

async function probeDatabase(): Promise<string | null> {
  const probe = postgres(DB_URL, { max: 1, connect_timeout: 3, onnotice: () => {} });
  try {
    const [row] = await probe<{ ready: boolean }[]>`select to_regproc('public.start_consultation') is not null as ready`;
    return row.ready ? null : "consultation start migration not applied — run `npm run db:reset-local`";
  } catch (e) {
    return `database unreachable via SUPABASE_DB_URL — ${e instanceof Error ? e.message : String(e)}`;
  } finally {
    await probe.end({ timeout: 1 });
  }
}

const unavailable = await probeDatabase();
if (unavailable) process.stderr.write(`\n⚠️  consultation start database suite SKIPPED (${unavailable})\n\n`);
const describeDb = describe.skipIf(unavailable !== null);

type Tx = postgres.TransactionSql;
type Started = { started: boolean; referral_id: string | null };
type WalkIn = { appointment_id: string | null; error_code: string | null; referral_id: string | null };
type AuditRow = {
  action: string;
  actor_id: string | null;
  actor_type: string;
  clinic_id: string;
  patient_id: string | null;
  referral_id: string | null;
  entity_id: string;
  new_values: Record<string, unknown> | null;
  metadata: Record<string, unknown>;
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

describeDb("consultation start — one transaction, exactly once (database layer)", () => {
  let sql: postgres.Sql;
  const suffix = Date.now().toString(36);
  const clinicA = randomUUID();
  const clinicB = randomUUID();
  const service = randomUUID();
  const profiles = { a: randomUUID(), b: randomUUID(), receptionist: randomUUID(), k: randomUUID() };
  const doctors = { a: randomUUID(), b: randomUUID(), k: randomUUID() };
  const REASON = `Chest pain on exertion (${suffix})`;
  let day = 0;

  async function as<T>(role: "authenticated" | "service_role" | "anon", sub: string | null, run: (tx: Tx) => Promise<T>): Promise<T> {
    return (await sql.begin(async (tx) => {
      await tx.unsafe(`set local role ${role}`);
      await tx`select set_config('request.jwt.claims', ${JSON.stringify(sub ? { sub, role } : { role })}, true)`;
      return run(tx);
    })) as T;
  }
  const asServer = <T>(run: (tx: Tx) => Promise<T>) => as("service_role", null, run);

  async function newPatient() {
    const id = randomUUID();
    await sql`insert into public.patients (id, clinic_id, full_name) values (${id}, ${clinicA}, ${`Start patient ${suffix}`})`;
    return id;
  }
  async function visit(patient: string, doctor: string, status = "checked_in") {
    const start = new Date(Date.UTC(2026, 1, 2, 5, 0) + day++ * 86_400_000);
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
  /** Dr A refers the patient to Dr B from a consultation of theirs; accepted unless `pending`. */
  async function acceptedReferral(patient: string, opts: { pending?: boolean; validFor?: string } = {}) {
    const origin = await visit(patient, doctors.a, "completed");
    return asServer(async (tx) => {
      const [row] = await tx<{ id: string }[]>`
        insert into public.referrals
          (clinic_id, patient_id, referring_doctor_id, referred_to_doctor_id, originating_appointment_id, reason, created_by, expires_at)
        values (${clinicA}, ${patient}, ${doctors.a}, ${doctors.b}, ${origin}, ${REASON}, ${profiles.a}, now() + ${opts.validFor ?? "30 days"}::interval)
        returning id`;
      if (!opts.pending) await tx`update public.referrals set status = 'accepted', accepted_by = ${profiles.b} where id = ${row.id}`;
      return row.id;
    });
  }

  const start = (appointment: string, from: string, actor: string, via: string, link = false, doctor: string | null = null, clinic = clinicA) =>
    asServer(async (tx) => {
      const [row] = await tx<{ r: Started }[]>`
        select public.start_consultation(${clinic}, ${appointment}, ${from}::public.appointment_status, ${actor}, ${via}, ${link}, ${doctor}) as r`;
      return row.r;
    });
  const walkIn = (patient: string, actor = profiles.b, doctor = doctors.b, at = new Date(Date.now() + 120_000)) =>
    asServer(async (tx) => {
      const [row] = await tx<{ r: WalkIn }[]>`
        select public.start_walk_in_consultation(${clinicA}, ${patient}, ${doctor}, ${service}, ${at}, ${actor}) as r`;
      return row.r;
    });
  const appointmentStatus = async (id: string) => (await sql<{ status: string }[]>`select status from public.appointments where id = ${id}`)[0].status;
  const referral = async (id: string) =>
    (await sql<{ status: string; follow_up_appointment_id: string | null; started_by: string | null }[]>`
      select status, follow_up_appointment_id, started_by from public.referrals where id = ${id}`)[0];
  const startedAudits = (appointment: string) =>
    sql<AuditRow[]>`select * from public.audit_events where action = 'consultation_started' and entity_id = ${appointment}`;

  beforeAll(async () => {
    sql = postgres(DB_URL, { max: 4, onnotice: () => {} });
    await sql`insert into public.clinics ${sql([
      { id: clinicA, name: `Start Clinic A ${suffix}`, slug: `start-a-${suffix}`, timezone: TZ },
      { id: clinicB, name: `Start Clinic B ${suffix}`, slug: `start-b-${suffix}`, timezone: TZ },
    ])}`;
    const users = Object.entries(profiles).map(([name, id]) => ({ id, email: `start-${name}-${suffix}@test.local` }));
    await sql`insert into auth.users ${sql(users)}`;
    await sql`insert into public.profiles ${sql(users.map((u) => ({ id: u.id, full_name: u.email })))}`;
    await sql`insert into public.staff_roles ${sql([
      { clinic_id: clinicA, profile_id: profiles.a, role: "doctor" },
      { clinic_id: clinicA, profile_id: profiles.b, role: "doctor" },
      { clinic_id: clinicA, profile_id: profiles.receptionist, role: "receptionist" },
      { clinic_id: clinicB, profile_id: profiles.k, role: "doctor" },
    ])}`;
    await sql`insert into public.doctors ${sql([
      { id: doctors.a, clinic_id: clinicA, profile_id: profiles.a, name: `Dr A ${suffix}`, active: true },
      { id: doctors.b, clinic_id: clinicA, profile_id: profiles.b, name: `Dr B ${suffix}`, active: true },
      { id: doctors.k, clinic_id: clinicB, profile_id: profiles.k, name: `Dr K ${suffix}`, active: true },
    ])}`;
    await sql`insert into public.services ${sql({ id: service, clinic_id: clinicA, name: `Start consult ${suffix}`, duration_minutes: 30, price: 100000 })}`;
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
    await sql`delete from public.appointments where clinic_id in ${sql(clinics)}`;
    await sql`delete from public.staff_roles where clinic_id in ${sql(clinics)}`;
    await sql`delete from public.doctors where clinic_id in ${sql(clinics)}`;
    await sql`delete from public.patients where clinic_id in ${sql(clinics)}`;
    await sql`delete from public.services where clinic_id in ${sql(clinics)}`;
    await sql`delete from public.clinics where id in ${sql(clinics)}`;
    await sql`delete from auth.users where id in ${sql(Object.values(profiles))}`;
    await sql.end({ timeout: 5 });
  });

  it("moves the appointment to in progress and audits it — actor, channel and ids, no clinical text", async () => {
    const patient = await newPatient();
    const appointment = await visit(patient, doctors.b);
    expect(await start(appointment, "checked_in", profiles.b, "doctor_queue", true, doctors.b)).toEqual({ started: true, referral_id: null });
    expect(await appointmentStatus(appointment)).toBe("in_progress");
    const rows = await startedAudits(appointment);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      clinic_id: clinicA,
      actor_id: profiles.b,
      actor_type: "staff",
      patient_id: patient,
      referral_id: null,
      new_values: { status: "in_progress" },
      metadata: { patient_id: patient, doctor_id: doctors.b, referral_id: null, via: "doctor_queue", walk_in: false },
    });
  });

  it("starts exactly once: a repeat or a concurrent start changes and audits nothing more", async () => {
    const patient = await newPatient();
    const appointment = await visit(patient, doctors.b);
    const results = await Promise.all([
      start(appointment, "checked_in", profiles.b, "doctor_queue", true, doctors.b),
      start(appointment, "checked_in", profiles.b, "doctor_queue", true, doctors.b),
      start(appointment, "checked_in", profiles.receptionist, "front_desk"),
    ]);
    expect(results.filter((r) => r.started)).toHaveLength(1);
    expect(await start(appointment, "checked_in", profiles.b, "doctor_queue", true, doctors.b)).toEqual({ started: false, referral_id: null });
    expect(await start(appointment, "in_progress", profiles.b, "doctor_queue", true, doctors.b)).toEqual({ started: false, referral_id: null });
    expect(await startedAudits(appointment)).toHaveLength(1);
  });

  it("starts only from the status the caller saw: a visit cancelled in between stays cancelled", async () => {
    const patient = await newPatient();
    const appointment = await visit(patient, doctors.b);
    // The route read 'checked_in'; reception cancels before the start arrives.
    await sql`update public.appointments set status = 'cancelled', cancelled_at = now() where id = ${appointment}`;
    expect(await start(appointment, "checked_in", profiles.b, "doctor_queue", true, doctors.b)).toEqual({ started: false, referral_id: null });
    expect(await appointmentStatus(appointment)).toBe("cancelled");
    expect(await startedAudits(appointment)).toHaveLength(0);
  });

  it("links the accepted referral waiting for the consultation — the referral moves to in progress in the same transaction", async () => {
    const patient = await newPatient();
    const ref = await acceptedReferral(patient);
    const appointment = await visit(patient, doctors.b);
    expect(await start(appointment, "checked_in", profiles.b, "doctor_workspace", true, doctors.b)).toEqual({ started: true, referral_id: ref });
    expect(await referral(ref)).toEqual({ status: "in_progress", follow_up_appointment_id: appointment, started_by: profiles.b });
    const [row] = await startedAudits(appointment);
    expect(row).toMatchObject({ actor_id: profiles.b, referral_id: ref, metadata: { referral_id: ref, via: "doctor_workspace" } });
    expect(JSON.stringify(row)).not.toContain(REASON);
  });

  it("front desk starting a booked follow-up: the referral moves, the audit names the receptionist", async () => {
    const patient = await newPatient();
    const ref = await acceptedReferral(patient);
    const followUp = await visit(patient, doctors.b, "confirmed");
    await asServer((tx) => tx`update public.referrals set follow_up_appointment_id = ${followUp} where id = ${ref}`);
    expect(await start(followUp, "confirmed", profiles.receptionist, "front_desk")).toEqual({ started: true, referral_id: ref });
    expect(await referral(ref)).toMatchObject({ status: "in_progress", started_by: profiles.b });
    expect((await startedAudits(followUp))[0]).toMatchObject({ actor_id: profiles.receptionist, referral_id: ref, metadata: { via: "front_desk" } });
  });

  it("never links a pending, expired or other doctor's referral — the consultation still starts, without a referral", async () => {
    // Pending: Dr B has not accepted it; Dr A's own visit is not its consultation either.
    const p1 = await newPatient();
    const pending = await acceptedReferral(p1, { pending: true });
    const aVisit = await visit(p1, doctors.a);
    expect(await start(aVisit, "checked_in", profiles.a, "doctor_queue", true, doctors.a)).toEqual({ started: true, referral_id: null });
    const bVisit = await visit(p1, doctors.b);
    expect(await start(bVisit, "checked_in", profiles.b, "doctor_queue", true, doctors.b)).toEqual({ started: true, referral_id: null });
    expect(await referral(pending)).toMatchObject({ status: "pending", follow_up_appointment_id: null });

    // Accepted but expired by the database clock.
    const p2 = await newPatient();
    const expired = await acceptedReferral(p2, { validFor: "1 second" });
    await new Promise((r) => setTimeout(r, 1200));
    const late = await visit(p2, doctors.b);
    expect(await start(late, "checked_in", profiles.b, "doctor_queue", true, doctors.b)).toEqual({ started: true, referral_id: null });
    expect(await referral(expired)).toMatchObject({ status: "accepted", follow_up_appointment_id: null });
  });

  it("is all or nothing: when the audit row cannot be written, the appointment does not start", async () => {
    const patient = await newPatient();
    const appointment = await visit(patient, doctors.b);
    // A failure injected into this appointment's consultation_started row only
    // (the generic appointment-change audit row still goes through).
    const fn = `test_fail_audit_${suffix}`;
    await sql.unsafe(`
      create function public.${fn}() returns trigger language plpgsql as $$
      begin
        if new.entity_id = '${appointment}' and new.action = 'consultation_started' then
          raise exception 'injected audit failure';
        end if;
        return new;
      end $$;
      create trigger ${fn} before insert on public.audit_events for each row execute function public.${fn}();`);
    try {
      const error = await pgError(() => start(appointment, "checked_in", profiles.b, "doctor_queue", true, doctors.b));
      expect(error.message).toContain("injected audit failure");
    } finally {
      await sql.unsafe(`drop trigger ${fn} on public.audit_events; drop function public.${fn}();`);
    }
    expect(await appointmentStatus(appointment)).toBe("checked_in");
    expect(await startedAudits(appointment)).toHaveLength(0);
  });

  it("checks tenant, doctor and actor itself — and is callable by the server only", async () => {
    const patient = await newPatient();
    const appointment = await visit(patient, doctors.b);
    // Another clinic's id, or another doctor's appointment: nothing starts.
    expect(await start(appointment, "checked_in", profiles.k, "doctor_queue", true, null, clinicB)).toEqual({ started: false, referral_id: null });
    expect(await start(appointment, "checked_in", profiles.a, "doctor_queue", true, doctors.a)).toEqual({ started: false, referral_id: null });
    // An actor with no role in the clinic, or an unknown channel.
    expect((await pgError(() => start(appointment, "checked_in", profiles.k, "front_desk"))).message).toContain("not staff of this clinic");
    expect((await pgError(() => start(appointment, "checked_in", profiles.b, "patient_app"))).message).toContain("unknown start channel");
    expect(await appointmentStatus(appointment)).toBe("checked_in");

    for (const role of ["authenticated", "anon"] as const) {
      const denied = await pgError(() =>
        as(role, role === "authenticated" ? profiles.b : null, (tx) =>
          tx`select public.start_consultation(${clinicA}, ${appointment}, 'checked_in', ${profiles.b}, 'doctor_queue', true, ${doctors.b})`,
        ),
      );
      expect(denied.code).toBe("42501");
      const deniedWalkIn = await pgError(() =>
        as(role, role === "authenticated" ? profiles.b : null, (tx) =>
          tx`select public.start_walk_in_consultation(${clinicA}, ${patient}, ${doctors.b}, ${service}, now(), ${profiles.b})`,
        ),
      );
      expect(deniedWalkIn.code).toBe("42501");
    }
    expect(await startedAudits(appointment)).toHaveLength(0);
  });

  it("walk-in: booked in progress through the booking engine, linked and audited together — or not at all", async () => {
    const patient = await newPatient();
    const ref = await acceptedReferral(patient);
    const started = await walkIn(patient);
    expect(started).toMatchObject({ error_code: null, referral_id: ref });
    expect(await appointmentStatus(started.appointment_id!)).toBe("in_progress");
    expect(await referral(ref)).toMatchObject({ status: "in_progress", follow_up_appointment_id: started.appointment_id });
    expect((await startedAudits(started.appointment_id!))[0]).toMatchObject({
      actor_id: profiles.b,
      referral_id: ref,
      metadata: { via: "doctor_workspace", walk_in: true },
    });

    // The engine refuses (the slot overlaps the walk-in just started): nothing is booked or audited.
    const before = (await sql`select count(*)::int as n from public.audit_events where action = 'consultation_started' and patient_id = ${patient}`)[0].n;
    const refused = await walkIn(patient, profiles.b, doctors.b, new Date(Date.now() + 120_000));
    expect(refused).toMatchObject({ appointment_id: null, error_code: "slot_taken" });
    expect((await sql`select count(*)::int as n from public.audit_events where action = 'consultation_started' and patient_id = ${patient}`)[0].n).toBe(before);

    // Only the doctor themselves starts their walk-in.
    expect((await pgError(() => walkIn(patient, profiles.receptionist))).message).toContain("started by the doctor themselves");
    expect((await pgError(() => walkIn(patient, profiles.a, doctors.b))).message).toContain("started by the doctor themselves");
  });
});

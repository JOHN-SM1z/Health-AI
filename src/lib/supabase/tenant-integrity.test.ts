import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { localDbAvailable } from "@/test/local-db";

/**
 * Tenant integrity and hardening at the DATABASE layer
 * (supabase/migrations/20260930000006_tenant_integrity_hardening.sql):
 * same-clinic references everywhere, patient communication written by the
 * server only, SECURITY DEFINER functions with a safe search_path and minimum
 * grants, reactivation validated like a booking, and clinic deletion.
 */

const DB_URL = process.env.SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const describeDb = describe.skipIf(!localDbAvailable());

type Tx = postgres.TransactionSql;

async function pgError(run: () => Promise<unknown>): Promise<postgres.PostgresError> {
  try {
    await run();
  } catch (e) {
    if (e instanceof postgres.PostgresError) return e;
    throw e;
  }
  throw new Error("expected the database to reject the statement");
}

describeDb("tenant integrity — every reference stays inside its clinic; the server writes patient communication", () => {
  let sql: postgres.Sql;
  const suffix = Date.now().toString(36);
  const clinicA = randomUUID();
  const clinicB = randomUUID();
  const profiles = { manager: randomUUID(), receptionist: randomUUID(), managerB: randomUUID() };
  const doctorA = randomUUID();
  const doctorB = randomUUID();
  const serviceA = randomUUID();
  const serviceB = randomUUID();
  const specialtyB = randomUUID();
  const patientA = randomUUID();
  const patientB = randomUUID();
  const conversationA = randomUUID();
  const conversationB = randomUUID();
  let appointmentB = "";
  let dayOffset = 40 + Math.floor(Math.random() * 3000);

  async function as<T>(role: "anon" | "authenticated" | "service_role", sub: string | null, run: (tx: Tx) => Promise<T>): Promise<T> {
    return (await sql.begin(async (tx) => {
      await tx.unsafe(`set local role ${role}`);
      await tx`select set_config('request.jwt.claims', ${JSON.stringify(sub ? { sub, role } : { role })}, true)`;
      return run(tx);
    })) as T;
  }
  const asServer = <T>(run: (tx: Tx) => Promise<T>) => as("service_role", null, run);
  const asUser = <T>(profileId: string, run: (tx: Tx) => Promise<T>) => as("authenticated", profileId, run);

  /** 10:00 Tashkent on a day of its own, far ahead. */
  function freshSlot(): string {
    const d = new Date(Date.now() + dayOffset++ * 86_400_000);
    return `${d.toISOString().slice(0, 10)}T05:00:00Z`;
  }
  async function book(clinic: string, doctor: string, service: string, patient: string, start: string): Promise<string> {
    const [row] = await sql<{ appointment_id: string | null; error_code: string | null }[]>`
      select appointment_id, error_code from public.book_appointment(
        ${clinic}, ${patient}, ${doctor}, ${service}, ${start}::timestamptz, 'confirmed', 'admin', null, null, null)`;
    if (!row.appointment_id) throw new Error(`book_appointment: ${row.error_code}`);
    return row.appointment_id;
  }

  beforeAll(async () => {
    sql = postgres(DB_URL, { max: 4, onnotice: () => {} });
    await sql`insert into public.clinics ${sql([
      { id: clinicA, name: `Integrity A ${suffix}`, slug: `integrity-a-${suffix}`, timezone: "Asia/Tashkent" },
      { id: clinicB, name: `Integrity B ${suffix}`, slug: `integrity-b-${suffix}`, timezone: "Asia/Tashkent" },
    ])}`;
    const users = Object.entries(profiles).map(([name, id]) => ({ id, email: `integrity-${name}-${suffix}@test.local` }));
    await sql`insert into auth.users ${sql(users)}`;
    await sql`insert into public.profiles ${sql(users.map((u) => ({ id: u.id, full_name: u.email })))}`;
    await sql`insert into public.staff_roles ${sql([
      { clinic_id: clinicA, profile_id: profiles.manager, role: "manager" },
      { clinic_id: clinicA, profile_id: profiles.receptionist, role: "receptionist" },
      { clinic_id: clinicB, profile_id: profiles.managerB, role: "manager" },
    ])}`;
    await sql`insert into public.specialties (id, clinic_id, name) values (${specialtyB}, ${clinicB}, ${`Cardiology ${suffix}`})`;
    await sql`insert into public.doctors ${sql([
      { id: doctorA, clinic_id: clinicA, name: `Dr A ${suffix}`, active: true },
      { id: doctorB, clinic_id: clinicB, name: `Dr B ${suffix}`, active: true },
    ])}`;
    await sql`insert into public.services ${sql([
      { id: serviceA, clinic_id: clinicA, name: `Consult A ${suffix}`, duration_minutes: 30, price: 100000 },
      { id: serviceB, clinic_id: clinicB, name: `Consult B ${suffix}`, duration_minutes: 30, price: 100000 },
    ])}`;
    await sql`insert into public.patients ${sql([
      { id: patientA, clinic_id: clinicA, full_name: `Patient A ${suffix}` },
      { id: patientB, clinic_id: clinicB, full_name: `Patient B ${suffix}` },
    ])}`;
    const hours = [doctorA, doctorB].flatMap((doctor) =>
      [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({
        clinic_id: doctor === doctorA ? clinicA : clinicB,
        doctor_id: doctor,
        weekday,
        start_time: "08:00",
        end_time: "18:00",
      })),
    );
    await sql`insert into public.doctor_working_hours ${sql(hours)}`;
    await sql`insert into public.conversations ${sql([
      { id: conversationA, clinic_id: clinicA, patient_id: patientA, channel: "telegram" },
      { id: conversationB, clinic_id: clinicB, patient_id: patientB, channel: "telegram" },
    ])}`;
    appointmentB = await book(clinicB, doctorB, serviceB, patientB, freshSlot());
  });

  afterAll(async () => {
    if (!sql) return;
    // Deleting a clinic erases everything it owns, its audit trail included.
    await sql`delete from public.clinics where id in ${sql([clinicA, clinicB])}`;
    await sql`delete from public.profiles where id in ${sql(Object.values(profiles))}`;
    await sql`delete from auth.users where id in ${sql(Object.values(profiles))}`;
    await sql.end({ timeout: 5 });
  });

  // ---------- Structure ----------

  it("no foreign key between two clinic-owned tables leaves out clinic_id", async () => {
    const loose = await sql<{ child: string; name: string; parent: string }[]>`
      select c.conrelid::regclass::text as child, c.conname as name, c.confrelid::regclass::text as parent
      from pg_constraint c
      where c.contype = 'f'
        and c.connamespace = 'public'::regnamespace
        and c.confrelid::regclass::text not like '%.%'
        and exists (select 1 from pg_attribute a where a.attrelid = c.conrelid and a.attname = 'clinic_id' and not a.attisdropped)
        and exists (select 1 from pg_attribute a where a.attrelid = c.confrelid and a.attname = 'clinic_id' and not a.attisdropped)
        and not exists (
          select 1 from unnest(c.conkey) k join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k where a.attname = 'clinic_id'
        )`;
    expect(loose).toEqual([]);
  });

  it("every SECURITY DEFINER function pins its search_path, and anonymous callers can execute none of them", async () => {
    const functions = await sql<{ name: string; config: string | null; anon: boolean; signedIn: boolean; trigger: boolean }[]>`
      select p.proname as name, array_to_string(p.proconfig, ';') as config,
             has_function_privilege('anon', p.oid, 'execute') as anon,
             has_function_privilege('authenticated', p.oid, 'execute') as "signedIn",
             p.prorettype = 'trigger'::regtype as trigger
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.prosecdef`;
    expect(functions.length).toBeGreaterThan(20);
    for (const f of functions) {
      expect(f.config, f.name).toBe("search_path=public, pg_temp");
      expect(f.anon, f.name).toBe(false);
      if (f.trigger) expect(f.signedIn, f.name).toBe(false);
    }
    // The RLS helpers stay callable for signed-in users (their policies need them).
    expect(functions.find((f) => f.name === "is_clinic_staff")?.signedIn).toBe(true);
    expect(functions.find((f) => f.name === "current_doctor_id")?.signedIn).toBe(true);
  });

  it("signed-in users cannot write patient communication, server-only tables or the voice bucket", async () => {
    const writable = await sql<{ table_name: string }[]>`
      select distinct table_name from information_schema.role_table_grants
      where grantee = 'authenticated' and table_schema = 'public'
        and privilege_type in ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')
        and table_name in ('conversations', 'messages', 'voice_messages', 'notification_jobs', 'processed_webhooks',
                           'clinic_telegram_integrations', 'analytics_events', 'platform_admins',
                           'appointments', 'patients', 'payments', 'referrals', 'clinical_records', 'audit_events')`;
    expect(writable).toEqual([]);
    const uploads = await sql`
      select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects'
        and cmd in ('INSERT', 'UPDATE', 'ALL') and 'authenticated' = any(roles)`;
    expect(uploads).toHaveLength(0);
  });

  // ---------- Cross-clinic references are refused, whoever writes ----------

  it("a manager cannot schedule, block or re-specialise another clinic's doctor", async () => {
    // A free weekday for clinic B's doctor, so only the clinic can refuse it.
    await sql`delete from public.doctor_working_hours where doctor_id = ${doctorB} and weekday = 7`;
    const hours = await pgError(() =>
      asUser(profiles.manager, (tx) =>
        tx`insert into public.doctor_working_hours (clinic_id, doctor_id, weekday, start_time, end_time)
           values (${clinicA}, ${doctorB}, 7, '09:00', '10:00')`,
      ),
    );
    expect(hours.code).toBe("23503");
    await sql`insert into public.doctor_working_hours (clinic_id, doctor_id, weekday, start_time, end_time)
              values (${clinicB}, ${doctorB}, 7, '08:00', '18:00')`;
    const block = await pgError(() =>
      asUser(profiles.manager, (tx) =>
        tx`insert into public.doctor_time_blocks (clinic_id, doctor_id, starts_at, ends_at, reason)
           values (${clinicA}, ${doctorB}, now() + interval '1 day', now() + interval '1 day 1 hour', 'absence')`,
      ),
    );
    expect(block.code).toBe("23503");
    const specialty = await pgError(() =>
      asUser(profiles.manager, (tx) => tx`update public.doctors set specialty_id = ${specialtyB} where id = ${doctorA}`),
    );
    expect(specialty.code).toBe("23503");
    // Clinic B's doctor is untouched.
    const [{ n }] = await sql<{ n: number }[]>`
      select count(*)::int as n from public.doctor_time_blocks where doctor_id = ${doctorB}`;
    expect(n).toBe(0);
  });

  it("even the server cannot link a row to another clinic's patient, conversation or appointment", async () => {
    const attempts: Array<[string, (tx: Tx) => Promise<unknown>]> = [
      ["conversation → other clinic's patient", (tx) => tx`insert into public.conversations (clinic_id, patient_id, channel, status) values (${clinicA}, ${patientB}, 'telegram', 'closed')`],
      ["message → other clinic's conversation", (tx) => tx`insert into public.messages (clinic_id, conversation_id, role, type, content) values (${clinicA}, ${conversationB}, 'admin', 'text', 'x')`],
      ["voice message → other clinic's conversation", (tx) => tx`insert into public.voice_messages (clinic_id, conversation_id, telegram_file_id) values (${clinicA}, ${conversationB}, 'file')`],
      ["reminder → other clinic's appointment", (tx) => tx`insert into public.notification_jobs (clinic_id, appointment_id, type, recipient_type, scheduled_for, idempotency_key) values (${clinicA}, ${appointmentB}, 'reminder_24h', 'patient', now(), ${`x-${randomUUID()}`})`],
      ["payment → other clinic's appointment", (tx) => tx`update public.payments set clinic_id = ${clinicA}, patient_id = ${patientA} where appointment_id = ${appointmentB}`],
      ["analytics → other clinic's patient", (tx) => tx`insert into public.analytics_events (clinic_id, patient_id, event_type) values (${clinicA}, ${patientB}, 'x')`],
    ];
    for (const [label, run] of attempts) {
      const e = await pgError(() => asServer(run));
      expect(e.code, label).toBe("23503");
    }
  });

  it("staff cannot forge operator replies, take over conversations or redirect reminders over REST — the server does that", async () => {
    const reply = await pgError(() =>
      asUser(profiles.receptionist, (tx) =>
        tx`insert into public.messages (clinic_id, conversation_id, role, type, content) values (${clinicA}, ${conversationA}, 'admin', 'text', 'forged')`,
      ),
    );
    expect(reply.code).toBe("42501");
    const takeover = await pgError(() =>
      asUser(profiles.receptionist, (tx) =>
        tx`update public.conversations set status = 'assigned', taken_over_by = ${profiles.receptionist} where id = ${conversationA}`,
      ),
    );
    expect(takeover.code).toBe("42501");
    const redirect = await pgError(() =>
      asUser(profiles.manager, (tx) =>
        tx`update public.notification_jobs set patient_telegram_user_id = 424242 where clinic_id = ${clinicA}`,
      ),
    );
    expect(redirect.code).toBe("42501");
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from public.messages where conversation_id = ${conversationA}`;
    expect(n).toBe(0);
  });

  // ---------- Reactivation is validated like a booking ----------

  it("a cancelled appointment comes back only if its time is still bookable — hours, blocks and overlap", async () => {
    const start = freshSlot();
    const id = await book(clinicA, doctorA, serviceA, patientA, start);
    await sql`update public.appointments set status = 'cancelled', cancelled_at = now() where id = ${id}`;
    const weekday = ((new Date(start).getUTCDay() + 6) % 7) + 1;

    // The doctor no longer works that morning.
    await sql`update public.doctor_working_hours set start_time = '12:00' where doctor_id = ${doctorA} and weekday = ${weekday}`;
    const hours = await pgError(() => sql`update public.appointments set status = 'confirmed' where id = ${id}`);
    expect(hours.hint).toBe("outside_working_hours");
    await sql`update public.doctor_working_hours set start_time = '08:00' where doctor_id = ${doctorA} and weekday = ${weekday}`;

    // A break now covers it.
    const [block] = await sql<{ id: string }[]>`
      insert into public.doctor_time_blocks (clinic_id, doctor_id, starts_at, ends_at, reason)
      values (${clinicA}, ${doctorA}, ${start}::timestamptz, ${start}::timestamptz + interval '1 hour', 'break') returning id`;
    const blocked = await pgError(() => sql`update public.appointments set status = 'confirmed' where id = ${id}`);
    expect(blocked.hint).toBe("time_blocked");
    await sql`delete from public.doctor_time_blocks where id = ${block.id}`;

    // Someone else booked the freed time.
    const other = await book(clinicA, doctorA, serviceA, patientA, start);
    const taken = await pgError(() => sql`update public.appointments set status = 'confirmed' where id = ${id}`);
    expect(taken.code).toBe("23P01");

    // Once that visit is cancelled, the original comes back.
    await sql`update public.appointments set status = 'cancelled', cancelled_at = now() where id = ${other}`;
    await sql`update public.appointments set status = 'confirmed' where id = ${id}`;
    const [{ status }] = await sql<{ status: string }[]>`select status from public.appointments where id = ${id}`;
    expect(status).toBe("confirmed");
  });

  // ---------- Clinic deletion ----------

  it("deleting a clinic erases everything it owns, its audit trail included — and nothing of another clinic", async () => {
    const doomed = randomUUID();
    const doctor = randomUUID();
    const service = randomUUID();
    const patient = randomUUID();
    const conversation = randomUUID();
    await sql`insert into public.clinics (id, name, slug, timezone) values (${doomed}, ${`Doomed ${suffix}`}, ${`doomed-${suffix}`}, 'Asia/Tashkent')`;
    await sql`insert into public.doctors (id, clinic_id, name, active) values (${doctor}, ${doomed}, ${`Dr Doomed ${suffix}`}, true)`;
    await sql`insert into public.services (id, clinic_id, name, duration_minutes, price) values (${service}, ${doomed}, ${`Doomed consult ${suffix}`}, 30, 1000)`;
    await sql`insert into public.patients (id, clinic_id, full_name) values (${patient}, ${doomed}, ${`Doomed patient ${suffix}`})`;
    await sql`insert into public.doctor_working_hours ${sql([1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ clinic_id: doomed, doctor_id: doctor, weekday, start_time: "08:00", end_time: "18:00" })))}`;
    const appointment = await book(doomed, doctor, service, patient, freshSlot());
    await sql`insert into public.doctor_time_blocks (clinic_id, doctor_id, starts_at, ends_at, reason) values (${doomed}, ${doctor}, now() + interval '400 days', now() + interval '400 days 1 hour', 'break')`;
    await sql`insert into public.conversations (id, clinic_id, patient_id, channel) values (${conversation}, ${doomed}, ${patient}, 'telegram')`;
    await sql`insert into public.messages (clinic_id, conversation_id, role, type, content) values (${doomed}, ${conversation}, 'patient', 'text', 'hello')`;
    await sql`insert into public.notification_jobs (clinic_id, appointment_id, type, recipient_type, scheduled_for, idempotency_key) values (${doomed}, ${appointment}, 'reminder_24h', 'patient', now() + interval '1 day', ${`doomed-${suffix}`})`;
    await sql`update public.appointments set status = 'cancelled', cancelled_at = now() where id = ${appointment}`;
    const [{ before }] = await sql<{ before: number }[]>`select count(*)::int as before from public.audit_events where clinic_id = ${doomed}`;
    expect(before).toBeGreaterThan(0);
    const [{ othersBefore }] = await sql<{ othersBefore: number }[]>`select count(*)::int as "othersBefore" from public.audit_events where clinic_id = ${clinicB}`;

    await sql`delete from public.clinics where id = ${doomed}`;

    const left = await sql<{ table: string; n: number }[]>`
      select 'appointments' as table, count(*)::int as n from public.appointments where clinic_id = ${doomed}
      union all select 'payments', count(*)::int from public.payments where clinic_id = ${doomed}
      union all select 'patients', count(*)::int from public.patients where clinic_id = ${doomed}
      union all select 'messages', count(*)::int from public.messages where clinic_id = ${doomed}
      union all select 'notification_jobs', count(*)::int from public.notification_jobs where clinic_id = ${doomed}
      union all select 'audit_events', count(*)::int from public.audit_events where clinic_id = ${doomed}`;
    expect(left.filter((r) => r.n > 0)).toEqual([]);
    const [{ othersAfter }] = await sql<{ othersAfter: number }[]>`select count(*)::int as "othersAfter" from public.audit_events where clinic_id = ${clinicB}`;
    expect(othersAfter).toBe(othersBefore);
  });

  it("outside a clinic deletion, audit rows for a missing clinic are still refused", async () => {
    const e = await pgError(() =>
      sql`insert into public.audit_events (clinic_id, actor_type, action, entity_type, entity_id) values (${randomUUID()}, 'system', 'x', 'x', 'x')`,
    );
    expect(e.code).toBe("23503");
  });
});

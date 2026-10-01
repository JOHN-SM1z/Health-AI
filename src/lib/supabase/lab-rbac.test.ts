import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { cleanupTestClinics } from "@/test/cleanup-clinics";
import { localDbAvailable } from "@/test/local-db";

/**
 * The laboratory staff role at the DATABASE layer (20261003000001): a technician's own token reads the
 * clinic's configuration like any staff member and nothing about patients, bookings, money, conversations,
 * referrals or clinical records — fail closed, because every policy lists the roles it admits.
 */

const DB_URL = process.env.SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const describeDb = describe.skipIf(!localDbAvailable());

async function pgError(run: () => Promise<unknown>): Promise<postgres.PostgresError> {
  try {
    await run();
  } catch (e) {
    if (e instanceof postgres.PostgresError) return e;
    throw e;
  }
  throw new Error("expected the database to reject the statement");
}

describeDb("laboratory staff role — what the database lets a technician's token see", () => {
  let sql: postgres.Sql;
  const suffix = Date.now().toString(36);
  const clinicA = randomUUID();
  const clinicB = randomUUID();
  const lab = randomUUID();
  const rec = randomUUID();
  const doctor = randomUUID();
  const doctorId = randomUUID();
  const service = randomUUID();
  const patient = randomUUID();
  const patientB = randomUUID();
  let appointment = "";

  const asUser = <T>(sub: string, run: (tx: postgres.TransactionSql) => Promise<T>) =>
    sql.begin(async (tx) => {
      await tx.unsafe("set local role authenticated");
      await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub, role: "authenticated" })}, true)`;
      return run(tx);
    }) as Promise<T>;
  const count = (sub: string, table: string) => asUser(sub, async (tx) => (await tx.unsafe(`select count(*)::int as n from public.${table}`))[0].n as number);

  beforeAll(async () => {
    sql = postgres(DB_URL, { max: 4, onnotice: () => {} });
    await sql`insert into public.clinics ${sql([
      { id: clinicA, name: `Lab RBAC A ${suffix}`, slug: `lab-rbac-a-${suffix}`, timezone: "Asia/Tashkent" },
      { id: clinicB, name: `Lab RBAC B ${suffix}`, slug: `lab-rbac-b-${suffix}`, timezone: "Asia/Tashkent" },
    ])}`;
    const users = [lab, rec, doctor].map((id, i) => ({ id, email: `lab-rbac-${i}-${suffix}@test.local` }));
    await sql`insert into auth.users ${sql(users)}`;
    await sql`insert into public.profiles ${sql(users.map((u) => ({ id: u.id, full_name: u.email })))}`;
    await sql`insert into public.staff_roles ${sql([
      { clinic_id: clinicA, profile_id: lab, role: "lab_staff" },
      { clinic_id: clinicA, profile_id: rec, role: "receptionist" },
      { clinic_id: clinicA, profile_id: doctor, role: "doctor" },
    ])}`;
    await sql`insert into public.doctors (id, clinic_id, profile_id, name, active) values (${doctorId}, ${clinicA}, ${doctor}, ${`Dr Lab RBAC ${suffix}`}, true)`;
    await sql`insert into public.services (id, clinic_id, name, duration_minutes, price) values (${service}, ${clinicA}, ${`Lab RBAC ${suffix}`}, 30, 1000)`;
    await sql`insert into public.doctor_working_hours ${sql([1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ clinic_id: clinicA, doctor_id: doctorId, weekday, start_time: "00:00", end_time: "23:59" })))}`;
    await sql`insert into public.patients ${sql([
      { id: patient, clinic_id: clinicA, full_name: `Lab RBAC patient ${suffix}`, phone: "+998901119999" },
      { id: patientB, clinic_id: clinicB, full_name: `Lab RBAC patient B ${suffix}`, phone: null },
    ])}`;
    const start = new Date(Date.UTC(2031, 5, 2, 5, 0));
    [{ id: appointment }] = await sql<{ id: string }[]>`insert into public.appointments ${sql({
      clinic_id: clinicA, patient_id: patient, doctor_id: doctorId, service_id: service, start_at: start,
      end_at: new Date(start.getTime() + 30 * 60_000), status: "completed", source: "walk_in",
    })} returning id`;
    await sql`insert into public.payments (clinic_id, appointment_id, patient_id, amount, status) values (${clinicA}, ${appointment}, ${patient}, 1000, 'paid')`.catch(() => {});
    await sql`insert into public.conversations (clinic_id, patient_id, channel, status) values (${clinicA}, ${patient}, 'telegram', 'open')`;
    await sql`insert into public.clinical_records (clinic_id, patient_id, author_doctor_id, appointment_id, record_type, summary, created_by)
              values (${clinicA}, ${patient}, ${doctorId}, ${appointment}, 'consultation_note', ${`Clinical text ${suffix}`}, ${doctor})`;
  });

  afterAll(async () => {
    if (!sql) return;
    await cleanupTestClinics([clinicA, clinicB]);
    await sql`delete from auth.users where id in ${sql([lab, rec, doctor])}`;
    await sql.end({ timeout: 5 });
  });

  it("a technician reads the clinic's configuration like any staff member — and only their own clinic's", async () => {
    expect(await count(lab, "services")).toBeGreaterThan(0);
    expect(await count(lab, "doctors")).toBeGreaterThan(0);
    expect(await count(lab, "clinics")).toBe(1);
    expect(await count(lab, "lab_tests")).toBe(0); // none configured here; the policy answers (no error), clinic-scoped
  });

  it("…and nothing about patients, bookings, money, conversations, referrals or clinical records", async () => {
    // Policies list the roles they admit; an unlisted role gets zero rows (RLS) or no grant at all.
    for (const table of ["patients", "appointments", "payments", "conversations", "messages", "voice_messages", "notification_jobs", "audit_events", "clinic_telegram_integrations"]) {
      let n: number;
      try {
        n = await count(lab, table);
      } catch (e) {
        expect((e as postgres.PostgresError).code, table).toBe("42501");
        continue;
      }
      expect(n, table).toBe(0);
    }
    for (const table of ["referrals", "clinical_records", "lab_orders", "lab_results", "lab_samples", "retention_policies"]) {
      expect((await pgError(() => count(lab, table))).code, table).toBe("42501");
    }
    // The control: the receptionist of the same clinic does see the patient and the appointment.
    expect(await count(rec, "patients")).toBeGreaterThan(0);
    expect(await count(rec, "appointments")).toBeGreaterThan(0);
  });

  it("a technician's token writes nothing, directly: no booking, patient, payment or configuration change", async () => {
    const attempts: Array<[string, () => Promise<unknown>]> = [
      ["update patient", () => asUser(lab, (tx) => tx`update public.patients set full_name = 'x' where id = ${patient} returning id`)],
      ["insert patient", () => asUser(lab, (tx) => tx`insert into public.patients (clinic_id, full_name) values (${clinicA}, 'x')`)],
      ["update appointment", () => asUser(lab, (tx) => tx`update public.appointments set status = 'cancelled' where id = ${appointment}`)],
      ["update payment", () => asUser(lab, (tx) => tx`update public.payments set status = 'refunded' where appointment_id = ${appointment}`)],
      ["insert test", () => asUser(lab, (tx) => tx`insert into public.lab_tests (clinic_id, code, name) values (${clinicA}, 'X', 'x')`)],
      ["update setting", () => asUser(lab, (tx) => tx`insert into public.app_settings (clinic_id, key, value) values (${clinicA}, 'lab', '{}')`)],
      ["staff role", () => asUser(lab, (tx) => tx`update public.staff_roles set role = 'owner' where profile_id = ${lab}`)],
    ];
    for (const [what, run] of attempts) {
      let affected: number | null = null;
      try {
        const res = (await run()) as { length?: number } | undefined;
        affected = res?.length ?? 0;
      } catch (e) {
        expect(["42501", "P0001"], what).toContain((e as postgres.PostgresError).code);
        continue;
      }
      expect(affected, `${what} must change nothing`).toBe(0);
    }
    expect((await sql`select full_name from public.patients where id = ${patient}`)[0].full_name).toBe(`Lab RBAC patient ${suffix}`);
    expect((await sql`select role from public.staff_roles where profile_id = ${lab}`)[0].role).toBe("lab_staff");
    // Server-only decision functions are not callable by a signed-in role.
    expect((await pgError(() => asUser(lab, (tx) => tx`select * from public.doctor_patient_access(${doctorId}, ${patient})`))).code).toBe("42501");
  });

  it("the helpers the database uses agree: is_clinic_staff names the role it admits, and lab_staff is not a doctor", async () => {
    const check = (profile: string, roles: string[] | null) =>
      asUser(profile, async (tx) => (await tx`select public.is_clinic_staff(${clinicA}, ${roles}::public.staff_role[]) as ok`)[0].ok as boolean);
    expect(await check(lab, null)).toBe(true);
    expect(await check(lab, ["lab_staff"])).toBe(true);
    for (const roles of [["owner", "admin", "manager"], ["receptionist"], ["doctor"]]) expect(await check(lab, roles), roles.join()).toBe(false);
    expect((await sql<{ n: number }[]>`select count(*)::int as n from public.doctors where profile_id = ${lab}`)[0].n).toBe(0);
  });
});

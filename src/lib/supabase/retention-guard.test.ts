import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";

/**
 * Retention (20261008000004, owner decision 2026-10-07 §1): the database
 * refuses to delete or truncate clinics, patients, clinical records and
 * referrals — except on a test database, which local development and CI mark
 * with a row in internal.retention_override (supabase/seed.sql). Each refusal
 * below is checked with that row removed inside a rolled-back transaction, so
 * it shows exactly what staging and production do; other suites never see the
 * row missing.
 */

const DB_URL = process.env.SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const ROOT = join(__dirname, "..", "..", "..");

async function probeDatabase(): Promise<string | null> {
  const probe = postgres(DB_URL, { max: 1, connect_timeout: 3, onnotice: () => {} });
  try {
    const [row] = await probe<{ ok: boolean }[]>`select to_regclass('internal.retention_override') is not null as ok`;
    return row.ok ? null : "retention migration not applied — run `npx supabase migration up --local`";
  } catch (e) {
    return `database unreachable via SUPABASE_DB_URL — ${e instanceof Error ? e.message : String(e)}`;
  } finally {
    await probe.end({ timeout: 1 });
  }
}

const unavailable = await probeDatabase();
if (unavailable) process.stderr.write(`\n⚠️  retention guard database suite SKIPPED (${unavailable})\n\n`);
const describeDb = describe.skipIf(unavailable !== null);

class RolledBack extends Error {}

describeDb("retention — the database keeps clinical history", () => {
  let sql: postgres.Sql;
  const suffix = Date.now().toString(36);
  const clinic = randomUUID();
  const ids = { patient: randomUUID(), doctor: randomUUID(), other: randomUUID(), service: randomUUID(), appointment: randomUUID(), record: randomUUID(), referral: randomUUID() };
  const author = randomUUID();

  /** Runs `statement` as on a production database (no test override), then rolls everything back. Returns the refusal. */
  const asProduction = async (statement: (tx: postgres.TransactionSql) => Promise<unknown>) => {
    let refusal: postgres.PostgresError | null = null;
    try {
      await sql.begin(async (tx) => {
        await tx`delete from internal.retention_override`;
        try {
          await tx.savepoint(async (sp) => {
            await statement(sp);
          });
        } catch (e) {
          if (!(e instanceof postgres.PostgresError)) throw e;
          refusal = e;
        }
        // Whatever happened, the rows must still be there.
        const [left] = await tx<{ n: number }[]>`
          select (select count(*) from public.clinics where id = ${clinic})
               + (select count(*) from public.patients where id = ${ids.patient})
               + (select count(*) from public.clinical_records where id = ${ids.record})
               + (select count(*) from public.referrals where id = ${ids.referral}) as n`;
        expect(Number(left.n)).toBe(4);
        throw new RolledBack();
      });
    } catch (e) {
      if (!(e instanceof RolledBack)) throw e;
    }
    return refusal as postgres.PostgresError | null;
  };

  beforeAll(async () => {
    sql = postgres(DB_URL, { max: 4, onnotice: () => {} });
    // Setup rows only: inserted with triggers paused (their validation is tested elsewhere).
    await sql.begin(async (tx) => {
      await tx.unsafe("set local session_replication_role = replica");
      await tx`insert into auth.users ${tx({ id: author, email: `retention-${suffix}@test.local` })}`;
      await tx`insert into public.profiles ${tx({ id: author, full_name: "Retention author" })}`;
      await tx`insert into public.clinics ${tx({ id: clinic, name: `Retention ${suffix}`, slug: `retention-${suffix}`, timezone: "Asia/Tashkent" })}`;
      await tx`insert into public.patients ${tx({ id: ids.patient, clinic_id: clinic, full_name: "Saqlanadigan Bemor", date_of_birth: "1970-01-01", patient_number: 1 })}`;
      await tx`insert into public.doctors ${tx([
        { id: ids.doctor, clinic_id: clinic, name: "Dr A", active: true },
        { id: ids.other, clinic_id: clinic, name: "Dr B", active: true },
      ])}`;
      await tx`insert into public.services ${tx({ id: ids.service, clinic_id: clinic, name: "Ko‘rik", duration_minutes: 20, price: 1 })}`;
      await tx`insert into public.appointments ${tx({ id: ids.appointment, clinic_id: clinic, patient_id: ids.patient, doctor_id: ids.doctor, service_id: ids.service, start_at: "2026-01-05T05:00:00Z", end_at: "2026-01-05T05:20:00Z", status: "completed" })}`;
      await tx`insert into public.clinical_records ${tx({ id: ids.record, clinic_id: clinic, patient_id: ids.patient, author_doctor_id: ids.doctor, appointment_id: ids.appointment, record_type: "consultation_note", summary: "Test", created_by: author })}`;
      await tx`insert into public.referrals ${tx({ id: ids.referral, clinic_id: clinic, patient_id: ids.patient, referring_doctor_id: ids.doctor, referred_to_doctor_id: ids.other, originating_appointment_id: ids.appointment, reason: "Test", created_by: author })}`;
    });
  }, 60_000);

  afterAll(async () => {
    if (!sql) return;
    // A test database: the override lets the suite erase what it made.
    await sql`delete from public.clinics where id = ${clinic}`.catch(async () => {
      await sql.begin(async (tx) => {
        await tx.unsafe("set local session_replication_role = replica");
        for (const t of ["referrals", "clinical_records", "appointments", "services", "doctors", "patients"]) {
          await tx.unsafe(`delete from public.${t} where clinic_id = $1`, [clinic]);
        }
        await tx`delete from public.clinics where id = ${clinic}`;
      });
    });
    await sql`delete from public.profiles where id = ${author}`.catch(() => {});
    await sql`delete from auth.users where id = ${author}`.catch(() => {});
    await sql.end({ timeout: 5 });
  });

  it("refuses to delete a clinic, a patient, a clinical record or a referral", async () => {
    for (const [what, run] of [
      ["clinic", (tx: postgres.TransactionSql) => tx`delete from public.clinics where id = ${clinic}`],
      ["patient", (tx: postgres.TransactionSql) => tx`delete from public.patients where id = ${ids.patient}`],
      ["clinical record", (tx: postgres.TransactionSql) => tx`delete from public.clinical_records where id = ${ids.record}`],
      ["referral", (tx: postgres.TransactionSql) => tx`delete from public.referrals where id = ${ids.referral}`],
    ] as const) {
      const refusal = await asProduction(run);
      expect(refusal, what).not.toBeNull();
      expect(refusal!.code, what).toBe("42501");
      expect(refusal!.hint, what).toBe("retention");
    }
  });

  it("refuses to truncate them", async () => {
    for (const table of ["clinics", "patients", "clinical_records", "referrals"]) {
      const refusal = await asProduction((tx) => tx.unsafe(`truncate table public.${table} cascade`));
      expect(refusal?.hint, table).toBe("retention");
    }
  });

  it("refuses for the API's own roles too — the service role cannot lift it", async () => {
    const refusal = await asProduction(async (tx) => {
      await tx.unsafe("set local role service_role");
      await tx`delete from public.patients where id = ${ids.patient}`;
    });
    expect(refusal?.hint).toBe("retention");

    const [priv] = await sql<Record<string, boolean>[]>`
      select has_schema_privilege('service_role', 'internal', 'usage') as service_usage,
             has_schema_privilege('authenticated', 'internal', 'usage') as auth_usage,
             has_schema_privilege('anon', 'internal', 'usage') as anon_usage,
             has_table_privilege('service_role', 'internal.retention_override', 'insert') as service_insert,
             has_table_privilege('service_role', 'internal.retention_override', 'delete') as service_delete,
             has_function_privilege('service_role', 'public.history_erasure_allowed()', 'execute') as service_fn,
             has_function_privilege('authenticated', 'public.history_erasure_allowed()', 'execute') as auth_fn`;
    expect(Object.values(priv).every((v) => v === false)).toBe(true);
  });

  it("only the local/CI seed marks a test database — never a migration or the production setup file", () => {
    const marker = /insert\s+into\s+internal\.retention_override/i;
    const migrations = readdirSync(join(ROOT, "supabase", "migrations")).filter((f) => f.endsWith(".sql"));
    for (const f of migrations) expect(readFileSync(join(ROOT, "supabase", "migrations", f), "utf8"), f).not.toMatch(marker);
    expect(readFileSync(join(ROOT, "supabase", "full-db-setup.sql"), "utf8")).not.toMatch(marker);
    expect(readFileSync(join(ROOT, "supabase", "seed.sql"), "utf8")).toMatch(marker);
  });

  it("on this test database the override lets suites erase what they create", async () => {
    const [{ on }] = await sql<{ on: boolean }[]>`select exists (select 1 from internal.retention_override) as on`;
    expect(on).toBe(true);
    const scratch = randomUUID();
    await sql`insert into public.clinics ${sql({ id: scratch, name: `Scratch ${suffix}`, slug: `scratch-${suffix}`, timezone: "Asia/Tashkent" })}`;
    await sql`insert into public.patients ${sql({ clinic_id: scratch, full_name: "Scratch", date_of_birth: "1990-01-01" })}`;
    await sql`delete from public.clinics where id = ${scratch}`;
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from public.patients where clinic_id = ${scratch}`;
    expect(n).toBe(0);
  });
});

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { localDbAvailable } from "@/test/local-db";

/**
 * Database audit 2026-10-12 (supabase/migrations/20261012000001_db_audit_alignment.sql):
 * production carried hand-applied changes that were never in the repository.
 * These pin the aligned behaviour so the drift cannot come back unnoticed —
 * the audit actor cannot be forged, conversation history cannot be deleted,
 * and profile visibility follows shared clinics with policies that evaluate
 * auth.uid() once per statement. Catalogue and payment integrity are in
 * tenant-integrity.test.ts.
 */

const DB_URL = process.env.SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const describeDb = describe.skipIf(!localDbAvailable());

type Tx = postgres.TransactionSql;
class RolledBack extends Error {}

describeDb("database audit alignment — one schema on every installation", () => {
  let sql: postgres.Sql;
  const suffix = Date.now().toString(36);
  const clinicA = randomUUID();
  const clinicB = randomUUID();
  const clinicC = randomUUID();
  const p = { managerA: randomUUID(), readerB: randomUUID(), outsiderC: randomUUID(), twoClinics: randomUUID(), forged: randomUUID() };
  const doctorA = randomUUID();

  /** Runs `run` as a signed-in user (or as the server when `sub` is null), then rolls everything back. */
  async function asRolledBack<T>(role: "authenticated" | "service_role", sub: string | null, run: (tx: Tx) => Promise<T>): Promise<T> {
    let out: T | undefined;
    try {
      await sql.begin(async (tx) => {
        await tx.unsafe(`set local role ${role}`);
        await tx`select set_config('request.jwt.claims', ${JSON.stringify(sub ? { sub, role } : { role })}, true)`;
        out = await run(tx);
        throw new RolledBack();
      });
    } catch (e) {
      if (!(e instanceof RolledBack)) throw e;
    }
    return out as T;
  }

  beforeAll(async () => {
    sql = postgres(DB_URL, { max: 4, onnotice: () => {} });
    await sql`insert into public.clinics ${sql([
      { id: clinicA, name: `Audit A ${suffix}`, slug: `audit-a-${suffix}`, timezone: "Asia/Tashkent" },
      { id: clinicB, name: `Audit B ${suffix}`, slug: `audit-b-${suffix}`, timezone: "Asia/Tashkent" },
      { id: clinicC, name: `Audit C ${suffix}`, slug: `audit-c-${suffix}`, timezone: "Asia/Tashkent" },
    ])}`;
    const users = Object.entries(p).map(([name, id]) => ({ id, email: `audit-${name}-${suffix}@test.local` }));
    await sql`insert into auth.users ${sql(users)}`;
    await sql`insert into public.profiles ${sql(users.map((u) => ({ id: u.id, full_name: u.email })))}`;
    // The two-clinic member joined clinic B first, then clinic A.
    await sql`insert into public.staff_roles ${sql({ clinic_id: clinicB, profile_id: p.twoClinics, role: "receptionist" })}`;
    await sql`insert into public.staff_roles ${sql([
      { clinic_id: clinicA, profile_id: p.twoClinics, role: "receptionist" },
      { clinic_id: clinicA, profile_id: p.managerA, role: "manager" },
      { clinic_id: clinicB, profile_id: p.readerB, role: "receptionist" },
      { clinic_id: clinicC, profile_id: p.outsiderC, role: "manager" },
    ])}`;
    await sql`insert into public.doctors ${sql({ id: doctorA, clinic_id: clinicA, name: `Dr Audit ${suffix}`, active: true })}`;
  });

  afterAll(async () => {
    if (!sql) return;
    await sql`delete from public.clinics where id in ${sql([clinicA, clinicB, clinicC])}`;
    await sql`delete from public.profiles where id in ${sql(Object.values(p))}`;
    await sql`delete from auth.users where id in ${sql(Object.values(p))}`;
    await sql.end({ timeout: 5 });
  });

  it("the audit trail records the signed-in user — a session setting cannot forge the actor", async () => {
    const actor = await asRolledBack("authenticated", p.managerA, async (tx) => {
      await tx`select set_config('app.current_user_id', ${p.forged}, true), set_config('app.current_ip', '203.0.113.9', true)`;
      const [block] = await tx<{ id: string }[]>`
        insert into public.doctor_time_blocks (clinic_id, doctor_id, starts_at, ends_at, reason)
        values (${clinicA}, ${doctorA}, now() + interval '30 days', now() + interval '30 days 1 hour', 'absence')
        returning id`;
      await tx.unsafe("reset role");
      const [row] = await tx<{ actor_id: string | null; ip_address: string | null }[]>`
        select actor_id, ip_address from public.audit_events
        where entity_type = 'doctor_time_blocks' and entity_id = ${block.id}`;
      return row;
    });
    expect(actor.actor_id).toBe(p.managerA);
    expect(actor.ip_address).not.toBe("203.0.113.9");

    // The server (no signed-in user) is recorded as the system, whatever the setting says.
    const system = await asRolledBack("service_role", null, async (tx) => {
      await tx`select set_config('app.current_user_id', ${p.forged}, true)`;
      const [block] = await tx<{ id: string }[]>`
        insert into public.doctor_time_blocks (clinic_id, doctor_id, starts_at, ends_at, reason)
        values (${clinicA}, ${doctorA}, now() + interval '31 days', now() + interval '31 days 1 hour', 'absence')
        returning id`;
      await tx.unsafe("reset role");
      const [row] = await tx<{ actor_id: string | null; actor_type: string }[]>`
        select actor_id, actor_type::text from public.audit_events
        where entity_type = 'doctor_time_blocks' and entity_id = ${block.id}`;
      return row;
    });
    expect(system).toEqual({ actor_id: null, actor_type: "system" });
  });

  it("conversation history cannot be deleted by signed-in staff — no policy, no privilege", async () => {
    const policies = await sql`select policyname from pg_policies where schemaname = 'public' and tablename = 'messages' and cmd in ('DELETE', 'ALL')`;
    expect(policies).toEqual([]);
    const [{ granted }] = await sql<{ granted: boolean }[]>`select has_table_privilege('authenticated', 'public.messages', 'DELETE') as granted`;
    expect(granted).toBe(false);
  });

  it("a staff member of two clinics is visible to colleagues of both clinics, and to no one else", async () => {
    const sees = (reader: string) =>
      asRolledBack("authenticated", reader, async (tx) => {
        const rows = await tx<{ id: string }[]>`select id from public.profiles where id = ${p.twoClinics}`;
        return rows.length === 1;
      });
    expect(await sees(p.managerA)).toBe(true);
    expect(await sees(p.readerB)).toBe(true);
    expect(await sees(p.outsiderC)).toBe(false);
    // Everyone still sees their own profile.
    expect(await asRolledBack("authenticated", p.outsiderC, async (tx) => (await tx`select id from public.profiles where id = ${p.outsiderC}`).length)).toBe(1);
  });

  it("profile and platform-admin policies evaluate auth.uid() once per statement (advisor auth_rls_initplan)", async () => {
    const policies = await sql<{ name: string; expr: string }[]>`
      select tablename || '.' || policyname as name, coalesce(qual, '') || ' ' || coalesce(with_check, '') as expr
      from pg_policies where schemaname = 'public' and tablename in ('profiles', 'platform_admins')`;
    expect(policies.length).toBeGreaterThanOrEqual(5);
    for (const { name, expr } of policies) {
      const calls = expr.match(/auth\.uid\(\)/g) ?? [];
      const wrapped = expr.match(/SELECT auth\.uid\(\)/g) ?? [];
      expect(calls.length, name).toBeGreaterThan(0);
      expect(wrapped.length, name).toBe(calls.length);
    }
  });
});

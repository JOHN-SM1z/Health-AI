import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";

/**
 * Claim ownership (20261116000003; audit 2026-11-14 P1-3 / P2-1, spec NT-03),
 * against the real local database:
 * - a webhook claim carries a token; only its holder can finish or release it,
 *   so a slow worker never finishes or releases a newer worker's claim;
 * - notification and SMS claims reject a NULL limit and stamp a lease;
 * - an expired lease is quarantined, and a late worker cannot put a
 *   quarantined job back in the send queue.
 */

const DB_URL = process.env.SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

async function probeDatabase(): Promise<string | null> {
  const probe = postgres(DB_URL, { max: 1, connect_timeout: 3, onnotice: () => {} });
  try {
    const [row] = await probe<{ ready: boolean }[]>`select to_regproc('public.claim_webhook') is not null as ready`;
    return row.ready ? null : "claim ownership migration not applied — run `npm run db:reset-local`";
  } catch (e) {
    return `database unreachable via SUPABASE_DB_URL — ${e instanceof Error ? e.message : String(e)}`;
  } finally {
    await probe.end({ timeout: 1 });
  }
}

const unavailable = await probeDatabase();
if (unavailable) process.stderr.write(`\n⚠️  claim ownership database suite SKIPPED (${unavailable})\n\n`);
const describeDb = describe.skipIf(unavailable !== null);

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

describeDb("claim ownership — webhooks and notification jobs (database layer)", () => {
  let sql: postgres.Sql;
  const suffix = Date.now().toString(36);
  const source = `claim-test-${suffix}`;
  const clinic = randomUUID();

  const as = async <T>(role: "service_role" | "authenticated", run: (tx: Tx) => Promise<T>): Promise<T> =>
    (await sql.begin(async (tx) => {
      await tx.unsafe(`set local role ${role}`);
      return run(tx);
    })) as T;
  const asServer = <T>(run: (tx: Tx) => Promise<T>) => as("service_role", run);

  const claim = (id: string) => asServer(async (tx) => (await tx<{ t: string | null }[]>`select public.claim_webhook(${source}, ${id}) as t`)[0].t);
  const finish = (id: string, token: string) =>
    asServer(async (tx) => (await tx<{ ok: boolean }[]>`select public.finish_webhook(${source}, ${id}, ${token}) as ok`)[0].ok);
  const release = (id: string, token: string) =>
    asServer(async (tx) => (await tx<{ ok: boolean }[]>`select public.release_webhook(${source}, ${id}, ${token}) as ok`)[0].ok);
  const row = async (id: string) =>
    (await sql<{ status: string; claim_token: string | null }[]>`
      select status, claim_token from public.processed_webhooks where source = ${source} and external_id = ${id}`)[0];

  beforeAll(async () => {
    sql = postgres(DB_URL, { max: 4, onnotice: () => {} });
    await sql`insert into public.clinics ${sql({ id: clinic, name: `Claim ${suffix}`, slug: `claim-${suffix}`, timezone: "Asia/Tashkent" })}`;
  });

  afterAll(async () => {
    if (!sql) return;
    await sql`delete from public.processed_webhooks where source = ${source}`;
    await sql`delete from public.notification_jobs where clinic_id = ${clinic}`;
    await sql`delete from public.clinics where id = ${clinic}`;
    await sql.end({ timeout: 2 });
  });

  it("one winner per webhook id; duplicates get no token", async () => {
    const id = randomUUID();
    const results = await Promise.all([claim(id), claim(id), claim(id)]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("only the current claim's token finishes or releases it", async () => {
    const id = randomUUID();
    const a = await claim(id);
    expect(a).toBeTruthy();
    // Worker A's lease expires; worker B reclaims.
    await sql`update public.processed_webhooks set lease_until = now() - interval '1 second' where source = ${source} and external_id = ${id}`;
    const b = await claim(id);
    expect(b).toBeTruthy();
    expect(b).not.toBe(a);

    // Slow worker A can neither release nor finish B's claim.
    expect(await release(id, a!)).toBe(false);
    expect(await finish(id, a!)).toBe(false);
    expect(await row(id)).toEqual({ status: "processing", claim_token: b });

    expect(await finish(id, b!)).toBe(true);
    expect((await row(id)).status).toBe("processed");
    // A processed id is never claimed again.
    expect(await claim(id)).toBeNull();
  });

  it("a released claim can be retried by the next delivery", async () => {
    const id = randomUUID();
    const a = await claim(id);
    expect(await release(id, a!)).toBe(true);
    expect(await claim(id)).toBeTruthy();
  });

  it("legacy token-less finish/release never touch a token-holding claim", async () => {
    const id = randomUUID();
    const token = await claim(id);
    await asServer((tx) => tx`select public.release_webhook_update(${source}, ${id})`);
    await asServer((tx) => tx`select public.finish_webhook_update(${source}, ${id})`);
    expect(await row(id)).toEqual({ status: "processing", claim_token: token });
  });

  it("the claim primitives are server-only", async () => {
    for (const q of [
      (tx: Tx) => tx`select public.claim_webhook(${source}, 'x')`,
      (tx: Tx) => tx`select public.finish_webhook(${source}, 'x', ${randomUUID()})`,
      (tx: Tx) => tx`select public.release_webhook(${source}, 'x', ${randomUUID()})`,
      (tx: Tx) => tx`select public.quarantine_expired_job_claims()`,
    ]) {
      expect((await pgError(() => as("authenticated", q))).code).toBe("42501");
    }
  });

  it("notification and SMS claims reject a NULL limit", async () => {
    for (const fn of ["claim_due_notification_jobs", "claim_due_sms_jobs"]) {
      const err = await pgError(() => asServer((tx) => tx.unsafe(`select * from public.${fn}(null, array['${clinic}']::uuid[])`)));
      expect(err.message).toMatch(/invalid claim limit/);
    }
  });

  it("claims stamp a lease; an expired lease is quarantined and a late worker cannot requeue it", async () => {
    const { job, claimed } = await asServer(async (tx) => {
      // Use the claim's clock and keep the fixture invisible to other workers until it is claimed.
      const [job] = await tx<{ id: string }[]>`
        insert into public.notification_jobs (
          clinic_id, type, channel, recipient_type, patient_telegram_user_id, scheduled_for, idempotency_key
        ) values (${clinic}, 'booking_confirmation', 'telegram', 'patient', 1, now() - interval '1 minute', ${`claim-${suffix}`})
        returning id`;
      const claimed = await tx<{ id: string; claim_token: string | null; lease_until: Date | null }[]>`
        select id, claim_token, lease_until from public.claim_due_notification_jobs(10, array[${clinic}]::uuid[])`;
      return { job, claimed };
    });
    expect(claimed).toHaveLength(1);
    expect(claimed[0].id).toBe(job.id);
    expect(claimed[0].claim_token).toBeTruthy();
    expect(claimed[0].lease_until).toBeTruthy();

    // The worker crashes: its lease runs out.
    await sql`update public.notification_jobs set lease_until = now() - interval '1 second' where id = ${job.id}`;
    const [{ n }] = await asServer((tx) => tx<{ n: number }[]>`select public.quarantine_expired_job_claims() as n`);
    expect(n).toBeGreaterThanOrEqual(1);
    const after = async () => (await sql<{ status: string; claim_token: string | null }[]>`
      select status, claim_token from public.notification_jobs where id = ${job.id}`)[0];
    expect(await after()).toEqual({ status: "quarantined", claim_token: null });

    // A late worker tries to put it back for a retry: refused silently, stays quarantined.
    await sql`update public.notification_jobs set status = 'pending' where id = ${job.id}`;
    expect((await after()).status).toBe("quarantined");
    // A reviewed action may requeue it.
    await sql.begin(async (tx) => {
      await tx`select set_config('health_ai.job_review', 'on', true)`;
      await tx`update public.notification_jobs set status = 'pending' where id = ${job.id}`;
    });
    expect((await after()).status).toBe("pending");
  });
});

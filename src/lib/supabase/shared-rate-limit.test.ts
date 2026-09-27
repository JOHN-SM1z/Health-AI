import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";

/**
 * consume_rate_limit() (supabase/migrations/20260930000003_shared_rate_limits.sql):
 * one count per key shared by every server instance — exact under
 * concurrency, reset per window, and reachable by the server only.
 */

const DB_URL = process.env.SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

async function probeDatabase(): Promise<string | null> {
  const probe = postgres(DB_URL, { max: 1, connect_timeout: 3, onnotice: () => {} });
  try {
    const [row] = await probe<{ ready: boolean }[]>`select to_regproc('public.consume_rate_limit') is not null as ready`;
    return row.ready ? null : "shared rate limit migration not applied — run `npm run db:reset-local`";
  } catch (e) {
    return `database unreachable via SUPABASE_DB_URL — ${e instanceof Error ? e.message : String(e)}`;
  } finally {
    await probe.end({ timeout: 1 });
  }
}

const unavailable = await probeDatabase();
if (unavailable) process.stderr.write(`\n⚠️  shared rate limit database suite SKIPPED (${unavailable})\n\n`);
const describeDb = describe.skipIf(unavailable !== null);

type Verdict = { allowed: boolean; retry_after_seconds: number };

describeDb("shared rate limit (database layer)", () => {
  let sql: postgres.Sql;
  const keys: string[] = [];
  const newKey = () => {
    const key = `test:${randomUUID()}`;
    keys.push(key);
    return key;
  };

  async function consume(key: string, limit: number, windowSeconds: number, role = "service_role"): Promise<Verdict> {
    return (await sql.begin(async (tx) => {
      await tx.unsafe(`set local role ${role}`);
      const [row] = await tx<{ v: Verdict }[]>`select public.consume_rate_limit(${key}, ${limit}, ${windowSeconds}) as v`;
      return row.v;
    })) as Verdict;
  }

  beforeAll(() => {
    sql = postgres(DB_URL, { max: 10, onnotice: () => {} });
  });
  afterAll(async () => {
    if (!sql) return;
    if (keys.length) await sql`delete from public.rate_limit_buckets where key in ${sql(keys)}`;
    await sql.end({ timeout: 5 });
  });

  it("allows exactly the limit, even when the requests race (as from several instances)", async () => {
    const key = newKey();
    const verdicts = await Promise.all(Array.from({ length: 20 }, () => consume(key, 5, 60)));
    expect(verdicts.filter((v) => v.allowed)).toHaveLength(5);
    expect(verdicts.filter((v) => !v.allowed).every((v) => v.retry_after_seconds >= 1 && v.retry_after_seconds <= 60)).toBe(true);
    // Refused requests do not grow the count without bound.
    const [bucket] = await sql<{ hits: number }[]>`select hits from public.rate_limit_buckets where key = ${key}`;
    expect(bucket.hits).toBe(6);
  });

  it("counts each key on its own and starts a new window once the old one ends", async () => {
    const key = newKey();
    const other = newKey();
    expect((await consume(key, 1, 1)).allowed).toBe(true);
    expect((await consume(key, 1, 1)).allowed).toBe(false);
    expect((await consume(other, 1, 1)).allowed).toBe(true);
    await new Promise((r) => setTimeout(r, 1100));
    expect((await consume(key, 1, 1)).allowed).toBe(true);
  });

  it("is the server's alone: signed-in and anonymous roles can neither call it nor touch the counters", async () => {
    for (const role of ["authenticated", "anon"]) {
      await expect(consume(newKey(), 5, 60, role)).rejects.toMatchObject({ code: "42501" });
      await expect(
        sql.begin(async (tx) => {
          await tx.unsafe(`set local role ${role}`);
          return tx`delete from public.rate_limit_buckets`;
        }),
      ).rejects.toMatchObject({ code: "42501" });
    }
    await expect(consume(newKey(), 0, 60)).rejects.toThrow(/invalid key, limit or window/);
  });
});

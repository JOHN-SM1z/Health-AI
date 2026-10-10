import { createHash, randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";

/**
 * Following a walk-in visit's queue in Telegram (20261008000003, owner
 * 2026-10-08) against the real local database: a one-time link (only its
 * hash stored) makes ONE Telegram user a follower of ONE visit; calling the
 * number enqueues "you are called" for the patient's own linked Telegram and
 * every follower. No identity link, no access beyond the queue.
 */

const DB_URL = process.env.SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

async function probeDatabase(): Promise<string | null> {
  const probe = postgres(DB_URL, { max: 1, connect_timeout: 3, onnotice: () => {} });
  try {
    const [row] = await probe<{ ok: boolean }[]>`select to_regclass('public.visit_followers') is not null as ok`;
    return row.ok ? null : "visit follow migration not applied — run `npx supabase migration up --local`";
  } catch (e) {
    return `database unreachable via SUPABASE_DB_URL — ${e instanceof Error ? e.message : String(e)}`;
  } finally {
    await probe.end({ timeout: 1 });
  }
}

const unavailable = await probeDatabase();
if (unavailable) process.stderr.write(`\n⚠️  visit follow database suite SKIPPED (${unavailable})\n\n`);
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
const newToken = () => randomBytes(24).toString("base64url");
const hash = (token: string) => createHash("sha256").update(token).digest("hex");

describeDb("visit follow — database layer", () => {
  let sql: postgres.Sql;
  const suffix = Date.now().toString(36);
  const clinic = randomUUID();
  const otherClinic = randomUUID();
  const test = randomUUID();
  const profiles = { reception: randomUUID(), cashier: randomUUID(), lab: randomUUID(), dr: randomUUID() };
  const tg = { patient: 7_000_000_000 + Math.floor(Math.random() * 1e6), a: 8_100_000_001, b: 8_100_000_002 };

  const asServer = async <T>(run: (tx: Tx) => Promise<T>): Promise<T> =>
    (await sql.begin(async (tx) => {
      await tx.unsafe("set local role service_role");
      await tx`select set_config('request.jwt.claims', ${JSON.stringify({ role: "service_role" })}, true)`;
      return run(tx);
    })) as T;

  /** A paid, queued laboratory walk-in. */
  const queuedVisit = async (telegramUserId: number | null = null) => {
    const [p] = await sql<{ id: string }[]>`insert into public.patients ${sql({ clinic_id: clinic, full_name: `Navbat ${randomUUID().slice(0, 6)}`, date_of_birth: "1980-01-02", telegram_user_id: telegramUserId })} returning id`;
    const r = await asServer(async (tx) => {
      const [row] = await tx<{ r: { visit_id: string } }[]>`
        select public.register_lab_arrival(${clinic}, ${profiles.reception}, ${randomUUID()}, ${p.id}, null, ${[test]}::uuid[], ${[]}::uuid[]) as r`;
      return row.r;
    });
    await asServer((tx) => tx`select public.record_visit_payment(${clinic}, ${profiles.cashier}, ${r.visit_id}, ${randomUUID()}, ${tx.json([{ method: "cash", amount: 20000 }])}, 20000)`);
    return r.visit_id;
  };
  const issue = (visit: string, token: string, actor = profiles.cashier, clinicId = clinic) =>
    asServer((tx) => tx`select public.create_visit_follow_token(${clinicId}, ${actor}, ${visit}, ${hash(token)})`);
  const claim = async (token: string, user: number, clinicId = clinic) =>
    (await asServer((tx) => tx<{ r: { status: string; visit_id?: string } }[]>`select public.claim_visit_follow_token(${clinicId}, ${hash(token)}, ${user}) as r`))[0].r;
  const call = (visit: string, expected = "waiting") =>
    asServer((tx) => tx`select public.transition_visit(${clinic}, ${profiles.reception}, ${visit}, ${expected}, 'called', null)`);
  const calledJobs = (visit: string) =>
    sql<{ patient_telegram_user_id: string }[]>`select patient_telegram_user_id from public.notification_jobs where visit_id = ${visit} and type = 'queue_called' order by created_at, patient_telegram_user_id`;

  beforeAll(async () => {
    sql = postgres(DB_URL, { max: 10, onnotice: () => {} });
    await sql`insert into public.clinics ${sql([
      { id: clinic, name: `Follow ${suffix}`, slug: `follow-${suffix}`, timezone: "Asia/Tashkent" },
      { id: otherClinic, name: `Follow B ${suffix}`, slug: `follow-b-${suffix}`, timezone: "Asia/Tashkent" },
    ])}`;
    const users = Object.entries(profiles).map(([name, id]) => ({ id, email: `follow-${name}-${suffix}@test.local` }));
    await sql`insert into auth.users ${sql(users)}`;
    await sql`insert into public.profiles ${sql(users.map((u) => ({ id: u.id, full_name: u.email })))}`;
    await sql`insert into public.staff_roles ${sql([
      { clinic_id: clinic, profile_id: profiles.reception, role: "receptionist" },
      { clinic_id: clinic, profile_id: profiles.cashier, role: "cashier" },
      { clinic_id: clinic, profile_id: profiles.lab, role: "lab" },
      { clinic_id: clinic, profile_id: profiles.dr, role: "doctor" },
    ])}`;
    await sql`insert into public.lab_tests ${sql({ id: test, clinic_id: clinic, code: `FW${suffix}`.slice(0, 30), name: "Qon guruhi", sample_type: "Qon", price: 20000 })}`;
    await sql`insert into public.app_settings (clinic_id, key, value) values (${clinic}, 'lab', ${sql.json({ paymentPolicy: "before_collection" })})`;
  }, 60_000);

  afterAll(async () => {
    if (!sql) return;
    await sql.begin(async (tx) => {
      await tx.unsafe("set local session_replication_role = replica");
      for (const c of [clinic, otherClinic]) {
        await tx`delete from public.visit_followers where clinic_id = ${c}`;
        await tx`delete from public.visit_follow_tokens where clinic_id = ${c}`;
        await tx`delete from public.visit_transactions where clinic_id = ${c}`;
        await tx`delete from public.visit_charges where clinic_id = ${c}`;
        await tx`delete from public.notification_jobs where clinic_id = ${c}`;
        await tx`update public.lab_orders set visit_id = null where clinic_id = ${c}`;
        await tx`delete from public.visits where clinic_id = ${c}`;
      }
    });
    await sql`delete from public.clinics where id in ${sql([clinic, otherClinic])}`;
    await sql`delete from auth.users where id in ${sql(Object.values(profiles))}`;
    await sql.end({ timeout: 5 });
  });

  it("a link is claimed once, by one Telegram user; only its hash is stored", async () => {
    const visit = await queuedVisit();
    const token = newToken();
    await issue(visit, token);
    const stored = await sql<{ token_hash: string }[]>`select token_hash from public.visit_follow_tokens where visit_id = ${visit}`;
    expect(stored.map((r) => r.token_hash)).toEqual([hash(token)]);
    expect(JSON.stringify(stored)).not.toContain(token);

    expect(await claim(token, tg.a)).toEqual({ status: "subscribed", visit_id: visit });
    // The same person scanning again is fine; anyone else is refused.
    expect(await claim(token, tg.a)).toEqual({ status: "already", visit_id: visit });
    expect(await claim(token, tg.b)).toEqual({ status: "invalid" });
    expect(await claim(newToken(), tg.b)).toEqual({ status: "invalid" });
    const followers = await sql`select telegram_user_id from public.visit_followers where visit_id = ${visit}`;
    expect(followers.map((f) => Number(f.telegram_user_id))).toEqual([tg.a]);
  });

  it("eight people scanning the same QR at once: exactly one follows", async () => {
    const visit = await queuedVisit();
    const token = newToken();
    await issue(visit, token);
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => claim(token, 8_200_000_000 + i)));
    expect(results.filter((r) => r.status === "subscribed")).toHaveLength(1);
    expect(results.filter((r) => r.status === "invalid")).toHaveLength(7);
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from public.visit_followers where visit_id = ${visit}`;
    expect(n).toBe(1);
  });

  it("refuses an expired link, another clinic's bot, a finished visit, and a replaced link", async () => {
    const visit = await queuedVisit();
    const expired = newToken();
    await issue(visit, expired);
    await sql`update public.visit_follow_tokens set expires_at = now() - interval '1 second' where token_hash = ${hash(expired)}`;
    expect(await claim(expired, tg.a)).toEqual({ status: "invalid" });

    const wrongBot = newToken();
    await issue(visit, wrongBot);
    expect(await claim(wrongBot, tg.a, otherClinic)).toEqual({ status: "invalid" });

    // A new link replaces an unused one.
    const first = newToken();
    const second = newToken();
    await issue(visit, first);
    await issue(visit, second);
    expect(await claim(first, tg.a)).toEqual({ status: "invalid" });
    expect((await claim(second, tg.a)).status).toBe("subscribed");

    // Finished: no new link, and an unused one no longer works.
    const late = newToken();
    await issue(visit, late);
    await asServer((tx) => tx`select public.transition_visit(${clinic}, ${profiles.lab}, ${visit}, 'waiting', 'in_progress', null)`);
    await asServer((tx) => tx`select public.transition_visit(${clinic}, ${profiles.lab}, ${visit}, 'in_progress', 'completed', null)`);
    expect(await claim(late, tg.b)).toEqual({ status: "invalid" });
    expect((await pgError(() => issue(visit, newToken()))).hint).toBe("visit_finished");
  });

  it("calling the number tells the patient's own Telegram and every follower — once per call", async () => {
    const visit = await queuedVisit(tg.patient);
    for (const user of [tg.a, tg.b]) {
      const token = newToken();
      await issue(visit, token);
      await claim(token, user);
    }
    await call(visit);
    expect((await calledJobs(visit)).map((j) => Number(j.patient_telegram_user_id)).sort()).toEqual([tg.patient, tg.a, tg.b].sort());

    // Sent back to the queue and called again: a new call, new messages.
    await asServer((tx) => tx`select public.transition_visit(${clinic}, ${profiles.reception}, ${visit}, 'called', 'waiting', null)`);
    await call(visit);
    expect(await calledJobs(visit)).toHaveLength(6);

    // A visit nobody follows and with no linked Telegram: nothing to send.
    const quiet = await queuedVisit();
    await call(quiet);
    expect(await calledJobs(quiet)).toHaveLength(0);
  });

  it("only the desk and the kassa issue links; signed-in roles cannot touch the tables or functions", async () => {
    const visit = await queuedVisit();
    expect((await pgError(() => issue(visit, newToken(), profiles.dr))).code).toBe("42501");
    expect((await pgError(() => issue(visit, newToken(), profiles.lab))).code).toBe("42501");
    expect((await pgError(() => issue(visit, newToken(), profiles.cashier, otherClinic))).code).toBe("42501");
    await issue(visit, newToken(), profiles.reception);

    const [priv] = await sql<{ t1: boolean; t2: boolean; f1: boolean; f2: boolean }[]>`
      select has_table_privilege('authenticated', 'public.visit_follow_tokens', 'select') as t1,
             has_table_privilege('authenticated', 'public.visit_followers', 'select') as t2,
             has_function_privilege('authenticated', 'public.create_visit_follow_token(uuid,uuid,uuid,text)', 'execute') as f1,
             has_function_privilege('authenticated', 'public.claim_visit_follow_token(uuid,text,bigint)', 'execute') as f2`;
    expect(priv).toEqual({ t1: false, t2: false, f1: false, f2: false });

    // Audit rows carry ids only — never the token or a Telegram id.
    const token = newToken();
    await issue(visit, token);
    await claim(token, tg.b);
    const audit = await sql`select action, new_values from public.audit_events where clinic_id = ${clinic} and entity_id = ${visit} and action like 'visit_follow%'`;
    expect(audit.map((a) => a.action).sort()).toEqual(["visit_follow_link_created", "visit_follow_link_created", "visit_followed"]);
    const text = JSON.stringify(audit);
    expect(text).not.toContain(token);
    expect(text).not.toContain(hash(token));
    expect(text).not.toContain(String(tg.b));
  });
});

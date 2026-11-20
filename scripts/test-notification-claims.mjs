// Rehearse the actual worker migrations in a new local-only disposable DB.
// No environment files are loaded and no existing application data is read.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import postgres from "postgres";

const url = process.env.SUPABASE_DB_URL;
if (!url) throw new Error("Set SUPABASE_DB_URL to a disposable local PostgreSQL administrator connection.");
let target;
try { target = new URL(url); } catch { throw new Error("Notification migration tests require a valid local PostgreSQL connection."); }
if (!["postgres:", "postgresql:"].includes(target.protocol) || !["localhost", "127.0.0.1", "[::1]"].includes(target.hostname) || target.search) {
  throw new Error("Notification migration tests require a loopback connection without query overrides.");
}
const admin = postgres(url, { max: 1, onnotice: () => {} });
const name = `healthai_claims_${randomUUID().replaceAll("-", "")}`;
let db;
let checks = 0;
try {
  await admin.unsafe(`create database ${name}`);
  const isolated = new URL(url);
  isolated.pathname = `/${name}`;
  db = postgres(isolated.toString(), { max: 4, onnotice: () => {} });
  await db.unsafe(`
    do $$ begin
      if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
      if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
      if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
    end $$;
    create type public.notification_job_status as enum ('pending', 'in_progress', 'sent', 'failed', 'skipped', 'cancelled');
    create table public.processed_webhooks (
      source text, external_id text, status text, processed_at timestamptz default now(), primary key (source, external_id)
    );
    create table public.notification_jobs (
      id uuid primary key default gen_random_uuid(), clinic_id uuid not null,
      conversation_id uuid,
      status public.notification_job_status not null default 'pending', channel text not null,
      scheduled_for timestamptz default now(), updated_at timestamptz default now(),
      attempts integer not null default 0, max_attempts integer not null default 3,
      error text, sent_at timestamptz, telegram_message_id bigint
    );
    create table public.conversations (id uuid primary key, clinic_id uuid not null, status text not null);
    alter table public.notification_jobs enable row level security;
    alter table public.processed_webhooks enable row level security;
    grant usage on schema public to anon, authenticated, service_role;
    alter table public.conversations enable row level security;
    grant select, insert, update, delete on public.notification_jobs, public.processed_webhooks, public.conversations to service_role;
  `);
  for (const file of [
    "20261116000002_job_status_quarantined.sql",
    "20261116000003_claim_ownership.sql",
    "20261120133717_notification_worker_fencing.sql",
  ]) {
    // Each statement file is committed before the next enum value is used.
    await db.unsafe(await readFile(new URL(`../supabase/migrations/${file}`, import.meta.url), "utf8"));
  }
  const clinic = randomUUID();
  const service = (run) => db.begin(async (tx) => { await tx`set local role service_role`; return run(tx); });
  const addJob = async () => (await db`insert into public.notification_jobs (clinic_id, channel) values (${clinic}, 'telegram') returning id`)[0].id;
  const claim = async () => service((tx) => tx`select * from public.claim_due_notification_jobs(1, array[${clinic}]::uuid[])`);
  const renew = async (id, token, tenant = clinic) => service(async (tx) => (await tx`select public.renew_notification_job_claim(${tenant}, ${id}, ${token}) as ok`)[0].ok);
  const finish = async (id, token, status = "sent", tenant = clinic) => service(async (tx) => (await tx`select public.finish_notification_job_claim(${tenant}, ${id}, ${token}, ${status}, null, 42) as ok`)[0].ok);
  const check = (label, test) => { assert.ok(test, label); checks++; console.log(`PASS ${label}`); };

  const id = await addJob();
  const winners = (await Promise.all([claim(), claim(), claim()])).flat();
  check("concurrent workers have one claim winner", winners.length === 1);
  const token = winners[0].claim_token;
  check("wrong token cannot renew", await renew(id, randomUUID()) === false);
  check("wrong clinic cannot renew", await renew(id, token, randomUUID()) === false);
  check("wrong token cannot finalize", await finish(id, randomUUID()) === false);
  check("wrong clinic cannot finalize", await finish(id, token, "sent", randomUUID()) === false);
  check("current worker renews before provider I/O", await renew(id, token) === true);
  check("current worker records provider acceptance", await finish(id, token) === true);
  const [sent] = await db`select status, attempts, claim_token, lease_until, telegram_message_id, sent_at is not null as stamped from public.notification_jobs where id = ${id}`;
  check("accepted outcome is saved and its claim cleared", sent.status === "sent" && sent.attempts === 1 && sent.claim_token === null && sent.lease_until === null && sent.telegram_message_id === "42" && sent.stamped);
  check("same acceptance cannot be replayed", await finish(id, token) === false);

  const retryId = await addJob();
  const [retryClaim] = await claim();
  check("definite pre-send failure can schedule a retry", await finish(retryId, retryClaim.claim_token, "pending") === true);
  const [retry] = await db`select status, scheduled_for > now() as deferred from public.notification_jobs where id = ${retryId}`;
  check("retry uses the database clock and delay", retry.status === "pending" && retry.deferred);
  await db`update public.notification_jobs set scheduled_for = now() where id = ${retryId}`;
  const [newClaim] = await claim();
  check("old worker cannot finalize a newer claim", await finish(retryId, retryClaim.claim_token) === false);
  check("uncertain provider outcome is quarantined", await finish(retryId, newClaim.claim_token, "quarantined") === true);

  const expiredId = await addJob();
  const [expired] = await claim();
  await db`update public.notification_jobs set lease_until = now() - interval '1 second' where id = ${expiredId}`;
  check("expired claim cannot renew", await renew(expiredId, expired.claim_token) === false);
  check("expired claim cannot report success", await finish(expiredId, expired.claim_token) === false);
  await service((tx) => tx`select public.quarantine_expired_job_claims()`);
  const [quarantined] = await db`select status from public.notification_jobs where id = ${expiredId}`;
  check("expired send is quarantined without replay", quarantined.status === "quarantined");
  const cancelledId = await addJob();
  const [cancelled] = await claim();
  await db`update public.notification_jobs set status = 'cancelled' where id = ${cancelledId}`;
  check("cancelled claim cannot send", await renew(cancelledId, cancelled.claim_token) === false);
  check("late acceptance cannot overwrite cancellation", await finish(cancelledId, cancelled.claim_token) === false);
  const heldId = await addJob();
  const [held] = await claim();
  const conversationId = randomUUID();
  await db`insert into public.conversations (id, clinic_id, status) values (${conversationId}, ${clinic}, 'assigned')`;
  await db`update public.notification_jobs set conversation_id = ${conversationId} where id = ${heldId}`;
  check("human takeover blocks the send even after preparation", await renew(heldId, held.claim_token) === false);
  for (const role of ["anon", "authenticated"]) {
    await assert.rejects(db.begin(async (tx) => {
      await tx.unsafe(`set local role ${role}`);
      await tx`select public.renew_notification_job_claim(${clinic}, ${id}, ${token})`;
    }), (e) => e.code === "42501");
    check(`${role} cannot invoke worker mutation`, true);
  }
  await assert.rejects(service((tx) => tx`select public.finish_notification_job_claim(${clinic}, ${id}, ${token}, 'in_progress')`), (e) => e.code === "22023");
  check("invalid worker outcomes are refused", true);
  console.log(`${checks} notification claim migration checks passed on PostgreSQL ${(await db`show server_version`)[0].server_version}.`);
} finally {
  if (db) await db.end({ timeout: 2 });
  await admin.unsafe(`drop database if exists ${name} with (force)`);
  await admin.end({ timeout: 2 });
}

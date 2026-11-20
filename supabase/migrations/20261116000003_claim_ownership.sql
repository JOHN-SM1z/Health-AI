-- Audit 2026-11-14 P1-3 and P2-1 / spec NT-03.
--
-- 1. Webhook claims get an ownership token and a lease. finish/release act only
--    with the token of the current claim, so a slow worker can no longer finish
--    or release a newer worker's claim. The legacy token-less functions keep
--    working for the app version that is deployed now, but only on token-less
--    claims, so old and new workers never touch each other's rows.
-- 2. Notification and SMS claims reject a NULL limit (LIMIT NULL is unbounded),
--    and stamp claim_token + lease_until on every claimed job.
-- 3. quarantine_expired_job_claims() moves in_progress jobs whose lease expired
--    (a crashed worker) to 'quarantined' for review. Nothing is resent.

-- ---------- 1. Webhooks ----------
alter table public.processed_webhooks
  add column if not exists claim_token uuid,
  add column if not exists lease_until timestamptz;

create or replace function public.claim_webhook(p_source text, p_external_id text, p_lease_seconds integer default 300)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_token uuid := gen_random_uuid();
begin
  if p_source is null or p_external_id is null or p_lease_seconds is null
     or p_lease_seconds < 30 or p_lease_seconds > 3600 then
    raise exception 'invalid webhook claim';
  end if;
  insert into public.processed_webhooks (source, external_id, status, claim_token, lease_until)
  values (p_source, p_external_id, 'processing', v_token, now() + make_interval(secs => p_lease_seconds))
  on conflict (source, external_id) do update
    set status = 'processing', processed_at = now(), claim_token = excluded.claim_token, lease_until = excluded.lease_until
  where public.processed_webhooks.status = 'processing'
    and coalesce(public.processed_webhooks.lease_until, public.processed_webhooks.processed_at + interval '5 minutes') < now();
  if found then
    return v_token;
  end if;
  return null;
end;
$$;

create or replace function public.finish_webhook(p_source text, p_external_id text, p_claim_token uuid)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_claim_token is null then
    raise exception 'claim token required';
  end if;
  update public.processed_webhooks
     set status = 'processed', processed_at = now(), lease_until = null
   where source = p_source and external_id = p_external_id
     and status = 'processing' and claim_token = p_claim_token;
  return found;
end;
$$;

create or replace function public.release_webhook(p_source text, p_external_id text, p_claim_token uuid)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_claim_token is null then
    raise exception 'claim token required';
  end if;
  delete from public.processed_webhooks
   where source = p_source and external_id = p_external_id
     and status = 'processing' and claim_token = p_claim_token;
  return found;
end;
$$;

-- Legacy (token-less) functions: only ever act on token-less claims.
create or replace function public.claim_webhook_update(p_source text, p_external_id text)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.processed_webhooks (source, external_id, status)
  values (p_source, p_external_id, 'processing')
  on conflict (source, external_id) do update
    set status = 'processing', processed_at = now(), claim_token = null, lease_until = null
  where public.processed_webhooks.status = 'processing'
    and coalesce(public.processed_webhooks.lease_until, public.processed_webhooks.processed_at + interval '5 minutes') < now();
  return found;
end;
$$;

create or replace function public.finish_webhook_update(p_source text, p_external_id text)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  update public.processed_webhooks
     set status = 'processed', processed_at = now()
   where source = p_source and external_id = p_external_id
     and status = 'processing' and claim_token is null;
$$;

create or replace function public.release_webhook_update(p_source text, p_external_id text)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  delete from public.processed_webhooks
   where source = p_source and external_id = p_external_id
     and status = 'processing' and claim_token is null;
$$;

revoke execute on function public.claim_webhook(text, text, integer) from public, anon, authenticated;
revoke execute on function public.finish_webhook(text, text, uuid) from public, anon, authenticated;
revoke execute on function public.release_webhook(text, text, uuid) from public, anon, authenticated;
grant execute on function public.claim_webhook(text, text, integer) to service_role;
grant execute on function public.finish_webhook(text, text, uuid) to service_role;
grant execute on function public.release_webhook(text, text, uuid) to service_role;

-- ---------- 2. Notification and SMS claims ----------
alter table public.notification_jobs
  add column if not exists claim_token uuid,
  add column if not exists lease_until timestamptz;

create index if not exists notification_jobs_expired_lease_idx
  on public.notification_jobs (lease_until) where status = 'in_progress';

create or replace function public.claim_due_notification_jobs(p_limit integer, p_clinic_ids uuid[] default null)
returns setof public.notification_jobs
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_token uuid := gen_random_uuid();
begin
  if p_limit is null or p_limit < 1 or p_limit > 200 then
    raise exception 'invalid claim limit';
  end if;

  return query
  update public.notification_jobs nj
     set status = 'in_progress'::public.notification_job_status,
         claim_token = v_token,
         lease_until = now() + interval '10 minutes',
         updated_at = now()
   where nj.id in (
     select id from public.notification_jobs
      where status = 'pending'::public.notification_job_status
        and channel = 'telegram'
        and scheduled_for <= now()
        and (p_clinic_ids is null or clinic_id = any (p_clinic_ids))
      order by scheduled_for asc
      limit p_limit
      for update skip locked)
  returning nj.*;
end;
$$;

create or replace function public.claim_due_sms_jobs(p_limit integer, p_clinic_ids uuid[] default null)
returns setof public.notification_jobs
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_token uuid := gen_random_uuid();
begin
  if p_limit is null or p_limit < 1 or p_limit > 200 then
    raise exception 'invalid claim limit';
  end if;

  return query
  update public.notification_jobs nj
     set status = 'in_progress'::public.notification_job_status,
         claim_token = v_token,
         lease_until = now() + interval '10 minutes',
         updated_at = now()
   where nj.id in (
     select id from public.notification_jobs
      where status = 'pending'::public.notification_job_status
        and channel = 'sms'
        and scheduled_for <= now()
        and (p_clinic_ids is null or clinic_id = any (p_clinic_ids))
      order by scheduled_for
      limit p_limit
      for update skip locked)
  returning nj.*;
end;
$$;

-- ---------- 3. Quarantine of expired claims ----------
create or replace function public.quarantine_expired_job_claims()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_count integer;
begin
  update public.notification_jobs
     set status = 'quarantined'::public.notification_job_status,
         error = 'claim lease expired; review before resending',
         claim_token = null,
         updated_at = now()
   where status = 'in_progress'::public.notification_job_status
     and coalesce(lease_until, updated_at + interval '10 minutes') < now();
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke execute on function public.quarantine_expired_job_claims() from public, anon, authenticated;
grant execute on function public.quarantine_expired_job_claims() to service_role;
comment on function public.quarantine_expired_job_claims() is
  'Moves in_progress notification/SMS jobs whose claim lease expired (crashed worker) to quarantined for human review. Never resends. Server-only.';

-- ---------- 4. Guard on job finalization ----------
-- Leaving in_progress clears the claim. A quarantined job is never put back in
-- the send queue by a late worker: only a reviewed action (which sets
-- health_ai.job_review = 'on' for its transaction) may move it to pending.
-- A late worker recording that it did send ('sent') is kept, because it is true.
create or replace function public.notification_jobs_claim_guard()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if old.status = 'quarantined'::public.notification_job_status
     and new.status = 'pending'::public.notification_job_status
     and coalesce(current_setting('health_ai.job_review', true), '') <> 'on' then
    new.status := old.status;
    new.scheduled_for := old.scheduled_for;
  end if;
  if new.status <> 'in_progress'::public.notification_job_status then
    new.claim_token := null;
    new.lease_until := null;
  end if;
  return new;
end;
$$;

drop trigger if exists notification_jobs_claim_guard on public.notification_jobs;
create trigger notification_jobs_claim_guard
  before update on public.notification_jobs
  for each row execute function public.notification_jobs_claim_guard();

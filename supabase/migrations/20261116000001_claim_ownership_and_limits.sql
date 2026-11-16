-- Claim ownership for webhook idempotency, bounded job claims, and quarantine of abandoned job claims.
-- Spec: docs/TECHNICAL_SPECIFICATION.html NT-03; audit docs/DATABASE_AUDIT_2026-11-14.md (P1-3, P2-1).
--
-- 1. Webhooks. claim_webhook_update() re-claims a 'processing' row after 5 minutes, but finish/release acted on the key
--    alone: a slow worker A could finish or delete worker B's newer claim, letting a third worker claim while B was
--    still producing side effects. Every claim now carries a random claim_token. claim_webhook_update_token() returns
--    it; finish/release with a token touch the row only while that token still owns it. The 2-argument functions keep
--    working unchanged for already-deployed code (they still set a token on claim).
-- 2. Job claims. "p_limit < 1 or p_limit > 200" is unknown for NULL, and LIMIT NULL is unbounded. NULL is rejected.
-- 3. Job ownership and leases. Each claim call stamps its rows with one claim_token and a 15-minute lease_until. The
--    workers write a job's outcome only while status = 'in_progress' and the token is still theirs, so a slow worker
--    can never put a quarantined job back to 'pending' (which would send it twice).
-- 4. Quarantine. A worker killed after claiming leaves rows 'in_progress' forever. Each claim first moves this channel's
--    rows whose lease has expired to 'failed' with error 'stale_claim_needs_review' and clears the token. 'failed' is
--    terminal: they are never resent automatically, because the message may already have been delivered. Staff review
--    them. Rows claimed before this migration have no lease; they count as expired 15 minutes after their last update.

alter table public.processed_webhooks add column if not exists claim_token uuid;
alter table public.notification_jobs add column if not exists claim_token uuid;
alter table public.notification_jobs add column if not exists lease_until timestamptz;

create or replace function public.claim_webhook_update_token(p_source text, p_external_id text)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_token uuid := gen_random_uuid();
begin
  if p_source is null or p_external_id is null then
    raise exception 'webhook claim: source and external id are required';
  end if;
  insert into public.processed_webhooks (source, external_id, status, claim_token)
  values (p_source, p_external_id, 'processing', v_token)
  on conflict (source, external_id) do update
    set status = 'processing', processed_at = now(), claim_token = v_token
  where public.processed_webhooks.status = 'processing'
    and public.processed_webhooks.processed_at < now() - interval '5 minutes';
  if found then
    return v_token;
  end if;
  return null;
end;
$$;

create or replace function public.claim_webhook_update(p_source text, p_external_id text)
returns boolean
language sql
security definer
set search_path = public, pg_temp
as $$
  select public.claim_webhook_update_token(p_source, p_external_id) is not null;
$$;

drop function if exists public.finish_webhook_update(text, text);
create function public.finish_webhook_update(p_source text, p_external_id text, p_claim_token uuid default null)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.processed_webhooks
     set status = 'processed', processed_at = now()
   where source = p_source and external_id = p_external_id
     and status = 'processing'
     and (p_claim_token is null or claim_token = p_claim_token);
  return found;
end;
$$;

drop function if exists public.release_webhook_update(text, text);
create function public.release_webhook_update(p_source text, p_external_id text, p_claim_token uuid default null)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  delete from public.processed_webhooks
   where source = p_source and external_id = p_external_id
     and status = 'processing'
     and (p_claim_token is null or claim_token = p_claim_token);
  return found;
end;
$$;

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

  update public.notification_jobs
     set status = 'failed'::public.notification_job_status, error = 'stale_claim_needs_review',
         claim_token = null, lease_until = null, updated_at = now()
   where status = 'in_progress'::public.notification_job_status
     and channel = 'telegram'
     and coalesce(lease_until, updated_at + interval '15 minutes') < now()
     and (p_clinic_ids is null or clinic_id = any (p_clinic_ids));

  return query
  update public.notification_jobs nj
     set status = 'in_progress'::public.notification_job_status, updated_at = now(),
         claim_token = v_token, lease_until = now() + interval '15 minutes'
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

  update public.notification_jobs
     set status = 'failed'::public.notification_job_status, error = 'stale_claim_needs_review',
         claim_token = null, lease_until = null, updated_at = now()
   where status = 'in_progress'::public.notification_job_status
     and channel = 'sms'
     and coalesce(lease_until, updated_at + interval '15 minutes') < now()
     and (p_clinic_ids is null or clinic_id = any (p_clinic_ids));

  return query
  update public.notification_jobs nj
     set status = 'in_progress'::public.notification_job_status, updated_at = now(),
         claim_token = v_token, lease_until = now() + interval '15 minutes'
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

revoke all on function public.claim_webhook_update_token(text, text) from public, anon, authenticated;
revoke all on function public.claim_webhook_update(text, text) from public, anon, authenticated;
revoke all on function public.finish_webhook_update(text, text, uuid) from public, anon, authenticated;
revoke all on function public.release_webhook_update(text, text, uuid) from public, anon, authenticated;
revoke all on function public.claim_due_notification_jobs(integer, uuid[]) from public, anon, authenticated;
revoke all on function public.claim_due_sms_jobs(integer, uuid[]) from public, anon, authenticated;
grant execute on function public.claim_webhook_update_token(text, text) to service_role;
grant execute on function public.claim_webhook_update(text, text) to service_role;
grant execute on function public.finish_webhook_update(text, text, uuid) to service_role;
grant execute on function public.release_webhook_update(text, text, uuid) to service_role;
grant execute on function public.claim_due_notification_jobs(integer, uuid[]) to service_role;
grant execute on function public.claim_due_sms_jobs(integer, uuid[]) to service_role;

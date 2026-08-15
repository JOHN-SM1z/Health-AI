-- 0014: Release-blocker remediation.
--
-- 1. Booking RPCs become service_role-only. They are SECURITY DEFINER and
--    were executable by `authenticated`, letting any signed-in user create
--    or reschedule appointments for ANY clinic/patient. All real client
--    paths run server-side with the service-role client, so revoking
--    `authenticated` (and PUBLIC/anon) closes direct-RPC abuse without
--    breaking the app. Staff panels use RLS-scoped table access instead.
--
-- 2. notification_jobs gains an 'in_progress' state so a worker can
--    atomically claim a batch of due jobs before doing any side effects.
--
-- 3. claim_due_notification_jobs(p_limit) atomically claims due jobs with
--    FOR UPDATE SKIP LOCKED; concurrent workers never claim the same job.
--
-- 4. processed_webhooks gains a status column and
--    claim_webhook_update(source, external_id) atomically claims an update
--    (INSERT .. ON CONFLICT DO NOTHING). Duplicate deliveries are detected
--    without a check-then-insert race. A failed handler releases the claim
--    so Telegram retries safely.

-- ---------- 1. RPC authorization ----------

revoke all on function public.book_appointment(uuid, uuid, uuid, uuid, timestamptz, public.appointment_status, public.appointment_source, text, uuid) from public, anon, authenticated;

revoke all on function public.reschedule_appointment(uuid, timestamptz, uuid) from public, anon, authenticated;

grant execute on function public.book_appointment(uuid, uuid, uuid, uuid, timestamptz, public.appointment_status, public.appointment_source, text, uuid) to service_role;

grant execute on function public.reschedule_appointment(uuid, timestamptz, uuid) to service_role;

-- ---------- 2. notification_jobs claim state ----------

alter type public.notification_job_status add value 'in_progress' before 'sent';

-- ---------- 3. Atomic notification job claim ----------

-- Claims up to p_limit due jobs in one statement. Only the rows RETURNED
-- belong to this worker; every other concurrent worker gets the rows that
-- remain. SECURITY DEFINER + service_role-only: never callable by clients.
create or replace function public.claim_due_notification_jobs(p_limit int)
returns setof public.notification_jobs
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_limit < 1 or p_limit > 200 then
    raise exception 'invalid claim limit';
  end if;

  return query
  update public.notification_jobs nj
    set status = 'in_progress'::public.notification_job_status,
        updated_at = now()
  where nj.id in (
    select id
    from public.notification_jobs
    where status = 'pending'::public.notification_job_status
      and scheduled_for <= now()
    order by scheduled_for asc
    limit p_limit
    for update skip locked
  )
  returning nj.*;
end;
$$;

grant execute on function public.claim_due_notification_jobs(int) to service_role;

-- ---------- 4. Atomic webhook claim ----------

alter table public.processed_webhooks
  add column status text not null default 'processed';

create index processed_webhooks_status_idx on public.processed_webhooks (status);

-- Atomically claims an external update id. Returns true only for the
-- winner; concurrent/later deliveries of the same id return false.
create or replace function public.claim_webhook_update(p_source text, p_external_id text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.processed_webhooks (source, external_id, status)
  values (p_source, p_external_id, 'processing')
  on conflict (source, external_id) do nothing;
  return found;
end;
$$;

-- Marks a claimed update as successfully processed.
create or replace function public.finish_webhook_update(p_source text, p_external_id text)
returns void
language sql
security definer
set search_path = public
as $$
  update public.processed_webhooks
    set status = 'processed', processed_at = now()
  where source = p_source and external_id = p_external_id;
$$;

-- Releases a claim after a handler failure so the next delivery retries.
create or replace function public.release_webhook_update(p_source text, p_external_id text)
returns void
language sql
security definer
set search_path = public
as $$
  delete from public.processed_webhooks
  where source = p_source and external_id = p_external_id and status = 'processing';
$$;

grant execute on function public.claim_webhook_update(text, text) to service_role;
grant execute on function public.finish_webhook_update(text, text) to service_role;
grant execute on function public.release_webhook_update(text, text) to service_role;
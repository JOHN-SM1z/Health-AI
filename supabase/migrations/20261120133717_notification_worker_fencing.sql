-- Complete the NT-03 protocol: a claimed row is not authority forever.
-- Workers renew immediately before provider I/O and finalize with the same
-- clinic/token against the database clock. Expired, cancelled or replaced
-- claims cannot send through the new worker or overwrite another outcome.
-- SECURITY INVOKER and service-role-only grants keep these off browser APIs.

create function public.renew_notification_job_claim(
  p_clinic_id uuid,
  p_job_id uuid,
  p_claim_token uuid
)
returns boolean
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  if current_user not in ('service_role', 'postgres') then
    raise exception using errcode = '42501', message = 'server worker required';
  end if;
  if p_clinic_id is null or p_job_id is null or p_claim_token is null then
    return false;
  end if;
  update public.notification_jobs
     set lease_until = now() + interval '10 minutes', updated_at = now()
   where id = p_job_id and clinic_id = p_clinic_id
     and status = 'in_progress' and claim_token = p_claim_token
     and lease_until > now()
     and (conversation_id is null or exists (
       select 1 from public.conversations c
        where c.id = notification_jobs.conversation_id
          and c.clinic_id = p_clinic_id and c.status <> 'assigned'
     ));
  return found;
end;
$$;

create function public.finish_notification_job_claim(
  p_clinic_id uuid,
  p_job_id uuid,
  p_claim_token uuid,
  p_status public.notification_job_status,
  p_error text default null,
  p_telegram_message_id bigint default null
)
returns boolean
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  if current_user not in ('service_role', 'postgres') then
    raise exception using errcode = '42501', message = 'server worker required';
  end if;
  if p_status is null or p_status not in ('pending', 'sent', 'failed', 'skipped', 'quarantined') then
    raise exception using errcode = '22023', message = 'invalid worker outcome';
  end if;
  if p_clinic_id is null or p_job_id is null or p_claim_token is null then
    return false;
  end if;
  update public.notification_jobs
     set status = p_status,
         attempts = attempts + 1,
         error = p_error,
         sent_at = case when p_status = 'sent' then now() else sent_at end,
         telegram_message_id = case when p_status = 'sent' then p_telegram_message_id else telegram_message_id end,
         scheduled_for = case when p_status = 'pending' then now() + interval '1 minute' else scheduled_for end,
         updated_at = now()
   where id = p_job_id and clinic_id = p_clinic_id
     and status = 'in_progress' and claim_token = p_claim_token
     and lease_until > now();
  -- notification_jobs_claim_guard clears the completed claim. Its token
  -- cannot be replayed against a later claim, even when the status is pending.
  return found;
end;
$$;

revoke all on function public.renew_notification_job_claim(uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function public.finish_notification_job_claim(uuid, uuid, uuid, public.notification_job_status, text, bigint) from public, anon, authenticated;
grant execute on function public.renew_notification_job_claim(uuid, uuid, uuid) to service_role;
grant execute on function public.finish_notification_job_claim(uuid, uuid, uuid, public.notification_job_status, text, bigint) to service_role;

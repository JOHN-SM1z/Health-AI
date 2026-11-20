-- Laboratory (Phase 12): verified results reach the patient through the
-- existing Telegram notification jobs and Mini App identity.
--
--   * notification_jobs.lab_result_id: the result a lab_result_ready job is
--     about (same clinic — composite key). Appointment jobs are unchanged.
--   * When a result version is verified — a first result or a correction —
--     and the clinic releases results to patients (app_settings lab.
--     releaseToPatient, default true) and the patient has a Telegram
--     identity, exactly one lab_result_ready job is queued for that version
--     (idempotency key lab_result_ready:<result id>). It is claimed and sent
--     by the existing worker (claim_due_notification_jobs, SKIP LOCKED), so a
--     message is never sent twice. The message carries the test name and the
--     date only — never values.
--   * lab_release_to_patient(clinic): the one reading of that setting, used
--     here and by the server before showing anything to a patient.

create or replace function public.lab_release_to_patient(p_clinic_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  -- Only an explicit false withholds results; anything else is the default (true).
  select coalesce((
    select not (s.value -> 'releaseToPatient' = 'false'::jsonb)
    from public.app_settings s
    where s.clinic_id = p_clinic_id and s.key = 'lab'
  ), true);
$$;

revoke all on function public.lab_release_to_patient(uuid) from public, anon, authenticated;
grant execute on function public.lab_release_to_patient(uuid) to service_role;

alter table public.notification_jobs add column lab_result_id uuid;
alter table public.notification_jobs
  add constraint notification_jobs_lab_result_fkey
    foreign key (lab_result_id, clinic_id) references public.lab_results (id, clinic_id) on delete cascade,
  add constraint notification_jobs_lab_result_check
    check ((type = 'lab_result_ready') = (lab_result_id is not null));

create index notification_jobs_lab_result_idx on public.notification_jobs (lab_result_id) where lab_result_id is not null;

create or replace function public.lab_results_notify_patient()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_telegram bigint;
begin
  if not public.lab_release_to_patient(new.clinic_id) then
    return null;
  end if;
  select p.telegram_user_id into v_telegram
  from public.patients p
  where p.id = new.patient_id and p.clinic_id = new.clinic_id;
  if v_telegram is null then
    return null; -- no Telegram identity: the result is still in the Mini App once linked
  end if;

  insert into public.notification_jobs (clinic_id, type, lab_result_id, patient_telegram_user_id, scheduled_for, idempotency_key)
  values (new.clinic_id, 'lab_result_ready', new.id, v_telegram, now(), 'lab_result_ready:' || new.id::text)
  on conflict (idempotency_key) do nothing;
  return null;
end;
$$;

revoke all on function public.lab_results_notify_patient() from public, anon, authenticated;

create trigger lab_results_notify_patient
  after update of status on public.lab_results
  for each row
  when (new.status = 'verified' and old.status is distinct from 'verified')
  execute function public.lab_results_notify_patient();

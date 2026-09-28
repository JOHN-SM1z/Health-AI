-- Tenant integrity and hardening, from an audit of every earlier phase.
--
-- 1. Same-clinic references everywhere. Fourteen foreign keys between
--    clinic-owned tables checked only the id, so a row of clinic A could point
--    at clinic B's doctor, patient, conversation or appointment. Combined with
--    the direct-write policies below, a manager of one clinic could add working
--    hours or time blocks to another clinic's doctor, and operational staff
--    could attach messages to another clinic's conversation (the insert
--    policies compared c.clinic_id with itself). Every such key is now
--    composite — (x_id, clinic_id) → parent(id, clinic_id) — under its old
--    name, so PostgREST embeds keep working. The migration refuses to run if
--    existing rows already cross clinics (listed in the error).
-- 2. Patient communication is written by the server only. Conversations,
--    messages, voice messages and notification jobs are written by the
--    server after authorization (conversation takeover is compare-and-set,
--    replies are recorded after Telegram accepted them); no application code
--    writes them with a signed-in user's token. The direct-write policies let
--    staff forge undelivered "operator replies" or point a reminder at any
--    Telegram user, so they are removed with the table privileges. Staff
--    uploads into the private voice bucket are removed likewise.
-- 3. Every SECURITY DEFINER function gets search_path = public, pg_temp, and
--    only the roles that need them may execute them: RLS helper functions for
--    signed-in users, nothing for anonymous callers, and trigger functions for
--    nobody (triggers do not need the privilege).
-- 4. Reactivating a cancelled or no-show appointment is validated like a new
--    booking (clinic, doctor, service, working hours, time blocks, overlap),
--    and the slot trigger reports each refusal with a machine-readable hint.
-- 5. Deleting a clinic works: the cascade no longer fails on audit rows for the
--    clinic being erased (its own audit rows go with it).
-- 6. conversations.urgent_at: urgent wording escalates to the clinic's staff.
-- 7. voice_messages.purged_at: the retention the privacy page promises is
--    enforced — past expires_at the audio, the transcripts and the Telegram
--    file reference are removed (the row stays as a record that a voice
--    message was received).

-- ---------- 1. Same-clinic foreign keys ----------

do $$
declare
  v_report text;
begin
  select string_agg(format('%s: %s row(s)', label, n), '; ')
    into v_report
  from (
    select 'services.specialty_id' as label, count(*) as n from public.services c join public.specialties p on p.id = c.specialty_id where p.clinic_id <> c.clinic_id
    union all select 'doctors.specialty_id', count(*) from public.doctors c join public.specialties p on p.id = c.specialty_id where p.clinic_id <> c.clinic_id
    union all select 'doctor_working_hours.doctor_id', count(*) from public.doctor_working_hours c join public.doctors p on p.id = c.doctor_id where p.clinic_id <> c.clinic_id
    union all select 'doctor_time_blocks.doctor_id', count(*) from public.doctor_time_blocks c join public.doctors p on p.id = c.doctor_id where p.clinic_id <> c.clinic_id
    union all select 'payments.appointment_id', count(*) from public.payments c join public.appointments p on p.id = c.appointment_id where p.clinic_id <> c.clinic_id
    union all select 'payments.patient_id', count(*) from public.payments c join public.patients p on p.id = c.patient_id where p.clinic_id <> c.clinic_id
    union all select 'conversations.patient_id', count(*) from public.conversations c join public.patients p on p.id = c.patient_id where p.clinic_id <> c.clinic_id
    union all select 'voice_messages.conversation_id', count(*) from public.voice_messages c join public.conversations p on p.id = c.conversation_id where p.clinic_id <> c.clinic_id
    union all select 'messages.conversation_id', count(*) from public.messages c join public.conversations p on p.id = c.conversation_id where p.clinic_id <> c.clinic_id
    union all select 'messages.voice_message_id', count(*) from public.messages c join public.voice_messages p on p.id = c.voice_message_id where p.clinic_id <> c.clinic_id
    union all select 'notification_jobs.appointment_id', count(*) from public.notification_jobs c join public.appointments p on p.id = c.appointment_id where p.clinic_id <> c.clinic_id
    union all select 'notification_jobs.conversation_id', count(*) from public.notification_jobs c join public.conversations p on p.id = c.conversation_id where p.clinic_id <> c.clinic_id
    union all select 'analytics_events.patient_id', count(*) from public.analytics_events c join public.patients p on p.id = c.patient_id where p.clinic_id <> c.clinic_id
    union all select 'clinical_records.corrects_record_id', count(*) from public.clinical_records c join public.clinical_records p on p.id = c.corrects_record_id where p.clinic_id <> c.clinic_id
  ) crossing
  where n > 0;
  if v_report is not null then
    raise exception 'tenant integrity: rows reference another clinic (%). Investigate and correct them before applying this migration.', v_report;
  end if;
end;
$$;

alter table public.specialties add constraint specialties_id_clinic_id_key unique (id, clinic_id);
alter table public.appointments add constraint appointments_id_clinic_id_key unique (id, clinic_id);
alter table public.conversations add constraint conversations_id_clinic_id_key unique (id, clinic_id);
alter table public.voice_messages add constraint voice_messages_id_clinic_id_key unique (id, clinic_id);
alter table public.clinical_records add constraint clinical_records_id_clinic_id_key unique (id, clinic_id);
-- One payment per appointment, stated over the composite key's columns too, so
-- PostgREST still embeds an appointment's payment as one object.
alter table public.payments add constraint payments_appointment_id_clinic_id_key unique (appointment_id, clinic_id);

alter table public.services
  drop constraint services_specialty_id_fkey,
  add constraint services_specialty_id_fkey
    foreign key (specialty_id, clinic_id) references public.specialties (id, clinic_id) on delete set null (specialty_id);

alter table public.doctors
  drop constraint doctors_specialty_id_fkey,
  add constraint doctors_specialty_id_fkey
    foreign key (specialty_id, clinic_id) references public.specialties (id, clinic_id) on delete set null (specialty_id);

alter table public.doctor_working_hours
  drop constraint doctor_working_hours_doctor_id_fkey,
  add constraint doctor_working_hours_doctor_id_fkey
    foreign key (doctor_id, clinic_id) references public.doctors (id, clinic_id) on delete cascade;

alter table public.doctor_time_blocks
  drop constraint doctor_time_blocks_doctor_id_fkey,
  add constraint doctor_time_blocks_doctor_id_fkey
    foreign key (doctor_id, clinic_id) references public.doctors (id, clinic_id) on delete cascade;

alter table public.payments
  drop constraint payments_appointment_id_fkey,
  add constraint payments_appointment_id_fkey
    foreign key (appointment_id, clinic_id) references public.appointments (id, clinic_id) on delete cascade,
  drop constraint payments_patient_id_fkey,
  add constraint payments_patient_id_fkey
    foreign key (patient_id, clinic_id) references public.patients (id, clinic_id) on delete cascade;

alter table public.conversations
  drop constraint conversations_patient_id_fkey,
  add constraint conversations_patient_id_fkey
    foreign key (patient_id, clinic_id) references public.patients (id, clinic_id) on delete cascade;

alter table public.voice_messages
  drop constraint voice_messages_conversation_id_fkey,
  add constraint voice_messages_conversation_id_fkey
    foreign key (conversation_id, clinic_id) references public.conversations (id, clinic_id) on delete cascade;

alter table public.messages
  drop constraint messages_conversation_id_fkey,
  add constraint messages_conversation_id_fkey
    foreign key (conversation_id, clinic_id) references public.conversations (id, clinic_id) on delete cascade,
  drop constraint messages_voice_message_id_fkey,
  add constraint messages_voice_message_id_fkey
    foreign key (voice_message_id, clinic_id) references public.voice_messages (id, clinic_id) on delete set null (voice_message_id);

alter table public.notification_jobs
  drop constraint notification_jobs_appointment_id_fkey,
  add constraint notification_jobs_appointment_id_fkey
    foreign key (appointment_id, clinic_id) references public.appointments (id, clinic_id) on delete cascade,
  drop constraint notification_jobs_conversation_id_fkey,
  add constraint notification_jobs_conversation_id_fkey
    foreign key (conversation_id, clinic_id) references public.conversations (id, clinic_id) on delete set null (conversation_id);

alter table public.analytics_events
  drop constraint analytics_events_patient_id_fkey,
  add constraint analytics_events_patient_id_fkey
    foreign key (patient_id, clinic_id) references public.patients (id, clinic_id) on delete set null (patient_id);

alter table public.clinical_records
  drop constraint clinical_records_corrects_record_id_fkey,
  add constraint clinical_records_corrects_record_id_fkey
    foreign key (corrects_record_id, clinic_id) references public.clinical_records (id, clinic_id);

-- ---------- 2. Patient communication is written by the server only ----------

drop policy if exists "conversations insert for operational staff" on public.conversations;
drop policy if exists "conversations update for operational staff" on public.conversations;
drop policy if exists "messages insert for operational staff" on public.messages;
drop policy if exists "voice_messages insert for operational staff" on public.voice_messages;
drop policy if exists "voice_messages update for management" on public.voice_messages;
drop policy if exists "notification_jobs update for management" on public.notification_jobs;

revoke insert, update, delete, truncate on table
  public.conversations,
  public.messages,
  public.voice_messages,
  public.notification_jobs,
  -- No write policy exists for these; the privilege alone was dead weight.
  public.processed_webhooks,
  public.clinic_telegram_integrations,
  public.analytics_events,
  public.platform_admins
from authenticated;

drop policy if exists "voice-messages staff upload" on storage.objects;

-- ---------- 3. SECURITY DEFINER functions: safe search_path, minimum grants ----------

do $$
declare
  f record;
begin
  for f in
    select p.oid::regprocedure as sig,
           p.prorettype = 'trigger'::regtype as is_trigger,
           has_function_privilege('authenticated', p.oid, 'execute') as for_signed_in
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prosecdef
  loop
    execute format('alter function %s set search_path = public, pg_temp', f.sig);
    execute format('revoke all on function %s from public, anon', f.sig);
    if f.is_trigger then
      -- A trigger runs its function without checking EXECUTE; nobody calls it.
      execute format('revoke all on function %s from authenticated', f.sig);
    elsif f.for_signed_in then
      -- RLS helpers (is_clinic_staff, current_doctor_id, ...) are evaluated as
      -- the signed-in user; keep exactly the access they had.
      execute format('grant execute on function %s to authenticated, service_role', f.sig);
    end if;
  end loop;
end;
$$;

-- ---------- 4. Reactivation is validated like a booking; refusals carry a hint ----------

create or replace function public.appointments_validate_slot()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_clinic_tz text;
  v_offers_service boolean;
begin
  -- cancelled/no_show rows never block availability; skip validation.
  if new.status in ('cancelled', 'no_show') then
    return new;
  end if;

  -- An active appointment whose slot does not move (status, notes and the
  -- like) needs no validation. A cancelled or no-show appointment coming back
  -- to life is a new claim on its time and is validated in full.
  if tg_op = 'UPDATE'
     and old.status not in ('cancelled', 'no_show')
     and new.start_at is not distinct from old.start_at
     and new.end_at is not distinct from old.end_at
     and new.doctor_id is not distinct from old.doctor_id then
    return new;
  end if;

  select timezone into v_clinic_tz
  from public.clinics
  where id = new.clinic_id and is_active;
  if not found then
    raise exception using message = 'appointment validation: clinic not found or inactive', hint = 'clinic_not_found';
  end if;

  if not exists (
    select 1 from public.doctors d
    where d.id = new.doctor_id and d.clinic_id = new.clinic_id and d.active
  ) then
    raise exception using message = 'appointment validation: doctor not found or inactive', hint = 'doctor_not_found';
  end if;

  if not exists (
    select 1 from public.services s
    where s.id = new.service_id and s.clinic_id = new.clinic_id and s.active
  ) then
    raise exception using message = 'appointment validation: service not found or inactive', hint = 'service_not_found';
  end if;

  if not exists (
    select 1 from public.patients p
    where p.id = new.patient_id and p.clinic_id = new.clinic_id
  ) then
    raise exception using message = 'appointment validation: patient not found', hint = 'patient_not_found';
  end if;

  -- Closed service-list rule: a doctor with explicit services must offer it.
  select exists (select 1 from public.doctor_services where doctor_id = new.doctor_id)
    into v_offers_service;
  if v_offers_service and not exists (
    select 1 from public.doctor_services
    where doctor_id = new.doctor_id and service_id = new.service_id
  ) then
    raise exception using message = 'appointment validation: service not offered by doctor', hint = 'service_not_offered';
  end if;

  -- Whole slot within one working-hour window of its own local day.
  if not public.slot_within_working_hours(new.doctor_id, v_clinic_tz, new.start_at, new.end_at) then
    raise exception using message = 'appointment validation: outside working hours', hint = 'outside_working_hours';
  end if;

  -- No time-block overlap.
  if exists (
    select 1 from public.doctor_time_blocks tb
    where tb.doctor_id = new.doctor_id
      and tstzrange(tb.starts_at, tb.ends_at, '[)') && tstzrange(new.start_at, new.end_at, '[)')
  ) then
    raise exception using message = 'appointment validation: slot is inside a time block', hint = 'time_blocked';
  end if;

  -- No overlap with other active appointments (the new row is not yet in the
  -- table on INSERT, so self-exclusion is only needed on UPDATE). Raised as
  -- exclusion_violation, exactly like the constraint.
  if exists (
    select 1 from public.appointments a
    where a.clinic_id = new.clinic_id
      and a.doctor_id = new.doctor_id
      and (tg_op = 'INSERT' or a.id <> new.id)
      and a.status not in ('cancelled', 'no_show')
      and tstzrange(a.start_at, a.end_at, '[)') && tstzrange(new.start_at, new.end_at, '[)')
  ) then
    raise exception using
      errcode = 'exclusion_violation',
      message = 'appointment validation: slot overlaps another appointment',
      hint = 'slot_taken',
      constraint = 'no_overlapping_active_appointments';
  end if;

  return new;
end;
$$;

revoke all on function public.appointments_validate_slot() from public, anon, authenticated;

-- ---------- 5. Deleting a clinic erases its audit trail with it ----------

-- The clinics being deleted in this transaction. Child rows removed by the
-- cascade (which runs at the end of the DELETE statement, after every
-- clinic row is gone) would otherwise write audit rows for a clinic that no
-- longer exists (audit_events_clinic_id_fkey), and the whole deletion failed.
create or replace function public.clinics_mark_erasure()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform set_config(
    'app.erasing_clinics',
    coalesce(current_setting('app.erasing_clinics', true), '') || old.id::text || ',',
    true
  );
  return old;
end;
$$;

revoke all on function public.clinics_mark_erasure() from public, anon, authenticated;

drop trigger if exists clinics_mark_erasure on public.clinics;
create trigger clinics_mark_erasure
  before delete on public.clinics
  for each row execute function public.clinics_mark_erasure();

create or replace function public.audit_events_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  -- Rows removed with a clinic that is being deleted are not audited: the
  -- clinic's audit trail is erased with it (audit_events cascades).
  if strpos(coalesce(current_setting('app.erasing_clinics', true), ''), new.clinic_id::text || ',') > 0 then
    return null;
  end if;
  -- The database clock, never a caller-supplied time.
  new.created_at := now();
  if new.patient_id is not null and not exists (
       select 1 from public.patients p where p.id = new.patient_id and p.clinic_id = new.clinic_id
     ) then
    raise exception 'audit: patient % is not in clinic %', new.patient_id, new.clinic_id;
  end if;
  if new.referral_id is not null and not exists (
       select 1 from public.referrals r
       where r.id = new.referral_id
         and r.clinic_id = new.clinic_id
         and (new.patient_id is null or r.patient_id = new.patient_id)
     ) then
    raise exception 'audit: referral % is not in clinic % for that patient', new.referral_id, new.clinic_id;
  end if;
  return new;
end;
$$;

revoke all on function public.audit_events_guard() from public, anon, authenticated;

-- ---------- 6. Urgent wording escalates to the clinic's staff ----------

alter table public.conversations add column urgent_at timestamptz;

comment on column public.conversations.urgent_at is
  'When the patient last wrote urgent wording. The patient received the approved urgent-care message, automatic replies stopped, and the conversation is shown to the clinic''s staff as urgent until someone takes it over after this time.';

create index conversations_urgent_idx on public.conversations (clinic_id, urgent_at desc) where urgent_at is not null;

-- ---------- 7. Voice retention ----------

alter table public.voice_messages add column purged_at timestamptz;

comment on column public.voice_messages.purged_at is
  'When the scheduled retention run removed this voice message''s audio, transcripts and Telegram file reference (after expires_at).';

alter table public.voice_messages
  drop constraint voice_messages_audio_source_check,
  add constraint voice_messages_audio_source_check
    check (telegram_file_id is not null or storage_path is not null or purged_at is not null);

create index voice_messages_retention_idx on public.voice_messages (expires_at) where purged_at is null and expires_at is not null;


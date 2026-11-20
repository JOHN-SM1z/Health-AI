-- SMS for patients without Telegram (Slice D, owner decision 2026-10-08: Eskiz). Off by default, per clinic.
--
--   * clinics.sms_enabled — the owner turns SMS on once the clinic has an Eskiz contract, sender name and approved
--     templates.
--   * patients.sms_consent_at — recorded at the desk when the patient agrees to SMS (not readable by signed-in staff;
--     the server reports only "agreed / not").
--   * The queue ticket and "you are called" go by SMS only when the patient has NO Telegram, has agreed, has an Uzbek
--     phone, and the clinic has SMS on — trigger visits_sms_notify(), the same moments the Telegram messages use.
--   * notification_jobs: channel 'sms' with recipient_patient_id. claim_due_sms_jobs() claims atomically (FOR UPDATE
--     SKIP LOCKED): two workers never send the same SMS.
--   * sms_messages: what the SMS provider accepted and later reported delivered. No phone number, no text.
--   * card_link_otps: one-time codes sent to the phone on a card, so a patient whose Telegram phone differs from the
--     card's can still prove the card is theirs. Only the code's HMAC is stored; 5 attempts; 5 minutes; single use.

alter table public.clinics add column sms_enabled boolean not null default false;
alter table public.patients add column sms_consent_at timestamptz;
comment on column public.patients.sms_consent_at is 'When the patient agreed to queue SMS at the desk. Not granted to signed-in roles.';

alter table public.notification_jobs add column recipient_patient_id uuid;
alter table public.notification_jobs add constraint notification_jobs_recipient_patient_fkey
  foreign key (recipient_patient_id, clinic_id) references public.patients (id, clinic_id) on delete cascade;
alter table public.notification_jobs add constraint notification_jobs_sms_check
  check ((channel = 'sms') = (recipient_patient_id is not null) and (channel <> 'sms' or patient_telegram_user_id is null));

-- References stay inside their clinic (tenant-integrity suite): composite keys with clinic_id.
alter table public.notification_jobs add constraint notification_jobs_id_clinic_id_key unique (id, clinic_id);
alter table public.online_identity_lookups add constraint online_identity_lookups_id_clinic_id_key unique (id, clinic_id);

create table public.sms_messages (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete cascade,
  job_id uuid,
  purpose text not null constraint sms_messages_purpose_check check (purpose in ('queue_ticket', 'queue_called', 'card_link_otp')),
  provider text not null constraint sms_messages_provider_check check (provider in ('eskiz', 'test')),
  provider_message_id text,
  status text not null default 'sent' constraint sms_messages_status_check check (status in ('sent', 'delivered', 'failed')),
  error_code text,
  created_at timestamptz not null default now(),
  delivered_at timestamptz,
  constraint sms_messages_provider_id_key unique (provider, provider_message_id),
  constraint sms_messages_job_fkey foreign key (job_id, clinic_id) references public.notification_jobs (id, clinic_id) on delete set null (job_id)
);
create index sms_messages_clinic_idx on public.sms_messages (clinic_id, created_at);

create table public.card_link_otps (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete cascade,
  lookup_id uuid not null,
  telegram_user_id bigint not null,
  patient_id uuid not null,
  code_hmac text not null constraint card_link_otps_hmac_check check (code_hmac ~ '^[0-9a-f]{64}$'),
  attempts integer not null default 0 check (attempts between 0 and 5),
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now(),
  constraint card_link_otps_patient_fkey foreign key (patient_id, clinic_id) references public.patients (id, clinic_id) on delete cascade,
  constraint card_link_otps_lookup_fkey foreign key (lookup_id, clinic_id) references public.online_identity_lookups (id, clinic_id) on delete cascade
);
create index card_link_otps_user_idx on public.card_link_otps (clinic_id, telegram_user_id, created_at);
create index card_link_otps_patient_idx on public.card_link_otps (clinic_id, patient_id, created_at);

alter table public.sms_messages enable row level security;
alter table public.card_link_otps enable row level security;
revoke all on table public.sms_messages, public.card_link_otps from public, anon, authenticated;
grant select, insert, update on table public.sms_messages, public.card_link_otps to service_role;

-- ---------------------------------------------------------------------------
-- The SMS fallback for queue messages
-- ---------------------------------------------------------------------------

create or replace function public.visits_sms_notify()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_type public.notification_job_type;
  v_key text;
begin
  if new.queue_number is not null and (tg_op = 'INSERT' or old.queue_number is null) then
    v_type := 'queue_ticket';
    v_key := 'sms:queue_ticket:' || new.id::text;
  elsif tg_op = 'UPDATE' and new.status = 'called' and old.status is distinct from 'called' then
    v_type := 'queue_called';
    v_key := 'sms:queue_called:' || new.id::text || ':' || to_char(coalesce(new.called_at, now()) at time zone 'UTC', 'YYYYMMDDHH24MISSUS');
  else
    return new;
  end if;

  insert into public.notification_jobs (clinic_id, visit_id, type, channel, recipient_type, recipient_patient_id, scheduled_for, idempotency_key)
  select new.clinic_id, new.id, v_type, 'sms', 'patient', p.id, now(), v_key
    from public.patients p join public.clinics c on c.id = p.clinic_id
   where p.id = new.patient_id
     and c.sms_enabled
     and p.telegram_user_id is null
     and p.sms_consent_at is not null
     and public.normalize_uz_phone(p.phone) is not null
  on conflict (idempotency_key) do nothing;
  return new;
end;
$$;

create trigger visits_sms_notify
  after insert or update of queue_number, status on public.visits
  for each row execute function public.visits_sms_notify();

-- ---------------------------------------------------------------------------
-- claim_due_sms_jobs — the SMS worker's atomic claim
-- ---------------------------------------------------------------------------

create or replace function public.claim_due_sms_jobs(p_limit integer, p_clinic_ids uuid[] default null)
returns setof public.notification_jobs
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_limit < 1 or p_limit > 200 then
    raise exception 'invalid claim limit';
  end if;
  return query
  update public.notification_jobs nj
     set status = 'in_progress'::public.notification_job_status, updated_at = now()
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

-- ---------------------------------------------------------------------------
-- Card link by SMS code (the second online proof)
-- ---------------------------------------------------------------------------

-- Issue a code for the card the lookup matched. Returns the patient's phone ONLY to the server that sends the SMS,
-- or null (no match, SMS off, limits reached) — the server answers the patient the same either way.
create or replace function public.issue_card_link_otp(p_clinic uuid, p_telegram_user_id bigint, p_lookup uuid, p_code_hmac text)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  l public.online_identity_lookups%rowtype;
  p public.patients%rowtype;
  v_enabled boolean;
begin
  select * into l from public.online_identity_lookups
   where id = p_lookup and clinic_id = p_clinic and telegram_user_id = p_telegram_user_id and completed_at is null and expires_at > now();
  if not found or l.matched_patient_id is null then
    return null;
  end if;
  select sms_enabled into v_enabled from public.clinics where id = p_clinic;
  if not coalesce(v_enabled, false) then
    return null;
  end if;
  select * into p from public.patients where id = l.matched_patient_id and clinic_id = p_clinic and merged_into_patient_id is null;
  if not found or public.normalize_uz_phone(p.phone) is null or p.telegram_user_id is not null then
    return null;
  end if;
  -- Flood limits: 3 codes per Telegram user per hour, 5 per card per day.
  if (select count(*) from public.card_link_otps where clinic_id = p_clinic and telegram_user_id = p_telegram_user_id and created_at > now() - interval '1 hour') >= 3
     or (select count(*) from public.card_link_otps where clinic_id = p_clinic and patient_id = p.id and created_at > now() - interval '1 day') >= 5 then
    return null;
  end if;
  update public.card_link_otps set used_at = now() where lookup_id = l.id and used_at is null; -- one live code per lookup
  insert into public.card_link_otps (clinic_id, lookup_id, telegram_user_id, patient_id, code_hmac, expires_at)
  values (p_clinic, l.id, p_telegram_user_id, p.id, p_code_hmac, now() + interval '5 minutes');
  return '+998' || public.normalize_uz_phone(p.phone);
end;
$$;

-- Check a code. Returns 'linked' | 'already_linked' | 'card_has_telegram' | 'needs_reception' | 'wrong_code' | 'expired'.
create or replace function public.verify_card_link_otp(
  p_clinic uuid, p_telegram_user_id bigint, p_lookup uuid, p_code_hmac text,
  p_username text default null, p_first_name text default null, p_last_name text default null)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  o public.card_link_otps%rowtype;
  v_outcome text;
begin
  select * into o from public.card_link_otps
   where clinic_id = p_clinic and lookup_id = p_lookup and telegram_user_id = p_telegram_user_id and used_at is null
   order by created_at desc limit 1
   for update;
  if not found or o.expires_at < now() or o.attempts >= 5 then
    return 'expired';
  end if;
  if o.code_hmac <> p_code_hmac then
    update public.card_link_otps set attempts = attempts + 1, used_at = case when attempts + 1 >= 5 then now() else null end where id = o.id;
    return 'wrong_code';
  end if;
  update public.card_link_otps set used_at = now() where id = o.id;
  v_outcome := public.link_card_to_telegram(p_clinic, o.patient_id, p_telegram_user_id, 'sms_code', p_username, p_first_name, p_last_name);
  if v_outcome in ('linked', 'already_linked') then
    update public.online_identity_lookups set completed_at = now() where id = p_lookup;
  end if;
  return v_outcome;
end;
$$;

revoke all on function public.visits_sms_notify() from public, anon, authenticated;
revoke all on function public.claim_due_sms_jobs(integer, uuid[]) from public, anon, authenticated;
revoke all on function public.issue_card_link_otp(uuid, bigint, uuid, text) from public, anon, authenticated;
revoke all on function public.verify_card_link_otp(uuid, bigint, uuid, text, text, text, text) from public, anon, authenticated;
grant execute on function public.claim_due_sms_jobs(integer, uuid[]) to service_role;
grant execute on function public.issue_card_link_otp(uuid, bigint, uuid, text) to service_role;
grant execute on function public.verify_card_link_otp(uuid, bigint, uuid, text, text, text, text) to service_role;

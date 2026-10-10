-- OneID (id.egov.uz) identity verification for the Mini App (owner question 2026-10-10: "check whether the
-- passport details are true").
--
-- A typed passport/JSHSHIR + date of birth is only a lookup key: anyone who knows them could type them. OneID is the
-- state identification system: the patient signs in there (login + password, e-signature or phone — no face check
-- needed) and the state returns their verified JSHSHIR, passport, full name, date of birth, sex and address. Those
-- values, not typed ones, then go onto the card.
--
--   * patients.identity_verified_at / identity_verified_by — when and how the card's identity was confirmed by the
--     state. Not granted to signed-in roles (column grants of 20261008000005 list what staff may read).
--   * oneid_requests — one sign-in attempt, bound to the Telegram user who started it; the browser gets only the
--     random state, whose SHA-256 is stored. 15 minutes, single use.
--   * apply_oneid_identity() — the matched card (by JSHSHIR, else passport with the same date of birth) is linked to
--     the patient's Telegram (link_card_to_telegram, method 'oneid'); with no card, the patient's own record gets the
--     verified details. Returns 'verified' | 'linked' | 'reception'.
-- Off until the clinic's operator signs the OneID agreement and sets ONEID_CLIENT_ID / ONEID_CLIENT_SECRET.

alter table public.patients
  add column identity_verified_at timestamptz,
  add column identity_verified_by text
    constraint patients_identity_verified_by_check check (identity_verified_by in ('oneid'));
comment on column public.patients.identity_verified_at is
  'When the state identification system (OneID) confirmed this card''s identity. Not granted to signed-in roles.';

alter table public.patients drop constraint patients_telegram_link_method_check;
alter table public.patients add constraint patients_telegram_link_method_check
  check (telegram_link_method in ('contact_phone', 'sms_code', 'reception', 'oneid'));

create table public.oneid_requests (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete cascade,
  telegram_user_id bigint not null,
  state_hash text not null unique constraint oneid_requests_state_hash_check check (state_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '15 minutes',
  completed_at timestamptz,
  outcome text constraint oneid_requests_outcome_check check (outcome in ('verified', 'linked', 'reception', 'invalid', 'failed'))
);
create index oneid_requests_user_idx on public.oneid_requests (clinic_id, telegram_user_id, created_at desc);
alter table public.oneid_requests enable row level security;
revoke all on table public.oneid_requests from public, anon, authenticated;
grant select, insert, update, delete on table public.oneid_requests to service_role;

-- link_card_to_telegram now also accepts OneID as the proof (body otherwise unchanged from 20261008000010).
create or replace function public.link_card_to_telegram(
  p_clinic uuid, p_patient uuid, p_telegram_user_id bigint, p_method text,
  p_username text default null, p_first_name text default null, p_last_name text default null)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  d public.patients%rowtype;
  t public.patients%rowtype;
begin
  if p_method not in ('contact_phone', 'sms_code', 'oneid') then
    raise exception using message = 'online identity: unknown proof', errcode = '22023', hint = 'invalid_identity';
  end if;

  select * into d from public.patients where id = p_patient and clinic_id = p_clinic for update;
  if not found or d.merged_into_patient_id is not null then
    return 'needs_reception';
  end if;
  if d.telegram_user_id = p_telegram_user_id then
    return 'already_linked';
  end if;
  if d.telegram_user_id is not null then
    return 'card_has_telegram';
  end if;

  select * into t from public.patients where clinic_id = p_clinic and telegram_user_id = p_telegram_user_id for update;
  if found then
    -- The Telegram-only record gives up its identity only while nothing is recorded on it. Its conversations and
    -- analytics stay with it; anything else (a booking, a visit, a payment, a lab order, an online identity of its
    -- own) means the two records are joined by reception with merge_patients(), never silently here.
    if t.merged_into_patient_id is not null
       or t.document_number is not null or t.pinfl is not null
       or exists (select 1 from public.appointments where patient_id = t.id)
       or exists (select 1 from public.visits where patient_id = t.id)
       or exists (select 1 from public.payments where patient_id = t.id)
       or exists (select 1 from public.lab_orders where patient_id = t.id)
       or exists (select 1 from public.referrals where patient_id = t.id)
       or exists (select 1 from public.clinical_records where patient_id = t.id)
       or exists (select 1 from public.lab_import_rows where patient_id = t.id)
       or exists (select 1 from public.patient_merges where canonical_patient_id = t.id or duplicate_patient_id = t.id) then
      return 'needs_reception';
    end if;
    update public.patients
       set telegram_user_id = null, telegram_username = null, telegram_first_name = null, telegram_last_name = null
     where id = t.id;
  end if;

  update public.patients
     set telegram_user_id = p_telegram_user_id,
         telegram_username = p_username,
         telegram_first_name = p_first_name,
         telegram_last_name = p_last_name,
         telegram_linked_at = now(),
         telegram_link_method = p_method,
         last_seen_at = now()
   where id = d.id;

  insert into public.audit_events (clinic_id, actor_id, actor_type, action, entity_type, entity_id, patient_id, metadata)
  values (p_clinic, null, 'patient', 'patient_telegram_linked', 'patients', d.id::text, d.id,
          jsonb_build_object('method', p_method, 'detached_patient_id', t.id));
  return 'linked';
end;
$$;

-- ---------------------------------------------------------------------------
-- apply_oneid_identity: the state-verified details land on the right card.
-- ---------------------------------------------------------------------------
create or replace function public.apply_oneid_identity(
  p_clinic uuid, p_request uuid, p_pinfl text, p_document text, p_dob date, p_sex public.patient_sex,
  p_full_name text, p_address text,
  p_username text default null, p_first_name text default null, p_last_name text default null)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  r public.oneid_requests%rowtype;
  t public.patients%rowtype;
  card public.patients%rowtype;
  v_outcome text;
  v_target uuid;
  v_name text := nullif(btrim(p_full_name), '');
  v_address text := nullif(left(btrim(coalesce(p_address, '')), 300), '');
begin
  if p_pinfl !~ '^\d{14}$' or p_dob is null or v_name is null then
    raise exception using message = 'oneid: incomplete identity', errcode = '22023', hint = 'invalid_identity';
  end if;

  select * into r from public.oneid_requests where id = p_request and clinic_id = p_clinic for update;
  if not found or r.completed_at is not null or r.expires_at < now() then
    raise exception using message = 'oneid: request expired', errcode = '22023', hint = 'lookup_expired';
  end if;

  select * into t from public.patients where clinic_id = p_clinic and telegram_user_id = r.telegram_user_id;

  -- The card this person already has: by JSHSHIR; else by passport/ID with the same date of birth.
  select * into card from public.patients
   where clinic_id = p_clinic and merged_into_patient_id is null and pinfl = p_pinfl;
  if not found and p_document is not null then
    select * into card from public.patients
     where clinic_id = p_clinic and merged_into_patient_id is null and document_number = p_document and date_of_birth = p_dob;
  end if;

  if card.id is not null and (t.id is null or card.id <> t.id) then
    v_outcome := public.link_card_to_telegram(p_clinic, card.id, r.telegram_user_id, 'oneid', p_username, p_first_name, p_last_name);
    if v_outcome in ('linked', 'already_linked') then
      v_target := card.id;
      v_outcome := 'linked';
    else
      v_outcome := 'reception';
    end if;
  elsif t.id is not null and t.merged_into_patient_id is null then
    v_target := t.id;
    v_outcome := 'verified';
  else
    v_outcome := 'reception';
  end if;

  if v_target is not null then
    -- The state's values replace typed ones. A passport number already on another card is left off this one.
    update public.patients
       set pinfl = p_pinfl,
           document_number = case
             when p_document is null then document_number
             when exists (select 1 from public.patients o where o.clinic_id = p_clinic and o.id <> v_target and o.document_number = p_document) then document_number
             else p_document end,
           date_of_birth = p_dob,
           sex = coalesce(p_sex, sex),
           full_name = v_name,
           home_address = coalesce(v_address, home_address),
           identity_verified_at = now(),
           identity_verified_by = 'oneid'
     where id = v_target;
    insert into public.audit_events (clinic_id, actor_id, actor_type, action, entity_type, entity_id, patient_id, metadata)
    values (p_clinic, null, 'patient', 'patient_identity_verified', 'patients', v_target::text, v_target,
            jsonb_build_object('method', 'oneid', 'outcome', v_outcome));
  end if;

  update public.oneid_requests set completed_at = now(), outcome = v_outcome where id = r.id;
  return v_outcome;
end;
$$;

revoke all on function public.link_card_to_telegram(uuid, uuid, bigint, text, text, text, text) from public, anon, authenticated;
grant execute on function public.link_card_to_telegram(uuid, uuid, bigint, text, text, text, text) to service_role;
revoke all on function public.apply_oneid_identity(uuid, uuid, text, text, date, public.patient_sex, text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.apply_oneid_identity(uuid, uuid, text, text, date, public.patient_sex, text, text, text, text, text) to service_role;

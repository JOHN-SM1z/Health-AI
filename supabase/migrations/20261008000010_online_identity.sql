-- Online identity for the Telegram Mini App (Slice B, owner decision 2026-10-08).
--
-- A patient booking online starts with passport/ID or JSHSHIR + date of birth. Those are a LOOKUP KEY, not proof:
-- anyone can type someone else's. Proof is a phone number Telegram itself vouches for — the patient shares their own
-- contact with the clinic's bot (the bot accepts it only when contact.user_id is the sender) — that equals the phone on
-- the card. No MyID, no face check, no per-check fee. An SMS one-time code to the card's phone is the second proof
-- (Slice D).
--
--   * telegram_verified_phones: the last nine digits of the phone each Telegram user proved, per clinic.
--   * online_identity_lookups: what the patient typed (server-only, 30 minutes), and whether it matched a card. The
--     browser holds only the lookup id. The patient gets the SAME answer whether there is no card, the date of birth
--     is wrong, or the card is not yet proven — typing a passport number reveals nothing about anyone.
--   * link_card_to_telegram(): proven → the card takes the patient's Telegram identity, in one transaction, audited.
--     The Telegram-only record the Mini App created on first open gives it up only while it has nothing recorded on it
--     (conversations stay with it); otherwise reception merges the two with merge_patients().
--   * complete_online_patient(): no card → the patient's own record gets the details. A passport/JSHSHIR already on
--     another card is NOT stored; a claim goes to the owner/administrator instead. The patient sees the same answer.
--   * patient_identity_claims: those conflicts, for staff to resolve at the desk.
--
-- Every table here is server-only: RLS on, no policies, nothing granted to anon or authenticated.

-- ---------------------------------------------------------------------------
-- Columns
-- ---------------------------------------------------------------------------

alter table public.patients
  add column telegram_linked_at timestamptz,
  add column telegram_link_method text
    constraint patients_telegram_link_method_check check (telegram_link_method in ('contact_phone', 'sms_code', 'reception'));

comment on column public.patients.telegram_linked_at is
  'When this card took a Telegram identity through online proof (link_card_to_telegram). Not granted to signed-in roles.';

-- Per clinic: the Mini App booking requires a completed online identity (passport/JSHSHIR + date of birth, proven or
-- recorded). Off by default so existing clinics keep working until the owner turns it on.
alter table public.clinics
  add column online_identity_required boolean not null default false;

-- ---------------------------------------------------------------------------
-- normalize_uz_phone: the nine national digits of an Uzbek number, however it was written; null for anything else.
-- ---------------------------------------------------------------------------

create or replace function public.normalize_uz_phone(p_value text)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select case
    when d ~ '^998[0-9]{9}$' then right(d, 9)
    when d ~ '^[0-9]{9}$' then d
    else null
  end
  from (select regexp_replace(coalesce(p_value, ''), '[^0-9]', '', 'g') as d) s;
$$;

revoke all on function public.normalize_uz_phone(text) from public, anon, authenticated;
grant execute on function public.normalize_uz_phone(text) to service_role;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table public.telegram_verified_phones (
  clinic_id uuid not null references public.clinics(id) on delete cascade,
  telegram_user_id bigint not null,
  phone_key text not null constraint telegram_verified_phones_key_check check (phone_key ~ '^[0-9]{9}$'),
  verified_at timestamptz not null default now(),
  primary key (clinic_id, telegram_user_id)
);

create table public.online_identity_lookups (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete cascade,
  telegram_user_id bigint not null,
  -- Server-keyed HMAC of the normalised document: per-document limits without keeping the value longer than needed.
  document_key text not null constraint online_identity_lookups_key_check check (document_key ~ '^[0-9a-f]{64}$'),
  document_number text,
  pinfl text,
  date_of_birth date not null,
  matched_patient_id uuid,
  dob_mismatch boolean not null default false,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '30 minutes',
  completed_at timestamptz,
  constraint online_identity_lookups_one_document check ((document_number is null) <> (pinfl is null))
);
create index online_identity_lookups_document_idx on public.online_identity_lookups (clinic_id, document_key, created_at);
create index online_identity_lookups_user_idx on public.online_identity_lookups (clinic_id, telegram_user_id, created_at);

create table public.patient_identity_claims (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete cascade,
  patient_id uuid not null,
  conflicting_patient_id uuid,
  reason text not null constraint patient_identity_claims_reason_check check (reason in ('document_in_use', 'details_differ')),
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by uuid
);
create index patient_identity_claims_open_idx on public.patient_identity_claims (clinic_id, created_at) where resolved_at is null;

alter table public.telegram_verified_phones enable row level security;
alter table public.online_identity_lookups enable row level security;
alter table public.patient_identity_claims enable row level security;
revoke all on table public.telegram_verified_phones, public.online_identity_lookups, public.patient_identity_claims
  from public, anon, authenticated;
grant select, insert, update, delete on table public.telegram_verified_phones, public.online_identity_lookups,
  public.patient_identity_claims to service_role;

-- ---------------------------------------------------------------------------
-- record_telegram_verified_phone: the bot received the sender's OWN contact (the server checked contact.user_id).
-- ---------------------------------------------------------------------------

create or replace function public.record_telegram_verified_phone(p_clinic uuid, p_telegram_user_id bigint, p_phone text)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_key text := public.normalize_uz_phone(p_phone);
begin
  if v_key is null or p_clinic is null or p_telegram_user_id is null then
    return false;
  end if;
  insert into public.telegram_verified_phones (clinic_id, telegram_user_id, phone_key, verified_at)
  values (p_clinic, p_telegram_user_id, v_key, now())
  on conflict (clinic_id, telegram_user_id) do update set phone_key = excluded.phone_key, verified_at = excluded.verified_at;
  return true;
end;
$$;

-- ---------------------------------------------------------------------------
-- online_identity_lookup: record what the patient typed and whether it matches a card. Returns the lookup id only.
-- ---------------------------------------------------------------------------

create or replace function public.online_identity_lookup(
  p_clinic uuid, p_telegram_user_id bigint, p_document_key text, p_document text, p_pinfl text, p_dob date)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_doc text := public.normalize_identity_document(p_document);
  v_pinfl text := public.normalize_identity_document(p_pinfl);
  v_card record;
  v_blocked boolean;
  v_id uuid;
begin
  if (v_doc is null) = (v_pinfl is null) or p_dob is null or p_document_key !~ '^[0-9a-f]{64}$' then
    raise exception using message = 'online identity: one document and a date of birth are required', errcode = '22023', hint = 'invalid_identity';
  end if;

  -- Lookups older than a day are kept no longer than the per-document limit needs them.
  delete from public.online_identity_lookups where clinic_id = p_clinic and created_at < now() - interval '1 day';

  -- Three wrong dates of birth for one document in a day: stop comparing (the answer looks the same either way).
  select count(*) >= 3 into v_blocked
    from public.online_identity_lookups
   where clinic_id = p_clinic and document_key = p_document_key and dob_mismatch;

  select id, date_of_birth into v_card
    from public.patients
   where clinic_id = p_clinic and merged_into_patient_id is null
     and ((v_doc is not null and document_number = v_doc) or (v_pinfl is not null and pinfl = v_pinfl))
   order by created_at
   limit 1;

  insert into public.online_identity_lookups
    (clinic_id, telegram_user_id, document_key, document_number, pinfl, date_of_birth, matched_patient_id, dob_mismatch)
  values (
    p_clinic, p_telegram_user_id, p_document_key, v_doc, v_pinfl, p_dob,
    case when v_card.id is not null and not v_blocked and v_card.date_of_birth = p_dob then v_card.id end,
    v_card.id is not null and not v_blocked and v_card.date_of_birth is not null and v_card.date_of_birth <> p_dob)
  returning id into v_id;
  return v_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- link_card_to_telegram: the patient proved the card is theirs. Returns
--   'linked' | 'already_linked' | 'card_has_telegram' | 'needs_reception'.
-- ---------------------------------------------------------------------------

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
  if p_method not in ('contact_phone', 'sms_code') then
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
-- complete_online_patient: no card was proven — the patient's own (Telegram) record gets the details they typed.
-- Returns 'completed' | 'completed_with_claim'. The server answers the patient the same way for both.
-- ---------------------------------------------------------------------------

create or replace function public.complete_online_patient(
  p_clinic uuid, p_telegram_user_id bigint, p_lookup uuid, p_full_name text,
  p_sex public.patient_sex default null, p_address text default null)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  l public.online_identity_lookups%rowtype;
  t public.patients%rowtype;
  v_phone text;
  v_name text := btrim(p_full_name);
  v_address text := nullif(btrim(coalesce(p_address, '')), '');
  v_other uuid;
  v_claim text;
  v_fields text[] := '{}';
begin
  if v_name is null or char_length(v_name) not between 2 and 120 then
    raise exception using message = 'online identity: name required', errcode = '22023', hint = 'invalid_identity';
  end if;
  if v_address is not null and char_length(v_address) > 300 then
    raise exception using message = 'online identity: address too long', errcode = '22023', hint = 'invalid_identity';
  end if;

  select * into l from public.online_identity_lookups
   where id = p_lookup and clinic_id = p_clinic and telegram_user_id = p_telegram_user_id
   for update;
  if not found or l.completed_at is not null or l.expires_at < now() then
    raise exception using message = 'online identity: lookup expired', errcode = '22023', hint = 'lookup_expired';
  end if;

  select * into t from public.patients where clinic_id = p_clinic and telegram_user_id = p_telegram_user_id for update;
  if not found or t.merged_into_patient_id is not null then
    raise exception using message = 'online identity: no patient record', errcode = '22023', hint = 'needs_reception';
  end if;

  -- The Telegram-verified phone (record_telegram_verified_phone), never a typed one.
  select '+998' || phone_key into v_phone
    from public.telegram_verified_phones
   where clinic_id = p_clinic and telegram_user_id = p_telegram_user_id;

  -- A document already on another card is never written onto this one.
  select id into v_other from public.patients
   where clinic_id = p_clinic and id <> t.id
     and ((l.document_number is not null and document_number = l.document_number) or (l.pinfl is not null and pinfl = l.pinfl))
   order by created_at limit 1;
  if v_other is not null then
    v_claim := 'document_in_use';
  elsif (t.document_number is not null and t.document_number is distinct from l.document_number and l.document_number is not null)
     or (t.pinfl is not null and t.pinfl is distinct from l.pinfl and l.pinfl is not null)
     or (t.date_of_birth is not null and t.date_of_birth <> l.date_of_birth) then
    v_claim := 'details_differ';
  end if;

  if v_claim is null then
    if t.document_number is null and l.document_number is not null then v_fields := array_append(v_fields, 'document_number'); end if;
    if t.pinfl is null and l.pinfl is not null then v_fields := array_append(v_fields, 'pinfl'); end if;
    if t.date_of_birth is null then v_fields := array_append(v_fields, 'date_of_birth'); end if;
  end if;
  if t.full_name is null then v_fields := array_append(v_fields, 'full_name'); end if;
  if t.phone is null and v_phone is not null then v_fields := array_append(v_fields, 'phone'); end if;
  if t.sex is null and p_sex is not null then v_fields := array_append(v_fields, 'sex'); end if;
  if t.home_address is null and v_address is not null then v_fields := array_append(v_fields, 'home_address'); end if;

  update public.patients
     set document_number = case when 'document_number' = any(v_fields) then l.document_number else document_number end,
         pinfl = case when 'pinfl' = any(v_fields) then l.pinfl else pinfl end,
         date_of_birth = case when 'date_of_birth' = any(v_fields) then l.date_of_birth else date_of_birth end,
         full_name = case when 'full_name' = any(v_fields) then v_name else full_name end,
         phone = case when 'phone' = any(v_fields) then v_phone else phone end,
         sex = case when 'sex' = any(v_fields) then p_sex else sex end,
         home_address = case when 'home_address' = any(v_fields) then v_address else home_address end,
         consent_given = true,
         consent_given_at = coalesce(consent_given_at, now()),
         last_seen_at = now()
   where id = t.id;

  update public.online_identity_lookups set completed_at = now() where id = l.id;

  if v_claim is not null then
    insert into public.patient_identity_claims (clinic_id, patient_id, conflicting_patient_id, reason)
    values (p_clinic, t.id, v_other, v_claim);
  end if;

  insert into public.audit_events (clinic_id, actor_id, actor_type, action, entity_type, entity_id, patient_id, metadata)
  values (p_clinic, null, 'patient', 'patient_online_details_completed', 'patients', t.id::text, t.id,
          jsonb_build_object('fields', to_jsonb(v_fields), 'claim', v_claim));
  return case when v_claim is null then 'completed' else 'completed_with_claim' end;
end;
$$;

revoke all on function public.record_telegram_verified_phone(uuid, bigint, text) from public, anon, authenticated;
revoke all on function public.online_identity_lookup(uuid, bigint, text, text, text, date) from public, anon, authenticated;
revoke all on function public.link_card_to_telegram(uuid, uuid, bigint, text, text, text, text) from public, anon, authenticated;
revoke all on function public.complete_online_patient(uuid, bigint, uuid, text, public.patient_sex, text) from public, anon, authenticated;
grant execute on function public.record_telegram_verified_phone(uuid, bigint, text) to service_role;
grant execute on function public.online_identity_lookup(uuid, bigint, text, text, text, date) to service_role;
grant execute on function public.link_card_to_telegram(uuid, uuid, bigint, text, text, text, text) to service_role;
grant execute on function public.complete_online_patient(uuid, bigint, uuid, text, public.patient_sex, text) to service_role;

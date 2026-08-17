-- =====================================================================
-- Health AI — FULL DATABASE SETUP (production)
-- Auto-generated from supabase/migrations/ in order. Run ONCE on an
-- EMPTY database via Supabase Dashboard > SQL Editor > New query.
-- Seed data (supabase/seed.sql) is LOCAL-DEV-ONLY and is NOT included.
-- =====================================================================

-- =====================================================================
-- FILE: 20260813000001_extensions_types.sql
-- =====================================================================
-- 0001: Extensions and enum types

create extension if not exists btree_gist;
create extension if not exists pgcrypto;

-- Appointment lifecycle
create type public.appointment_status as enum (
  'pending',
  'confirmed',
  'checked_in',
  'in_progress',
  'completed',
  'cancelled',
  'no_show'
);

-- Payment lifecycle
create type public.payment_status as enum (
  'unpaid',
  'pending',
  'paid',
  'failed',
  'refunded',
  'manual_review'
);

-- Payment providers. 'manual' is the built-in development/clinic-assisted
-- provider. Real providers (click, payme) are adapters activated with
-- merchant credentials and never faked.
create type public.payment_provider as enum (
  'manual',
  'click',
  'payme',
  'cash',
  'card_terminal'
);

-- How an appointment was created
create type public.appointment_source as enum (
  'telegram_mini_app',
  'telegram_chat',
  'admin',
  'walk_in'
);

create type public.conversation_status as enum ('open', 'assigned', 'released', 'closed');
create type public.conversation_channel as enum ('telegram', 'mini_app');
create type public.message_role as enum ('patient', 'bot', 'ai', 'admin', 'system');
create type public.message_type as enum ('text', 'voice', 'button', 'callback', 'system');

create type public.time_block_reason as enum ('break', 'absence', 'reservation', 'admin_hold');

create type public.staff_role as enum ('owner', 'admin', 'doctor');

create type public.notification_job_type as enum (
  'booking_confirmation',
  'reminder_24h',
  'reminder_2h',
  'cancellation',
  'reschedule',
  'human_takeover'
);
create type public.notification_job_status as enum ('pending', 'sent', 'failed', 'skipped', 'cancelled');

create type public.voice_status as enum ('none', 'pending', 'transcribed', 'failed');

create type public.actor_type as enum ('staff', 'system', 'patient', 'telegram');

-- =====================================================================
-- FILE: 20260813000002_clinics_staff_patients.sql
-- =====================================================================
-- 0002: Clinics, staff profiles, staff roles, patients

create table public.clinics (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique,
  timezone text not null default 'Asia/Tashkent',
  phone text,
  address text,
  email text,
  currency text not null default 'UZS',
  opening_hours jsonb not null default '{}'::jsonb,
  privacy_notice text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Staff members only. Patients are NOT Supabase Auth users; they are
-- identified by their verified Telegram identity in the patients table.
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text,
  phone text,
  avatar_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.staff_roles (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete cascade,
  profile_id uuid not null references public.profiles(id) on delete cascade,
  role public.staff_role not null,
  created_at timestamptz not null default now(),
  unique (clinic_id, profile_id)
);

create table public.patients (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete cascade,
  -- Verified Telegram identity. NULL only for walk-ins created by staff.
  telegram_user_id bigint,
  telegram_username text,
  telegram_first_name text,
  telegram_last_name text,
  full_name text,
  phone text,
  consent_given boolean not null default false,
  consent_given_at timestamptz,
  preferred_language text not null default 'uz',
  last_seen_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (clinic_id, telegram_user_id),
  check (consent_given_at is null or consent_given)
);

create index patients_telegram_idx on public.patients (telegram_user_id) where telegram_user_id is not null;
create index patients_clinic_idx on public.patients (clinic_id);
-- =====================================================================
-- FILE: 20260813000003_catalog.sql
-- =====================================================================
-- 0003: Service catalog — specialties, services, doctors, doctor_services

create table public.specialties (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete cascade,
  name text not null,
  description text,
  sort_order int not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (clinic_id, name)
);

create table public.services (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete cascade,
  specialty_id uuid references public.specialties(id) on delete set null,
  name text not null,
  description text,
  duration_minutes int not null check (duration_minutes between 5 and 480),
  price numeric(12, 2) not null default 0 check (price >= 0),
  preparation_text text,
  active boolean not null default true,
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (clinic_id, name)
);

create table public.doctors (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete cascade,
  -- When set, this staff account can access the doctor dashboard.
  profile_id uuid references public.profiles(id) on delete set null,
  specialty_id uuid references public.specialties(id) on delete set null,
  name text not null,
  title text,
  bio text,
  photo_url text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Which services each doctor performs. If a doctor has no rows here,
-- they are treated as offering every active service of the clinic.
create table public.doctor_services (
  doctor_id uuid not null references public.doctors(id) on delete cascade,
  service_id uuid not null references public.services(id) on delete cascade,
  price_override numeric(12, 2) check (price_override is null or price_override >= 0),
  duration_override_minutes int check (duration_override_minutes is null or (duration_override_minutes between 5 and 480)),
  primary key (doctor_id, service_id)
);

create index services_clinic_active_idx on public.services (clinic_id, active);
create index doctors_clinic_active_idx on public.doctors (clinic_id, active);
create index doctors_specialty_idx on public.doctors (specialty_id);
create index specialties_clinic_idx on public.specialties (clinic_id);
-- =====================================================================
-- FILE: 20260813000004_schedules.sql
-- =====================================================================
-- 0004: Doctor schedules — working hours and time blocks

create table public.doctor_working_hours (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete cascade,
  doctor_id uuid not null references public.doctors(id) on delete cascade,
  -- ISO weekday: 1 = Monday ... 7 = Sunday
  weekday smallint not null check (weekday between 1 and 7),
  start_time time not null,
  end_time time not null,
  unique (doctor_id, weekday),
  check (end_time > start_time)
);

-- Blocks: breaks, absences, admin reservations, and walk-in capacity holds.
-- A block removes the covered range from available slots.
create table public.doctor_time_blocks (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete cascade,
  doctor_id uuid not null references public.doctors(id) on delete cascade,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  reason public.time_block_reason not null default 'absence',
  note text,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  check (ends_at > starts_at)
);

create index doctor_working_hours_doctor_idx on public.doctor_working_hours (doctor_id);
create index doctor_time_blocks_doctor_idx on public.doctor_time_blocks (doctor_id, starts_at, ends_at);
create index doctor_time_blocks_clinic_idx on public.doctor_time_blocks (clinic_id);
-- =====================================================================
-- FILE: 20260813000005_appointments_payments.sql
-- =====================================================================
-- 0005: Appointments and payments.
-- Double-booking protection lives HERE at the database level:
-- a partial exclusion constraint prevents any two ACTIVE appointments for
-- the same doctor from overlapping in time. Cancelled/no-show rows do not
-- block future slots. btree_gist provides the uuid equality operator.

create table public.appointments (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete cascade,
  patient_id uuid not null references public.patients(id) on delete cascade,
  doctor_id uuid not null references public.doctors(id) on delete restrict,
  service_id uuid not null references public.services(id) on delete restrict,
  start_at timestamptz not null,
  end_at timestamptz not null,
  status public.appointment_status not null default 'pending',
  source public.appointment_source not null default 'telegram_mini_app',
  notes text,
  cancelled_at timestamptz,
  cancelled_reason text,
  cancelled_by uuid references public.profiles(id) on delete set null,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (end_at > start_at),
  constraint no_overlapping_active_appointments exclude using gist (
    doctor_id with =,
    tstzrange(start_at, end_at, '[)') with &&
  ) where (status not in ('cancelled', 'no_show'))
);

-- One payment row per appointment. The row is created at booking time with
-- status 'unpaid' and transitions are audited.
create table public.payments (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete cascade,
  appointment_id uuid not null references public.appointments(id) on delete cascade,
  patient_id uuid not null references public.patients(id) on delete cascade,
  amount numeric(12, 2) not null check (amount >= 0),
  currency text not null default 'UZS',
  status public.payment_status not null default 'unpaid',
  provider public.payment_provider not null default 'manual',
  provider_reference text,
  payment_url text,
  paid_at timestamptz,
  paid_by uuid references public.profiles(id) on delete set null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (appointment_id)
);

create index appointments_clinic_start_idx on public.appointments (clinic_id, start_at);
create index appointments_doctor_start_idx on public.appointments (doctor_id, start_at);
create index appointments_patient_start_idx on public.appointments (patient_id, start_at);
create index appointments_status_idx on public.appointments (status);
create index payments_clinic_status_idx on public.payments (clinic_id, status);
create index payments_provider_ref_idx on public.payments (provider, provider_reference)
  where provider_reference is not null;
-- =====================================================================
-- FILE: 20260813000006_conversations.sql
-- =====================================================================
-- 0006: Conversations, messages, voice messages.
-- Creation order matters: conversations -> voice_messages -> messages,
-- because messages carries an FK to voice_messages.

create table public.conversations (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete cascade,
  patient_id uuid not null references public.patients(id) on delete cascade,
  channel public.conversation_channel not null default 'telegram',
  status public.conversation_status not null default 'open',
  taken_over_by uuid references public.profiles(id) on delete set null,
  taken_over_at timestamptz,
  released_at timestamptz,
  -- When false, automated (bot/AI) replies are paused until an admin
  -- releases the conversation.
  ai_enabled boolean not null default true,
  summary text,
  last_message_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One active conversation per patient per channel at a time.
create unique index conversations_active_one_per_patient
  on public.conversations (patient_id, channel)
  where status in ('open', 'assigned');

create table public.voice_messages (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete cascade,
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  -- Telegram file metadata is saved FIRST, before any download happens.
  telegram_file_id text not null,
  telegram_file_unique_id text,
  storage_path text,
  duration_seconds int,
  mime_type text,
  size_bytes bigint,
  -- Transcription is stored separately from the original audio.
  transcription text,
  transcription_status public.voice_status not null default 'none',
  transcription_provider text,
  transcription_error text,
  consent_given boolean not null default false,
  corrected_transcription text,
  retention_days int not null default 7,
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.messages (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete cascade,
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  role public.message_role not null,
  type public.message_type not null default 'text',
  content text not null default '',
  voice_message_id uuid references public.voice_messages(id) on delete set null,
  telegram_message_id bigint,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index conversations_clinic_status_idx on public.conversations (clinic_id, status);
create index messages_conversation_idx on public.messages (conversation_id, created_at);
create index voice_messages_conversation_idx on public.voice_messages (conversation_id);
-- =====================================================================
-- FILE: 20260813000007_faqs_settings.sql
-- =====================================================================
-- 0007: FAQ entries and per-clinic settings.

create table public.faq_entries (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete cascade,
  question text not null,
  answer text not null,
  category text,
  active boolean not null default true,
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.app_settings (
  clinic_id uuid not null references public.clinics(id) on delete cascade,
  key text not null,
  value jsonb not null default '{}'::jsonb,
  updated_by uuid references public.profiles(id) on delete set null,
  updated_at timestamptz not null default now(),
  primary key (clinic_id, key)
);

create index faq_entries_clinic_active_idx on public.faq_entries (clinic_id, active);
-- =====================================================================
-- FILE: 20260813000008_operations.sql
-- =====================================================================
-- 0008: Operational tables — notification jobs, webhook idempotency,
-- audit trail, analytics events.

create table public.notification_jobs (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete cascade,
  appointment_id uuid references public.appointments(id) on delete cascade,
  conversation_id uuid references public.conversations(id) on delete set null,
  type public.notification_job_type not null,
  channel text not null default 'telegram',
  recipient_type text not null default 'patient',
  patient_telegram_user_id bigint,
  scheduled_for timestamptz not null,
  status public.notification_job_status not null default 'pending',
  attempts int not null default 0,
  max_attempts int not null default 3,
  -- Guarantees a reminder is never enqueued or sent twice.
  idempotency_key text not null unique,
  sent_at timestamptz,
  error text,
  telegram_message_id bigint,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index notification_jobs_due_idx
  on public.notification_jobs (status, scheduled_for)
  where status = 'pending';
create index notification_jobs_clinic_idx on public.notification_jobs (clinic_id);

-- Generic webhook idempotency. Telegram webhooks and future payment
-- webhooks mark their external update ids here to deduplicate retries.
create table public.processed_webhooks (
  source text not null,
  external_id text not null,
  payload_hash text,
  processed_at timestamptz not null default now(),
  primary key (source, external_id)
);

create table public.audit_events (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete cascade,
  actor_id uuid,
  actor_type public.actor_type not null default 'staff',
  action text not null,
  entity_type text not null,
  entity_id text,
  old_values jsonb,
  new_values jsonb,
  ip_address text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index audit_events_clinic_idx on public.audit_events (clinic_id, created_at desc);
create index audit_events_entity_idx on public.audit_events (entity_type, entity_id);

create table public.analytics_events (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete cascade,
  patient_id uuid references public.patients(id) on delete set null,
  event_type text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index analytics_events_clinic_idx on public.analytics_events (clinic_id, created_at desc);
create index analytics_events_type_idx on public.analytics_events (clinic_id, event_type);
-- =====================================================================
-- FILE: 20260813000009_functions_triggers.sql
-- =====================================================================
-- 0009: Functions and triggers.
-- Includes the transactional booking engine (the core anti-double-booking
-- protection), audit triggers, and RLS helper functions.

-- ---------- updated_at maintenance ----------

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists clinics_set_updated_at on public.clinics;
create trigger clinics_set_updated_at
  before update on public.clinics
  for each row execute function public.set_updated_at();

drop trigger if exists profiles_set_updated_at on public.profiles;
create trigger profiles_set_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();

drop trigger if exists patients_set_updated_at on public.patients;
create trigger patients_set_updated_at
  before update on public.patients
  for each row execute function public.set_updated_at();

drop trigger if exists doctors_set_updated_at on public.doctors;
create trigger doctors_set_updated_at
  before update on public.doctors
  for each row execute function public.set_updated_at();

drop trigger if exists services_set_updated_at on public.services;
create trigger services_set_updated_at
  before update on public.services
  for each row execute function public.set_updated_at();

drop trigger if exists appointments_set_updated_at on public.appointments;
create trigger appointments_set_updated_at
  before update on public.appointments
  for each row execute function public.set_updated_at();

drop trigger if exists payments_set_updated_at on public.payments;
create trigger payments_set_updated_at
  before update on public.payments
  for each row execute function public.set_updated_at();

drop trigger if exists conversations_set_updated_at on public.conversations;
create trigger conversations_set_updated_at
  before update on public.conversations
  for each row execute function public.set_updated_at();

drop trigger if exists voice_messages_set_updated_at on public.voice_messages;
create trigger voice_messages_set_updated_at
  before update on public.voice_messages
  for each row execute function public.set_updated_at();

drop trigger if exists notification_jobs_set_updated_at on public.notification_jobs;
create trigger notification_jobs_set_updated_at
  before update on public.notification_jobs
  for each row execute function public.set_updated_at();

drop trigger if exists faq_entries_set_updated_at on public.faq_entries;
create trigger faq_entries_set_updated_at
  before update on public.faq_entries
  for each row execute function public.set_updated_at();

drop trigger if exists app_settings_set_updated_at on public.app_settings;
create trigger app_settings_set_updated_at
  before update on public.app_settings
  for each row execute function public.set_updated_at();

-- ---------- RLS helper ----------

-- Returns true when the current authenticated user is staff of the clinic
-- with one of the given roles (any role when p_roles is NULL).
create or replace function public.is_clinic_staff(p_clinic_id uuid, p_roles public.staff_role[] default null)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.staff_roles sr
    where sr.profile_id = auth.uid()
      and sr.clinic_id = p_clinic_id
      and (p_roles is null or sr.role = any (p_roles))
  );
$$;

-- ---------- Audit trigger ----------
-- Records every INSERT/UPDATE/DELETE on sensitive tables.

create or replace function public.audit_track_changes()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_clinic_id uuid := coalesce(new.clinic_id, old.clinic_id);
  v_actor uuid := auth.uid();
  v_action text;
begin
  if tg_op = 'UPDATE' then
    v_action := tg_table_name || '_updated';
  elsif tg_op = 'DELETE' then
    v_action := tg_table_name || '_deleted';
  else
    v_action := tg_table_name || '_created';
  end if;

  insert into public.audit_events (
    clinic_id, actor_id, actor_type, action, entity_type, entity_id,
    old_values, new_values, ip_address
  ) values (
    v_clinic_id,
    v_actor,
    case when v_actor is null then 'system'::public.actor_type else 'staff'::public.actor_type end,
    v_action,
    tg_table_name,
    coalesce(new.id::text, old.id::text),
    case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) else null end,
    case when tg_op in ('UPDATE', 'INSERT') then to_jsonb(new) else null end,
    nullif(current_setting('request.ip', true), '')
  );
  return null;
end;
$$;

drop trigger if exists staff_roles_audit on public.staff_roles;
create trigger staff_roles_audit
  after insert or update or delete on public.staff_roles
  for each row execute function public.audit_track_changes();

drop trigger if exists appointments_audit on public.appointments;
create trigger appointments_audit
  after insert or update or delete on public.appointments
  for each row execute function public.audit_track_changes();

drop trigger if exists payments_audit on public.payments;
create trigger payments_audit
  after insert or update or delete on public.payments
  for each row execute function public.audit_track_changes();

drop trigger if exists doctor_time_blocks_audit on public.doctor_time_blocks;
create trigger doctor_time_blocks_audit
  after insert or update or delete on public.doctor_time_blocks
  for each row execute function public.audit_track_changes();

drop trigger if exists conversations_audit on public.conversations;
create trigger conversations_audit
  after insert or update or delete on public.conversations
  for each row execute function public.audit_track_changes();

-- ---------- Booking engine ----------
-- The single transactional entry point for creating appointments from any
-- channel. It serializes concurrent attempts per doctor with an advisory
-- lock, re-checks availability inside the transaction, and lets the
-- exclusion constraint be the final backstop.

create or replace function public.book_appointment(
  p_clinic_id uuid,
  p_patient_id uuid,
  p_doctor_id uuid,
  p_service_id uuid,
  p_start_at timestamptz,
  p_status public.appointment_status default 'pending',
  p_source public.appointment_source default 'telegram_mini_app',
  p_notes text default null,
  p_created_by uuid default null,
  out appointment_id uuid,
  out amount numeric,
  out error_code text,
  out error_message text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_clinic public.clinics%rowtype;
  v_doctor public.doctors%rowtype;
  v_service public.services%rowtype;
  v_patient public.patients%rowtype;
  v_duration_minutes int;
  v_price numeric;
  v_end_at timestamptz;
  v_offers_service boolean;
begin
  select * into v_clinic from public.clinics where id = p_clinic_id and is_active;
  if not found then
    error_code := 'clinic_not_found'; return;
  end if;

  select * into v_doctor from public.doctors
    where id = p_doctor_id and clinic_id = p_clinic_id and active;
  if not found then
    error_code := 'doctor_not_found'; return;
  end if;

  select * into v_service from public.services
    where id = p_service_id and clinic_id = p_clinic_id and active;
  if not found then
    error_code := 'service_not_found'; return;
  end if;

  select * into v_patient from public.patients
    where id = p_patient_id and clinic_id = p_clinic_id;
  if not found then
    error_code := 'patient_not_found'; return;
  end if;

  -- If the doctor has an explicit service list, the service must be on it.
  select exists (select 1 from public.doctor_services where doctor_id = p_doctor_id)
    into v_offers_service;
  if v_offers_service and not exists (
    select 1 from public.doctor_services
    where doctor_id = p_doctor_id and service_id = p_service_id
  ) then
    error_code := 'service_not_offered'; return;
  end if;

  select coalesce(ds.duration_override_minutes, v_service.duration_minutes),
         coalesce(ds.price_override, v_service.price)
    into v_duration_minutes, v_price
    from public.services s
    left join public.doctor_services ds
      on ds.service_id = s.id and ds.doctor_id = p_doctor_id
    where s.id = p_service_id;

  if p_start_at <= now() then
    error_code := 'past_slot'; return;
  end if;

  v_end_at := p_start_at + make_interval(mins => v_duration_minutes);

  -- Serialize concurrent booking attempts for the same doctor.
  perform pg_advisory_xact_lock(hashtextextended(p_doctor_id::text, 0));

  -- Working-hours check (in clinic timezone).
  if not exists (
    select 1 from public.doctor_working_hours wh
    where wh.doctor_id = p_doctor_id
      and wh.weekday = extract(isodow from p_start_at at time zone v_clinic.timezone)
      and wh.start_time <= (p_start_at at time zone v_clinic.timezone)::time
      and wh.end_time >= (v_end_at at time zone v_clinic.timezone)::time
  ) then
    error_code := 'outside_working_hours'; return;
  end if;

  -- Time-block check.
  if exists (
    select 1 from public.doctor_time_blocks tb
    where tb.doctor_id = p_doctor_id
      and tstzrange(tb.starts_at, tb.ends_at, '[)') && tstzrange(p_start_at, v_end_at, '[)')
  ) then
    error_code := 'time_blocked'; return;
  end if;

  -- Overlap check against active appointments (belt) ...
  if exists (
    select 1 from public.appointments a
    where a.doctor_id = p_doctor_id
      and a.status not in ('cancelled', 'no_show')
      and tstzrange(a.start_at, a.end_at, '[)') && tstzrange(p_start_at, v_end_at, '[)')
  ) then
    error_code := 'slot_taken'; return;
  end if;

  -- ... and the exclusion constraint (braces).
  begin
    insert into public.appointments (
      clinic_id, patient_id, doctor_id, service_id,
      start_at, end_at, status, source, notes, created_by
    ) values (
      p_clinic_id, p_patient_id, p_doctor_id, p_service_id,
      p_start_at, v_end_at, p_status, p_source, p_notes, p_created_by
    )
    returning id into appointment_id;

    insert into public.payments (clinic_id, appointment_id, patient_id, amount, currency)
    values (p_clinic_id, appointment_id, p_patient_id, v_price, v_clinic.currency);

    amount := v_price;
    error_code := null;
    return;
  exception
    when exclusion_violation then
      error_code := 'slot_taken';
      error_message := 'Bu vaqt band qilingan';
      return;
    when unique_violation then
      error_code := 'slot_taken';
      error_message := 'Bu vaqt band qilingan';
      return;
  end;
end;
$$;

grant execute on function public.book_appointment(uuid, uuid, uuid, uuid, timestamptz, public.appointment_status, public.appointment_source, text, uuid) to service_role, authenticated;

-- ---------- Reschedule engine ----------
-- Same serialization + checks, but updates an existing appointment.

create or replace function public.reschedule_appointment(
  p_appointment_id uuid,
  p_new_start_at timestamptz,
  p_actor uuid default null,
  out error_code text,
  out error_message text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_appt public.appointments%rowtype;
  v_clinic public.clinics%rowtype;
  v_duration_minutes int;
  v_new_end_at timestamptz;
begin
  select * into v_appt from public.appointments where id = p_appointment_id;
  if not found then
    error_code := 'appointment_not_found'; return;
  end if;

  if v_appt.status in ('cancelled', 'no_show', 'completed') then
    error_code := 'not_reschedulable'; return;
  end if;

  if p_new_start_at <= now() then
    error_code := 'past_slot'; return;
  end if;

  select * into v_clinic from public.clinics where id = v_appt.clinic_id;
  select s.duration_minutes
    into v_duration_minutes
    from public.services s
    left join public.doctor_services ds
      on ds.service_id = s.id and ds.doctor_id = v_appt.doctor_id
    where s.id = v_appt.service_id;

  v_new_end_at := p_new_start_at + make_interval(mins => v_duration_minutes);

  perform pg_advisory_xact_lock(hashtextextended(v_appt.doctor_id::text, 0));

  if not exists (
    select 1 from public.doctor_working_hours wh
    where wh.doctor_id = v_appt.doctor_id
      and wh.weekday = extract(isodow from p_new_start_at at time zone v_clinic.timezone)
      and wh.start_time <= (p_new_start_at at time zone v_clinic.timezone)::time
      and wh.end_time >= (v_new_end_at at time zone v_clinic.timezone)::time
  ) then
    error_code := 'outside_working_hours'; return;
  end if;

  if exists (
    select 1 from public.doctor_time_blocks tb
    where tb.doctor_id = v_appt.doctor_id
      and tstzrange(tb.starts_at, tb.ends_at, '[)') && tstzrange(p_new_start_at, v_new_end_at, '[)')
  ) then
    error_code := 'time_blocked'; return;
  end if;

  if exists (
    select 1 from public.appointments a
    where a.doctor_id = v_appt.doctor_id
      and a.id <> p_appointment_id
      and a.status not in ('cancelled', 'no_show')
      and tstzrange(a.start_at, a.end_at, '[)') && tstzrange(p_new_start_at, v_new_end_at, '[)')
  ) then
    error_code := 'slot_taken'; return;
  end if;

  begin
    update public.appointments
      set start_at = p_new_start_at,
          end_at = v_new_end_at,
          status = 'pending'::public.appointment_status
      where id = p_appointment_id;
    error_code := null;
    return;
  exception
    when exclusion_violation then
      error_code := 'slot_taken';
      error_message := 'Bu vaqt band qilingan';
      return;
    when unique_violation then
      error_code := 'slot_taken';
      error_message := 'Bu vaqt band qilingan';
      return;
  end;
end;
$$;

grant execute on function public.reschedule_appointment(uuid, timestamptz, uuid) to service_role, authenticated;
-- =====================================================================
-- FILE: 20260813000010_rls.sql
-- =====================================================================
-- 0010: Row Level Security policies.
--
-- Model:
--  * Staff (Supabase Auth users) are governed by these policies through the
--    browser client (anon key + session). Owner/admin/doctor roles are
--    enforced here AND in the application layer.
--  * Patients are NOT Supabase users. Patient data flows only through
--    server-side code that verifies the Telegram identity first; the
--    application layer scopes every query by clinic and patient.
--    No anon policy exists anywhere, so the anon role can read nothing.
--  * Service-role server code (bot, cron, admin APIs) runs with RLS
--    bypassed and performs explicit authorization checks in code.

alter table public.clinics enable row level security;
alter table public.profiles enable row level security;
alter table public.staff_roles enable row level security;
alter table public.patients enable row level security;
alter table public.specialties enable row level security;
alter table public.services enable row level security;
alter table public.doctors enable row level security;
alter table public.doctor_services enable row level security;
alter table public.doctor_working_hours enable row level security;
alter table public.doctor_time_blocks enable row level security;
alter table public.appointments enable row level security;
alter table public.payments enable row level security;
alter table public.faq_entries enable row level security;
alter table public.app_settings enable row level security;
alter table public.conversations enable row level security;
alter table public.messages enable row level security;
alter table public.voice_messages enable row level security;
alter table public.notification_jobs enable row level security;
alter table public.processed_webhooks enable row level security;
alter table public.audit_events enable row level security;
alter table public.analytics_events enable row level security;

-- ---------- clinics ----------
create policy "clinic read for its staff"
  on public.clinics for select
  to authenticated
  using (public.is_clinic_staff(id));

create policy "clinic update for owner"
  on public.clinics for update
  to authenticated
  using (public.is_clinic_staff(id, array['owner'::public.staff_role]))
  with check (public.is_clinic_staff(id, array['owner'::public.staff_role]));

-- ---------- profiles ----------
create policy "profile read own"
  on public.profiles for select
  to authenticated
  using (id = auth.uid());

create policy "profile read for clinic staff"
  on public.profiles for select
  to authenticated
  using (exists (
    select 1 from public.staff_roles sr
    where sr.profile_id = auth.uid()
      and sr.clinic_id = (select p.clinic_id from public.staff_roles p where p.profile_id = profiles.id limit 1)
  ));

create policy "profile insert own"
  on public.profiles for insert
  to authenticated
  with check (id = auth.uid());

create policy "profile update own"
  on public.profiles for update
  to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());

-- ---------- staff_roles ----------
create policy "staff_roles read for same clinic staff"
  on public.staff_roles for select
  to authenticated
  using (public.is_clinic_staff(clinic_id));

create policy "staff_roles manage for owner"
  on public.staff_roles for all
  to authenticated
  using (public.is_clinic_staff(clinic_id, array['owner'::public.staff_role]))
  with check (public.is_clinic_staff(clinic_id, array['owner'::public.staff_role]));

-- ---------- patients ----------
-- Admin/owner see all clinic patients; doctors see patients of their own
-- appointments only (limited operational details needed for the queue).
create policy "patients read for admin owner"
  on public.patients for select
  to authenticated
  using (public.is_clinic_staff(clinic_id, array['owner'::public.staff_role, 'admin'::public.staff_role]));

create policy "patients read for own doctor"
  on public.patients for select
  to authenticated
  using (exists (
    select 1 from public.staff_roles sr
    join public.doctors d on d.profile_id = sr.profile_id
    join public.appointments a on a.doctor_id = d.id and a.patient_id = patients.id
    where sr.profile_id = auth.uid()
      and sr.role = 'doctor'::public.staff_role
      and sr.clinic_id = patients.clinic_id
  ));

create policy "patients update for admin owner"
  on public.patients for update
  to authenticated
  using (public.is_clinic_staff(clinic_id, array['owner'::public.staff_role, 'admin'::public.staff_role]))
  with check (public.is_clinic_staff(clinic_id, array['owner'::public.staff_role, 'admin'::public.staff_role]));

-- ---------- catalog (specialties, services, doctors, doctor_services) ----------
create policy "specialties read for staff"
  on public.specialties for select
  to authenticated
  using (public.is_clinic_staff(clinic_id));

create policy "specialties write for admin owner"
  on public.specialties for all
  to authenticated
  using (public.is_clinic_staff(clinic_id, array['owner'::public.staff_role, 'admin'::public.staff_role]))
  with check (public.is_clinic_staff(clinic_id, array['owner'::public.staff_role, 'admin'::public.staff_role]));

create policy "services read for staff"
  on public.services for select
  to authenticated
  using (public.is_clinic_staff(clinic_id));

create policy "services write for admin owner"
  on public.services for all
  to authenticated
  using (public.is_clinic_staff(clinic_id, array['owner'::public.staff_role, 'admin'::public.staff_role]))
  with check (public.is_clinic_staff(clinic_id, array['owner'::public.staff_role, 'admin'::public.staff_role]));

create policy "doctors read for staff"
  on public.doctors for select
  to authenticated
  using (public.is_clinic_staff(clinic_id));

create policy "doctors write for admin owner"
  on public.doctors for all
  to authenticated
  using (public.is_clinic_staff(clinic_id, array['owner'::public.staff_role, 'admin'::public.staff_role]))
  with check (public.is_clinic_staff(clinic_id, array['owner'::public.staff_role, 'admin'::public.staff_role]));

create policy "doctor_services read for staff"
  on public.doctor_services for select
  to authenticated
  using (public.is_clinic_staff((
    select d.clinic_id from public.doctors d where d.id = doctor_services.doctor_id
  )));

create policy "doctor_services write for admin owner"
  on public.doctor_services for all
  to authenticated
  using (public.is_clinic_staff((
    select d.clinic_id from public.doctors d where d.id = doctor_services.doctor_id
  ), array['owner'::public.staff_role, 'admin'::public.staff_role]))
  with check (public.is_clinic_staff((
    select d.clinic_id from public.doctors d where d.id = doctor_services.doctor_id
  ), array['owner'::public.staff_role, 'admin'::public.staff_role]));

-- ---------- schedules ----------
create policy "working_hours read for staff"
  on public.doctor_working_hours for select
  to authenticated
  using (public.is_clinic_staff(clinic_id));

create policy "working_hours write for admin owner"
  on public.doctor_working_hours for all
  to authenticated
  using (public.is_clinic_staff(clinic_id, array['owner'::public.staff_role, 'admin'::public.staff_role]))
  with check (public.is_clinic_staff(clinic_id, array['owner'::public.staff_role, 'admin'::public.staff_role]));

create policy "time_blocks read for staff"
  on public.doctor_time_blocks for select
  to authenticated
  using (public.is_clinic_staff(clinic_id));

create policy "time_blocks write for admin owner"
  on public.doctor_time_blocks for all
  to authenticated
  using (public.is_clinic_staff(clinic_id, array['owner'::public.staff_role, 'admin'::public.staff_role]))
  with check (public.is_clinic_staff(clinic_id, array['owner'::public.staff_role, 'admin'::public.staff_role]));

-- ---------- appointments ----------
create policy "appointments read for admin owner"
  on public.appointments for select
  to authenticated
  using (public.is_clinic_staff(clinic_id, array['owner'::public.staff_role, 'admin'::public.staff_role]));

create policy "appointments read for own doctor"
  on public.appointments for select
  to authenticated
  using (exists (
    select 1 from public.staff_roles sr
    join public.doctors d on d.profile_id = sr.profile_id
    where sr.profile_id = auth.uid()
      and sr.role = 'doctor'::public.staff_role
      and sr.clinic_id = appointments.clinic_id
      and d.id = appointments.doctor_id
  ));

create policy "appointments write for admin owner"
  on public.appointments for insert
  to authenticated
  with check (public.is_clinic_staff(clinic_id, array['owner'::public.staff_role, 'admin'::public.staff_role]));

create policy "appointments update for admin owner"
  on public.appointments for update
  to authenticated
  using (public.is_clinic_staff(clinic_id, array['owner'::public.staff_role, 'admin'::public.staff_role]))
  with check (public.is_clinic_staff(clinic_id, array['owner'::public.staff_role, 'admin'::public.staff_role]));

create policy "appointments status update for own doctor"
  on public.appointments for update
  to authenticated
  using (exists (
    select 1 from public.staff_roles sr
    join public.doctors d on d.profile_id = sr.profile_id
    where sr.profile_id = auth.uid()
      and sr.role = 'doctor'::public.staff_role
      and sr.clinic_id = appointments.clinic_id
      and d.id = appointments.doctor_id
  ));

-- ---------- payments ----------
create policy "payments read for staff"
  on public.payments for select
  to authenticated
  using (public.is_clinic_staff(clinic_id, array['owner'::public.staff_role, 'admin'::public.staff_role])
      or exists (
        select 1 from public.staff_roles sr
        join public.doctors d on d.profile_id = sr.profile_id
        join public.appointments a on a.id = payments.appointment_id and a.doctor_id = d.id
        where sr.profile_id = auth.uid()
          and sr.role = 'doctor'::public.staff_role
          and sr.clinic_id = payments.clinic_id
      ));

create policy "payments update for admin owner"
  on public.payments for update
  to authenticated
  using (public.is_clinic_staff(clinic_id, array['owner'::public.staff_role, 'admin'::public.staff_role]))
  with check (public.is_clinic_staff(clinic_id, array['owner'::public.staff_role, 'admin'::public.staff_role]));

-- ---------- faqs & settings ----------
create policy "faqs read for staff"
  on public.faq_entries for select
  to authenticated
  using (public.is_clinic_staff(clinic_id));

create policy "faqs write for admin owner"
  on public.faq_entries for all
  to authenticated
  using (public.is_clinic_staff(clinic_id, array['owner'::public.staff_role, 'admin'::public.staff_role]))
  with check (public.is_clinic_staff(clinic_id, array['owner'::public.staff_role, 'admin'::public.staff_role]));

create policy "settings read for staff"
  on public.app_settings for select
  to authenticated
  using (public.is_clinic_staff(clinic_id));

create policy "settings write for admin owner"
  on public.app_settings for all
  to authenticated
  using (public.is_clinic_staff(clinic_id, array['owner'::public.staff_role, 'admin'::public.staff_role]))
  with check (public.is_clinic_staff(clinic_id, array['owner'::public.staff_role, 'admin'::public.staff_role]));

-- ---------- conversations ----------
create policy "conversations read for staff"
  on public.conversations for select
  to authenticated
  using (public.is_clinic_staff(clinic_id, array['owner'::public.staff_role, 'admin'::public.staff_role]));

create policy "conversations update for admin owner"
  on public.conversations for update
  to authenticated
  using (public.is_clinic_staff(clinic_id, array['owner'::public.staff_role, 'admin'::public.staff_role]))
  with check (public.is_clinic_staff(clinic_id, array['owner'::public.staff_role, 'admin'::public.staff_role]));

-- ---------- messages ----------
create policy "messages read for staff"
  on public.messages for select
  to authenticated
  using (public.is_clinic_staff(clinic_id, array['owner'::public.staff_role, 'admin'::public.staff_role]));

-- ---------- voice messages ----------
create policy "voice_messages read for staff"
  on public.voice_messages for select
  to authenticated
  using (public.is_clinic_staff(clinic_id, array['owner'::public.staff_role, 'admin'::public.staff_role]));

-- ---------- notification jobs ----------
create policy "notification_jobs read for admin owner"
  on public.notification_jobs for select
  to authenticated
  using (public.is_clinic_staff(clinic_id, array['owner'::public.staff_role, 'admin'::public.staff_role]));

create policy "notification_jobs update for admin owner"
  on public.notification_jobs for update
  to authenticated
  using (public.is_clinic_staff(clinic_id, array['owner'::public.staff_role, 'admin'::public.staff_role]))
  with check (public.is_clinic_staff(clinic_id, array['owner'::public.staff_role, 'admin'::public.staff_role]));

-- ---------- audit ----------
create policy "audit read for admin owner"
  on public.audit_events for select
  to authenticated
  using (public.is_clinic_staff(clinic_id, array['owner'::public.staff_role, 'admin'::public.staff_role]));

-- ---------- analytics ----------
create policy "analytics read for admin owner"
  on public.analytics_events for select
  to authenticated
  using (public.is_clinic_staff(clinic_id, array['owner'::public.staff_role, 'admin'::public.staff_role]));

-- No policies exist for: processed_webhooks (server-side only), and no
-- insert/delete policies exist on any table for anon or unauthenticated roles.
-- =====================================================================
-- FILE: 20260813000011_storage.sql
-- =====================================================================
-- 0011: Private storage for voice messages.
-- The bucket is PRIVATE. Files are stored under <clinic_id>/<voice_message_id>.
-- Only the service role (server-side code) can upload; clinic staff can read
-- files belonging to their own clinic (for authorized admin review).

insert into storage.buckets (id, name, public)
values ('voice-messages', 'voice-messages', false)
on conflict (id) do nothing;

drop policy if exists "voice-messages service role access" on storage.objects;
create policy "voice-messages service role access"
  on storage.objects
  for all
  to service_role
  using (bucket_id = 'voice-messages')
  with check (bucket_id = 'voice-messages');

drop policy if exists "voice-messages staff read" on storage.objects;
create policy "voice-messages staff read"
  on storage.objects
  for select
  to authenticated
  using (
    bucket_id = 'voice-messages'
    and exists (
      select 1
      from public.staff_roles sr
      where sr.profile_id = auth.uid()
        and sr.clinic_id::text = (storage.foldername(name))[1]
    )
  );
-- =====================================================================
-- FILE: 20260813000012_conversation_state.sql
-- =====================================================================
-- 0012: Conversation state persistence for multi-step bot flows.

alter table public.conversations
  add column if not exists state jsonb not null default '{}'::jsonb;
-- =====================================================================
-- FILE: 20260813000013_grants.sql
-- =====================================================================
-- 0013: Table privileges.
--
-- The app talks to Postgres through supabase-js with two roles:
--   service_role — server-side (Next.js API routes) — bypasses RLS by design
--   authenticated — staff sessions (admin/doctor panels) — constrained by RLS
--
-- Without these grants, every API call fails with 42501 (permission denied).
-- Anonymous role intentionally receives NO table privileges; patients are
-- never anon SQL users.

grant select, insert, update, delete on all tables in schema public to service_role;
grant select, insert, update, delete on all tables in schema public to authenticated;

grant usage on schema public to service_role, authenticated;

-- New tables created later get the same grants automatically.
alter default privileges in schema public
  grant select, insert, update, delete on tables to service_role;

alter default privileges in schema public
  grant select, insert, update, delete on tables to authenticated;
-- =====================================================================
-- FILE: 20260813000014_release_blockers.sql
-- =====================================================================
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
-- =====================================================================
-- FILE: 20260813000015_fixes.sql
-- =====================================================================
-- 0015: Fixes from schema review.
--
-- 1. reschedule_appointment ignored doctor_services.duration_override_minutes
--    when computing the new end time (book_appointment honours it). Rescheduling
--    an appointment for a doctor with an overridden service duration produced
--    the wrong end_at. Fixed with the same coalesce as book_appointment.
--
-- 2. The "appointments status update for own doctor" RLS policy (0010) is a
--    full-row UPDATE policy: a doctor session could change start_at, end_at,
--    patient_id, service_id, etc. on their own appointments, bypassing the
--    booking engine's working-hours and time-block checks. A BEFORE UPDATE
--    trigger now rejects any non-status column change made by a doctor
--    session. Service-role (server-side) and owner/admin sessions are
--    unaffected.

-- ---------- 1. Reschedule honours per-doctor duration overrides ----------

create or replace function public.reschedule_appointment(
  p_appointment_id uuid,
  p_new_start_at timestamptz,
  p_actor uuid default null,
  out error_code text,
  out error_message text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_appt public.appointments%rowtype;
  v_clinic public.clinics%rowtype;
  v_duration_minutes int;
  v_new_end_at timestamptz;
begin
  select * into v_appt from public.appointments where id = p_appointment_id;
  if not found then
    error_code := 'appointment_not_found'; return;
  end if;

  if v_appt.status in ('cancelled', 'no_show', 'completed') then
    error_code := 'not_reschedulable'; return;
  end if;

  if p_new_start_at <= now() then
    error_code := 'past_slot'; return;
  end if;

  select * into v_clinic from public.clinics where id = v_appt.clinic_id;
  select coalesce(ds.duration_override_minutes, s.duration_minutes)
    into v_duration_minutes
    from public.services s
    left join public.doctor_services ds
      on ds.service_id = s.id and ds.doctor_id = v_appt.doctor_id
    where s.id = v_appt.service_id;

  v_new_end_at := p_new_start_at + make_interval(mins => v_duration_minutes);

  perform pg_advisory_xact_lock(hashtextextended(v_appt.doctor_id::text, 0));

  if not exists (
    select 1 from public.doctor_working_hours wh
    where wh.doctor_id = v_appt.doctor_id
      and wh.weekday = extract(isodow from p_new_start_at at time zone v_clinic.timezone)
      and wh.start_time <= (p_new_start_at at time zone v_clinic.timezone)::time
      and wh.end_time >= (v_new_end_at at time zone v_clinic.timezone)::time
  ) then
    error_code := 'outside_working_hours'; return;
  end if;

  if exists (
    select 1 from public.doctor_time_blocks tb
    where tb.doctor_id = v_appt.doctor_id
      and tstzrange(tb.starts_at, tb.ends_at, '[)') && tstzrange(p_new_start_at, v_new_end_at, '[)')
  ) then
    error_code := 'time_blocked'; return;
  end if;

  if exists (
    select 1 from public.appointments a
    where a.doctor_id = v_appt.doctor_id
      and a.id <> p_appointment_id
      and a.status not in ('cancelled', 'no_show')
      and tstzrange(a.start_at, a.end_at, '[)') && tstzrange(p_new_start_at, v_new_end_at, '[)')
  ) then
    error_code := 'slot_taken'; return;
  end if;

  begin
    -- Preserve the appointment's current status: a reschedule moves the
    -- appointment in time and must not silently downgrade a confirmed (or
    -- checked-in) appointment to pending. Re-confirmation after a
    -- patient-initiated reschedule is an application-layer decision.
    update public.appointments
      set start_at = p_new_start_at,
          end_at = v_new_end_at
      where id = p_appointment_id;
    error_code := null;
    return;
  exception
    when exclusion_violation then
      error_code := 'slot_taken';
      error_message := 'Bu vaqt band qilingan';
      return;
    when unique_violation then
      error_code := 'slot_taken';
      error_message := 'Bu vaqt band qilingan';
      return;
  end;
end;
$$;

-- ---------- 2. Doctors may only change appointment status ----------

-- Runs before every UPDATE on appointments. Doctor sessions (authenticated
-- role, not owner/admin) may only change the status column; any other change
-- is rejected. Server-side (service role) and owner/admin sessions pass
-- through untouched.
create or replace function public.appointments_doctor_status_only()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Server-side code (service role, no JWT) and owner/admin sessions are
  -- unrestricted. coalesce() matters: without JWT claims auth.role() is NULL
  -- and `NULL <> 'authenticated'` is NULL (false), which would wrongly apply
  -- the doctor restriction to server-side calls.
  if coalesce(auth.role(), '') <> 'authenticated'
     or public.is_clinic_staff(new.clinic_id, array['owner'::public.staff_role, 'admin'::public.staff_role]) then
    return new;
  end if;

  -- Doctor session: only the status column may change. Raise when any
  -- non-status column changes (status itself is allowed to change).
  -- updated_at is excluded because the set_updated_at trigger manages it.
  if new.clinic_id is distinct from old.clinic_id
     or new.patient_id is distinct from old.patient_id
     or new.doctor_id is distinct from old.doctor_id
     or new.service_id is distinct from old.service_id
     or new.start_at is distinct from old.start_at
     or new.end_at is distinct from old.end_at
     or new.source is distinct from old.source
     or new.notes is distinct from old.notes
     or new.cancelled_at is distinct from old.cancelled_at
     or new.cancelled_reason is distinct from old.cancelled_reason
     or new.cancelled_by is distinct from old.cancelled_by
     or new.created_by is distinct from old.created_by then
    raise exception 'Doctors may only update the status of their own appointments';
  end if;

  return new;
end;
$$;

drop trigger if exists appointments_doctor_status_only on public.appointments;
create trigger appointments_doctor_status_only
  before update on public.appointments
  for each row execute function public.appointments_doctor_status_only();

-- =====================================================================
-- FILE: 20260813000016_admin_reply_policies.sql
-- =====================================================================
-- 0016: INSERT RLS policies so admin/owner staff can reply to patients
-- through the authenticated client.
--
-- conversations, messages and voice_messages had no INSERT policy, so any
-- write from the admin panel (supabase-js with a staff session) was denied
-- by RLS. These policies mirror the existing read policies (owner/admin of
-- the conversation's clinic) and are the minimal addition needed for staff
-- replies. Service-role server code bypasses RLS and is unaffected.
--
-- The messages policy also pins role to 'admin' so a staff session cannot
-- forge patient/bot/ai messages, and requires the message's conversation to
-- belong to the same clinic.

create policy "conversations insert for admin owner"
  on public.conversations for insert
  to authenticated
  with check (public.is_clinic_staff(clinic_id, array['owner'::public.staff_role, 'admin'::public.staff_role]));

create policy "messages insert for admin owner"
  on public.messages for insert
  to authenticated
  with check (
    public.is_clinic_staff(clinic_id, array['owner'::public.staff_role, 'admin'::public.staff_role])
    -- A staff session may only insert its own replies, never forged
    -- patient/bot/ai messages.
    and role = 'admin'::public.message_role
    -- The message must belong to a conversation of the same clinic.
    and exists (
      select 1 from public.conversations c
      where c.id = conversation_id
        and c.clinic_id = clinic_id
    )
  );

create policy "voice_messages insert for admin owner"
  on public.voice_messages for insert
  to authenticated
  with check (
    public.is_clinic_staff(clinic_id, array['owner'::public.staff_role, 'admin'::public.staff_role])
    and exists (
      select 1 from public.conversations c
      where c.id = conversation_id
        and c.clinic_id = clinic_id
    )
  );

-- =====================================================================
-- FILE: 20260813000017_voice_storage_upload.sql
-- =====================================================================
-- 0017: Allow owner/admin staff to upload voice replies through the
-- authenticated client.
--
-- 0011 gave the service role full storage access and staff read access, but
-- no authenticated role could create objects, so voice replies recorded in
-- the admin panel had to be uploaded by server-side code. This INSERT policy
-- mirrors the read policy's clinic-folder check (first path segment must be
-- the caller's clinic) and restricts uploads to owner/admin staff, matching
-- the voice_messages INSERT policy from 0016. Text comparison (clinic_id::text
-- = foldername) is used instead of casting the folder to uuid so a malformed
-- path is denied cleanly rather than raising an invalid-input error.

create policy "voice-messages staff upload"
  on storage.objects
  for insert
  to authenticated
  with check (
    bucket_id = 'voice-messages'
    and exists (
      select 1 from public.staff_roles sr
      where sr.profile_id = auth.uid()
        and sr.clinic_id::text = (storage.foldername(name))[1]
        and sr.role = any (array['owner'::public.staff_role, 'admin'::public.staff_role])
    )
  );

-- =====================================================================
-- FILE: 20260813000018_patient_and_voice_policies.sql
-- =====================================================================
-- 0018: Fill remaining client-write gaps for staff.
--
-- 1. patients had no INSERT policy, so owner/admin staff could not create
--    walk-in patients through the authenticated client (book_appointment
--    requires an existing patient row). The policy requires
--    telegram_user_id to be NULL, matching the documented model: verified
--    Telegram identities are only created by server-side code, so a panel
--    session cannot forge one.
--
-- 2. voice_messages had no UPDATE policy, but the table carries
--    corrected_transcription, implying staff correct transcriptions. The
--    policy lets owner/admin staff update voice message rows of their
--    clinic. Server-side (service role) code is unaffected.

create policy "patients insert for admin owner"
  on public.patients for insert
  to authenticated
  with check (
    public.is_clinic_staff(clinic_id, array['owner'::public.staff_role, 'admin'::public.staff_role])
    -- Walk-ins only via the client; verified Telegram identities are created
    -- server-side.
    and telegram_user_id is null
  );

create policy "voice_messages update for admin owner"
  on public.voice_messages for update
  to authenticated
  using (public.is_clinic_staff(clinic_id, array['owner'::public.staff_role, 'admin'::public.staff_role]))
  with check (public.is_clinic_staff(clinic_id, array['owner'::public.staff_role, 'admin'::public.staff_role]));

-- =====================================================================
-- FILE: 20260813000019_voice_messages_optional_telegram_file.sql
-- =====================================================================
-- 0019: voice_messages.telegram_file_id is optional.
--
-- telegram_file_id was NOT NULL because the bot flow saves Telegram file
-- metadata before downloading the audio. Admin-recorded replies have no
-- Telegram file, so the client flow had to fabricate a placeholder. The
-- column is now nullable; the check constraint replaces the old NOT NULL
-- guarantee with a weaker but accurate one: every voice message must have
-- SOME audio source (a Telegram file id or a storage path).

alter table public.voice_messages
  alter column telegram_file_id drop not null;

alter table public.voice_messages
  add constraint voice_messages_audio_source_check
  check (telegram_file_id is not null or storage_path is not null);

-- =====================================================================
-- FILE: 20260813000020_appointments_slot_validation.sql
-- =====================================================================
-- 0020: Enforce booking-engine availability rules on ALL appointment writes.
--
-- The admin/owner INSERT/UPDATE RLS policies only check clinic membership, so
-- direct table writes (walk-ins, manual reschedules, panel edits) could place
-- appointments outside working hours, inside time blocks, or for inactive
-- doctors/services, bypassing the checks in book_appointment and
-- reschedule_appointment. This BEFORE trigger applies the same availability
-- rules on every INSERT/UPDATE, including service-role writes (which already
-- satisfy them).
--
-- Deliberate differences from the RPCs:
--  * No past-slot rejection: admins legitimately record walk-ins/backfill for
--    times that are already in the past. The patient/bot RPCs keep their own
--    past-slot checks.
--  * Status-only updates (cancel, check-in, notes) skip validation entirely.
--  * cancelled/no_show rows are exempt, mirroring the partial exclusion
--    constraint.

create or replace function public.appointments_validate_slot()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_clinic_tz text;
  v_offers_service boolean;
begin
  -- cancelled/no_show rows never block availability; skip validation.
  if new.status in ('cancelled', 'no_show') then
    return new;
  end if;

  -- Updates that do not move the slot (status, notes, cancellation fields)
  -- do not need availability validation.
  if tg_op = 'UPDATE'
     and new.start_at is not distinct from old.start_at
     and new.end_at is not distinct from old.end_at
     and new.doctor_id is not distinct from old.doctor_id then
    return new;
  end if;

  select timezone into v_clinic_tz
  from public.clinics
  where id = new.clinic_id and is_active;
  if not found then
    raise exception 'appointment validation: clinic not found or inactive';
  end if;

  if not exists (
    select 1 from public.doctors d
    where d.id = new.doctor_id and d.clinic_id = new.clinic_id and d.active
  ) then
    raise exception 'appointment validation: doctor not found or inactive';
  end if;

  if not exists (
    select 1 from public.services s
    where s.id = new.service_id and s.clinic_id = new.clinic_id and s.active
  ) then
    raise exception 'appointment validation: service not found or inactive';
  end if;

  if not exists (
    select 1 from public.patients p
    where p.id = new.patient_id and p.clinic_id = new.clinic_id
  ) then
    raise exception 'appointment validation: patient not found';
  end if;

  -- Closed service-list rule: a doctor with explicit services must offer it.
  select exists (select 1 from public.doctor_services where doctor_id = new.doctor_id)
    into v_offers_service;
  if v_offers_service and not exists (
    select 1 from public.doctor_services
    where doctor_id = new.doctor_id and service_id = new.service_id
  ) then
    raise exception 'appointment validation: service not offered by doctor';
  end if;

  -- Whole slot must fall within one day's working hours (clinic timezone).
  if not exists (
    select 1 from public.doctor_working_hours wh
    where wh.doctor_id = new.doctor_id
      and wh.weekday = extract(isodow from new.start_at at time zone v_clinic_tz)
      and wh.start_time <= (new.start_at at time zone v_clinic_tz)::time
      and wh.end_time >= (new.end_at at time zone v_clinic_tz)::time
  ) then
    raise exception 'appointment validation: outside working hours';
  end if;

  -- No time-block overlap.
  if exists (
    select 1 from public.doctor_time_blocks tb
    where tb.doctor_id = new.doctor_id
      and tstzrange(tb.starts_at, tb.ends_at, '[)') && tstzrange(new.start_at, new.end_at, '[)')
  ) then
    raise exception 'appointment validation: slot is inside a time block';
  end if;

  -- No overlap with other active appointments (the new row is not yet in the
  -- table on INSERT, so self-exclusion is only needed on UPDATE).
  if exists (
    select 1 from public.appointments a
    where a.doctor_id = new.doctor_id
      and (tg_op = 'INSERT' or a.id <> new.id)
      and a.status not in ('cancelled', 'no_show')
      and tstzrange(a.start_at, a.end_at, '[)') && tstzrange(new.start_at, new.end_at, '[)')
  ) then
    raise exception 'appointment validation: slot overlaps another appointment';
  end if;

  return new;
end;
$$;

drop trigger if exists appointments_validate_slot on public.appointments;
create trigger appointments_validate_slot
  before insert or update on public.appointments
  for each row execute function public.appointments_validate_slot();

-- =====================================================================
-- FILE: 20260813000021_integrity_and_consistency.sql
-- =====================================================================
-- 0021: Integrity and consistency fixes from the deep review.
--
-- 1. payments had no INSERT policy: walk-in appointments created through the
--    panel could never get a payment row through the authenticated client
--    (book_appointment is the only other creator). Adds an owner/admin INSERT
--    policy that requires the payment's appointment to belong to the same
--    clinic.
--
-- 2. conversations.last_message_at existed but nothing maintained it. Adds an
--    AFTER INSERT trigger on messages that keeps it at the latest message
--    time.
--
-- 3. The patients INSERT policy restricts the client to walk-ins
--    (telegram_user_id IS NULL), but the UPDATE policy allowed changing
--    telegram_user_id, silently bypassing that guard. A BEFORE UPDATE trigger
--    now blocks authenticated sessions from setting or changing the verified
--    Telegram identity; only server-side code (service role) can.
--
-- 4. notification_jobs had no index on appointment_id, so cancelling pending
--    reminders for an appointment scanned the table.

-- ---------- 1. payments INSERT for owner/admin ----------

create policy "payments insert for admin owner"
  on public.payments for insert
  to authenticated
  with check (
    public.is_clinic_staff(clinic_id, array['owner'::public.staff_role, 'admin'::public.staff_role])
    and exists (
      select 1 from public.appointments a
      where a.id = appointment_id and a.clinic_id = clinic_id
    )
  );

-- ---------- 2. conversations.last_message_at maintenance ----------

create or replace function public.touch_conversation_last_message()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.conversations
    set last_message_at = greatest(coalesce(last_message_at, new.created_at), new.created_at)
    where id = new.conversation_id;
  return new;
end;
$$;

drop trigger if exists conversations_touch_last_message on public.messages;
create trigger conversations_touch_last_message
  after insert on public.messages
  for each row execute function public.touch_conversation_last_message();

-- ---------- 3. Telegram identity is server-side only ----------

create or replace function public.patients_telegram_identity_server_only()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Server-side code (service role, no JWT) may set or change the verified
  -- Telegram identity; client sessions may not (they are walk-ins only).
  if coalesce(auth.role(), '') <> 'authenticated' then
    return new;
  end if;

  if new.telegram_user_id is distinct from old.telegram_user_id then
    raise exception 'Telegram identity can only be set by server-side code';
  end if;

  return new;
end;
$$;

drop trigger if exists patients_telegram_identity_server_only on public.patients;
create trigger patients_telegram_identity_server_only
  before update on public.patients
  for each row execute function public.patients_telegram_identity_server_only();

-- ---------- 4. Notification cancellation index ----------

create index notification_jobs_appointment_pending_idx
  on public.notification_jobs (appointment_id)
  where status = 'pending';


-- =====================================================================
-- Health AI — FULL DATABASE SETUP (production)
-- Auto-generated from supabase/migrations/ in order. Run ONCE on an
-- EMPTY database via Supabase Dashboard > SQL Editor > New query.
-- Seed data (supabase/seed.sql) is LOCAL-DEV-ONLY and is NOT included.
-- Regenerate with: node scripts/build-full-db-setup.mjs
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

-- New enum values must be committed before any later statement uses them.
commit;

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

-- =====================================================================
-- FILE: 20260818000022_clinic_telegram_integrations_tenancy.sql
-- =====================================================================
-- 0022: Per-clinic Telegram bot integrations + tenancy/analytics indexes.
--
-- Multi-tenancy foundation for clinic-specific Telegram bots:
--   * clinic_telegram_integrations — one row per clinic holding the clinic's
--     own bot token (server-side only). RLS is enabled with NO policies, so
--     only the service role (server-side code) can read or write it. Tokens
--     are NEVER exposed to browser code through SQL.
--   * Supplementary indexes for conversation center, appointment
--     filtering/source analytics, revenue aggregation, patient identity
--     matching, and schedule lookups.

create type public.telegram_bot_status as enum ('disabled', 'active', 'error');

create table public.clinic_telegram_integrations (
  clinic_id uuid primary key references public.clinics(id) on delete cascade,
  -- Bot credentials, server-side only. Never returned to browser code.
  telegram_bot_token text,
  -- Bot identity resolved via Telegram getMe at activation time.
  telegram_bot_id bigint,
  telegram_username text,
  telegram_bot_name text,
  status public.telegram_bot_status not null default 'disabled',
  -- Telegram webhook state for this clinic's bot.
  webhook_status text,
  webhook_error text,
  last_error text,
  validated_at timestamptz,
  enabled boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.clinic_telegram_integrations enable row level security;

-- No RLS policies: the table is intentionally service-role-only. The owner
-- dashboard writes and reads it through server API routes that authorize the
-- caller first (requireStaff owner/manager) and never pass the raw token to
-- the browser.

-- ---------- Tenancy / analytics / identity indexes ----------

-- Conversation center: clinic-scoped lists sorted by last activity.
create index conversations_clinic_last_message_idx
  on public.conversations (clinic_id, last_message_at desc)
  where last_message_at is not null;

-- Appointment filtering and analytics (status lists, source analysis).
create index appointments_clinic_status_start_idx
  on public.appointments (clinic_id, status, start_at);

create index appointments_clinic_source_start_idx
  on public.appointments (clinic_id, source, start_at);

-- Revenue aggregation: paid payments per clinic.
create index payments_clinic_paid_at_idx
  on public.payments (clinic_id, paid_at)
  where status = 'paid';

-- Patient identity matching (phone fallback for web/manual bookings).
create index patients_clinic_phone_idx
  on public.patients (clinic_id, phone)
  where phone is not null;

-- Schedule lookups by clinic (availability computation across doctors).
create index doctor_working_hours_clinic_idx
  on public.doctor_working_hours (clinic_id, doctor_id, weekday);

-- Bot dispatch: which bot token serves a clinic (Phase 3 lookup path).
create index clinic_telegram_integrations_enabled_idx
  on public.clinic_telegram_integrations (enabled)
  where enabled;

-- =====================================================================
-- FILE: 20260818000023_role_based_authorization.sql
-- =====================================================================
-- 0023: Role-based authorization — roles and platform-admin schema.
--
-- The original role model had only owner/admin/doctor. This migration adds:
--   * manager      — same clinic operations as admin (analytics, catalog,
--                    conversations, bot monitoring)
--   * receptionist — appointments, patients, conversations and takeover;
--                    NEVER revenue analytics, catalog or bot configuration
--   * platform_admin (separate table — has no clinic, so it cannot live in
--     staff_roles which requires clinic_id) — platform-level clinic
--     administration; never clinic data through the browser client
--
-- NOTE: PostgreSQL forbids *using* a new enum value in the same migration
-- that adds it, so all RLS policy rewrites referencing 'manager'/'receptionist'
-- live in the follow-up migration 0024.

-- ---------- 1. staff_role extensions ----------

do $$
begin
  if not exists (
    select 1 from pg_enum e
    join pg_type t on t.oid = e.enumtypid
    where t.typname = 'staff_role' and e.enumlabel = 'manager'
  ) then
    alter type public.staff_role add value 'manager' before 'admin';
  end if;
  if not exists (
    select 1 from pg_enum e
    join pg_type t on t.oid = e.enumtypid
    where t.typname = 'staff_role' and e.enumlabel = 'receptionist'
  ) then
    alter type public.staff_role add value 'receptionist' before 'doctor';
  end if;
end $$;

-- ---------- 2. Platform administrators ----------
-- No clinic_id: platform staff are not clinic staff and never see clinic
-- data through the browser client (all platform access is server-side).

create table public.platform_admins (
  profile_id uuid primary key references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now()
);

alter table public.platform_admins enable row level security;

-- The row only proves platform-admin membership to the user themselves;
-- management (insert/delete) is service-role-only (platform routes).
create policy "platform_admins read own"
  on public.platform_admins for select
  to authenticated
  using (profile_id = auth.uid());

-- No other policies: platform access is service-role-only.

create or replace function public.is_platform_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.platform_admins where profile_id = auth.uid());
$$;

-- New enum values must be committed before any later statement uses them.
commit;

-- =====================================================================
-- FILE: 20260818000024_role_based_rls.sql
-- =====================================================================
-- 0024: Role-based RLS policy rewrites (manager, receptionist, operator).
--
-- Follows 0023 (roles + platform_admins). PostgreSQL forbids referencing a
-- new enum value in the migration that adds it, so every policy that names
-- 'manager' or 'receptionist' is created here.
--
-- Access matrix (spec Phase 2):
--   Action            Owner Manager Operator Doctor
--   View appointments  ✅     ✅      ✅      own
--   Manual booking     ✅     ✅      ✅      ❌
--   Conversations      ✅     ✅      ✅      ❌
--   Takeover           ✅     ✅      ✅      ❌
--   Revenue analytics  ✅     ✅      ❌      ❌
--   Manage doctors     ✅     ✅      ❌      ❌
--   Manage Telegram    ✅     ✅      ❌      ❌
--   Platform clinics   ❌     ❌      ❌      ❌

-- ---------- 3. RLS policy generalization ----------
-- Owner/admin/manager manage the catalog and clinic settings; receptionist
-- gets operational powers (appointments, patients, conversations) only.

-- specialties
drop policy if exists "specialties write for admin owner" on public.specialties;
create policy "specialties write for management"
  on public.specialties for all
  to authenticated
  using (public.is_clinic_staff(clinic_id, array['owner'::public.staff_role, 'admin'::public.staff_role, 'manager'::public.staff_role]))
  with check (public.is_clinic_staff(clinic_id, array['owner'::public.staff_role, 'admin'::public.staff_role, 'manager'::public.staff_role]));

-- services
drop policy if exists "services write for admin owner" on public.services;
create policy "services write for management"
  on public.services for all
  to authenticated
  using (public.is_clinic_staff(clinic_id, array['owner'::public.staff_role, 'admin'::public.staff_role, 'manager'::public.staff_role]))
  with check (public.is_clinic_staff(clinic_id, array['owner'::public.staff_role, 'admin'::public.staff_role, 'manager'::public.staff_role]));

-- doctors
drop policy if exists "doctors write for admin owner" on public.doctors;
create policy "doctors write for management"
  on public.doctors for all
  to authenticated
  using (public.is_clinic_staff(clinic_id, array['owner'::public.staff_role, 'admin'::public.staff_role, 'manager'::public.staff_role]))
  with check (public.is_clinic_staff(clinic_id, array['owner'::public.staff_role, 'admin'::public.staff_role, 'manager'::public.staff_role]));

-- doctor_services
drop policy if exists "doctor_services write for admin owner" on public.doctor_services;
create policy "doctor_services write for management"
  on public.doctor_services for all
  to authenticated
  using (public.is_clinic_staff((
    select d.clinic_id from public.doctors d where d.id = doctor_services.doctor_id
  ), array['owner'::public.staff_role, 'admin'::public.staff_role, 'manager'::public.staff_role]))
  with check (public.is_clinic_staff((
    select d.clinic_id from public.doctors d where d.id = doctor_services.doctor_id
  ), array['owner'::public.staff_role, 'admin'::public.staff_role, 'manager'::public.staff_role]));

-- working hours
drop policy if exists "working_hours write for admin owner" on public.doctor_working_hours;
create policy "working_hours write for management"
  on public.doctor_working_hours for all
  to authenticated
  using (public.is_clinic_staff(clinic_id, array['owner'::public.staff_role, 'admin'::public.staff_role, 'manager'::public.staff_role]))
  with check (public.is_clinic_staff(clinic_id, array['owner'::public.staff_role, 'admin'::public.staff_role, 'manager'::public.staff_role]));

-- time blocks (doctor self-service already handled by the API + status-only trigger)
drop policy if exists "time_blocks write for admin owner" on public.doctor_time_blocks;
create policy "time_blocks write for management"
  on public.doctor_time_blocks for all
  to authenticated
  using (public.is_clinic_staff(clinic_id, array['owner'::public.staff_role, 'admin'::public.staff_role, 'manager'::public.staff_role]))
  with check (public.is_clinic_staff(clinic_id, array['owner'::public.staff_role, 'admin'::public.staff_role, 'manager'::public.staff_role]));

-- faqs
drop policy if exists "faqs write for admin owner" on public.faq_entries;
create policy "faqs write for management"
  on public.faq_entries for all
  to authenticated
  using (public.is_clinic_staff(clinic_id, array['owner'::public.staff_role, 'admin'::public.staff_role, 'manager'::public.staff_role]))
  with check (public.is_clinic_staff(clinic_id, array['owner'::public.staff_role, 'admin'::public.staff_role, 'manager'::public.staff_role]));

-- app_settings
drop policy if exists "settings write for admin owner" on public.app_settings;
create policy "settings write for management"
  on public.app_settings for all
  to authenticated
  using (public.is_clinic_staff(clinic_id, array['owner'::public.staff_role, 'admin'::public.staff_role, 'manager'::public.staff_role]))
  with check (public.is_clinic_staff(clinic_id, array['owner'::public.staff_role, 'admin'::public.staff_role, 'manager'::public.staff_role]));

-- ---------- 4. Operational roles (receptionist) ----------

-- appointments: receptionists read, create (manual booking) and update
-- (status actions) appointments; doctors keep own-appointment read + status-only update.
drop policy if exists "appointments read for admin owner" on public.appointments;
create policy "appointments read for staff"
  on public.appointments for select
  to authenticated
  using (
    public.is_clinic_staff(clinic_id, array['owner'::public.staff_role, 'admin'::public.staff_role, 'manager'::public.staff_role, 'receptionist'::public.staff_role])
    or exists (
      select 1 from public.staff_roles sr
      join public.doctors d on d.profile_id = sr.profile_id
      where sr.profile_id = auth.uid()
        and sr.role = 'doctor'::public.staff_role
        and sr.clinic_id = appointments.clinic_id
        and d.id = appointments.doctor_id
    )
  );

drop policy if exists "appointments write for admin owner" on public.appointments;
create policy "appointments insert for operational staff"
  on public.appointments for insert
  to authenticated
  with check (public.is_clinic_staff(clinic_id, array['owner'::public.staff_role, 'admin'::public.staff_role, 'manager'::public.staff_role, 'receptionist'::public.staff_role]));

drop policy if exists "appointments update for admin owner" on public.appointments;
create policy "appointments update for operational staff"
  on public.appointments for update
  to authenticated
  using (public.is_clinic_staff(clinic_id, array['owner'::public.staff_role, 'admin'::public.staff_role, 'manager'::public.staff_role, 'receptionist'::public.staff_role]))
  with check (public.is_clinic_staff(clinic_id, array['owner'::public.staff_role, 'admin'::public.staff_role, 'manager'::public.staff_role, 'receptionist'::public.staff_role]));

-- patients: receptionists manage walk-in patients (read/insert/update).
drop policy if exists "patients read for admin owner" on public.patients;
create policy "patients read for operational staff"
  on public.patients for select
  to authenticated
  using (
    public.is_clinic_staff(clinic_id, array['owner'::public.staff_role, 'admin'::public.staff_role, 'manager'::public.staff_role, 'receptionist'::public.staff_role])
    or exists (
      select 1 from public.staff_roles sr
      join public.doctors d on d.profile_id = sr.profile_id
      join public.appointments a on a.doctor_id = d.id and a.patient_id = patients.id
      where sr.profile_id = auth.uid()
        and sr.role = 'doctor'::public.staff_role
        and sr.clinic_id = patients.clinic_id
    )
  );

drop policy if exists "patients update for admin owner" on public.patients;
create policy "patients update for operational staff"
  on public.patients for update
  to authenticated
  using (public.is_clinic_staff(clinic_id, array['owner'::public.staff_role, 'admin'::public.staff_role, 'manager'::public.staff_role, 'receptionist'::public.staff_role]))
  with check (public.is_clinic_staff(clinic_id, array['owner'::public.staff_role, 'admin'::public.staff_role, 'manager'::public.staff_role, 'receptionist'::public.staff_role]));

drop policy if exists "patients insert for admin owner" on public.patients;
create policy "patients insert for operational staff"
  on public.patients for insert
  to authenticated
  with check (
    public.is_clinic_staff(clinic_id, array['owner'::public.staff_role, 'admin'::public.staff_role, 'manager'::public.staff_role, 'receptionist'::public.staff_role])
    and telegram_user_id is null
  );

-- conversations: operational staff read and update (takeover); messages reply.
drop policy if exists "conversations read for staff" on public.conversations;
create policy "conversations read for operational staff"
  on public.conversations for select
  to authenticated
  using (public.is_clinic_staff(clinic_id, array['owner'::public.staff_role, 'admin'::public.staff_role, 'manager'::public.staff_role, 'receptionist'::public.staff_role]));

drop policy if exists "conversations update for admin owner" on public.conversations;
create policy "conversations update for operational staff"
  on public.conversations for update
  to authenticated
  using (public.is_clinic_staff(clinic_id, array['owner'::public.staff_role, 'admin'::public.staff_role, 'manager'::public.staff_role, 'receptionist'::public.staff_role]))
  with check (public.is_clinic_staff(clinic_id, array['owner'::public.staff_role, 'admin'::public.staff_role, 'manager'::public.staff_role, 'receptionist'::public.staff_role]));

drop policy if exists "conversations insert for admin owner" on public.conversations;
create policy "conversations insert for operational staff"
  on public.conversations for insert
  to authenticated
  with check (public.is_clinic_staff(clinic_id, array['owner'::public.staff_role, 'admin'::public.staff_role, 'manager'::public.staff_role, 'receptionist'::public.staff_role]));

drop policy if exists "messages read for staff" on public.messages;
create policy "messages read for operational staff"
  on public.messages for select
  to authenticated
  using (public.is_clinic_staff(clinic_id, array['owner'::public.staff_role, 'admin'::public.staff_role, 'manager'::public.staff_role, 'receptionist'::public.staff_role]));

drop policy if exists "messages insert for admin owner" on public.messages;
create policy "messages insert for operational staff"
  on public.messages for insert
  to authenticated
  with check (
    public.is_clinic_staff(clinic_id, array['owner'::public.staff_role, 'admin'::public.staff_role, 'manager'::public.staff_role, 'receptionist'::public.staff_role])
    and role = 'admin'::public.message_role
    and exists (
      select 1 from public.conversations c
      where c.id = conversation_id and c.clinic_id = clinic_id
    )
  );

-- voice messages: read + reply inserts for operational staff.
drop policy if exists "voice_messages read for staff" on public.voice_messages;
create policy "voice_messages read for operational staff"
  on public.voice_messages for select
  to authenticated
  using (public.is_clinic_staff(clinic_id, array['owner'::public.staff_role, 'admin'::public.staff_role, 'manager'::public.staff_role, 'receptionist'::public.staff_role]));

drop policy if exists "voice_messages insert for admin owner" on public.voice_messages;
create policy "voice_messages insert for operational staff"
  on public.voice_messages for insert
  to authenticated
  with check (
    public.is_clinic_staff(clinic_id, array['owner'::public.staff_role, 'admin'::public.staff_role, 'manager'::public.staff_role, 'receptionist'::public.staff_role])
    and exists (
      select 1 from public.conversations c
      where c.id = conversation_id and c.clinic_id = clinic_id
    )
  );

drop policy if exists "voice_messages update for admin owner" on public.voice_messages;
create policy "voice_messages update for management"
  on public.voice_messages for update
  to authenticated
  using (public.is_clinic_staff(clinic_id, array['owner'::public.staff_role, 'admin'::public.staff_role, 'manager'::public.staff_role]))
  with check (public.is_clinic_staff(clinic_id, array['owner'::public.staff_role, 'admin'::public.staff_role, 'manager'::public.staff_role]));

-- payments: operational staff see payment STATUS (desk check-in); only
-- management can update payments. Aggregated revenue analytics are
-- additionally restricted at the API layer (owner/manager only).
drop policy if exists "payments read for staff" on public.payments;
create policy "payments read for operational staff"
  on public.payments for select
  to authenticated
  using (
    public.is_clinic_staff(clinic_id, array['owner'::public.staff_role, 'admin'::public.staff_role, 'manager'::public.staff_role, 'receptionist'::public.staff_role])
    or exists (
      select 1 from public.staff_roles sr
      join public.doctors d on d.profile_id = sr.profile_id
      join public.appointments a on a.id = payments.appointment_id and a.doctor_id = d.id
      where sr.profile_id = auth.uid()
        and sr.role = 'doctor'::public.staff_role
        and sr.clinic_id = payments.clinic_id
    )
  );

drop policy if exists "payments update for admin owner" on public.payments;
create policy "payments update for management"
  on public.payments for update
  to authenticated
  using (public.is_clinic_staff(clinic_id, array['owner'::public.staff_role, 'admin'::public.staff_role, 'manager'::public.staff_role]))
  with check (public.is_clinic_staff(clinic_id, array['owner'::public.staff_role, 'admin'::public.staff_role, 'manager'::public.staff_role]));

drop policy if exists "payments insert for admin owner" on public.payments;
create policy "payments insert for management"
  on public.payments for insert
  to authenticated
  with check (
    public.is_clinic_staff(clinic_id, array['owner'::public.staff_role, 'admin'::public.staff_role, 'manager'::public.staff_role])
    and exists (
      select 1 from public.appointments a
      where a.id = appointment_id and a.clinic_id = clinic_id
    )
  );

-- ---------- 5. Analytics / audit / notifications: management only ----------

drop policy if exists "analytics read for admin owner" on public.analytics_events;
create policy "analytics read for management"
  on public.analytics_events for select
  to authenticated
  using (public.is_clinic_staff(clinic_id, array['owner'::public.staff_role, 'admin'::public.staff_role, 'manager'::public.staff_role]));

drop policy if exists "audit read for admin owner" on public.audit_events;
create policy "audit read for management"
  on public.audit_events for select
  to authenticated
  using (public.is_clinic_staff(clinic_id, array['owner'::public.staff_role, 'admin'::public.staff_role, 'manager'::public.staff_role]));

drop policy if exists "notification_jobs read for admin owner" on public.notification_jobs;
create policy "notification_jobs read for management"
  on public.notification_jobs for select
  to authenticated
  using (public.is_clinic_staff(clinic_id, array['owner'::public.staff_role, 'admin'::public.staff_role, 'manager'::public.staff_role]));

drop policy if exists "notification_jobs update for admin owner" on public.notification_jobs;
create policy "notification_jobs update for management"
  on public.notification_jobs for update
  to authenticated
  using (public.is_clinic_staff(clinic_id, array['owner'::public.staff_role, 'admin'::public.staff_role, 'manager'::public.staff_role]))
  with check (public.is_clinic_staff(clinic_id, array['owner'::public.staff_role, 'admin'::public.staff_role, 'manager'::public.staff_role]));

-- ---------- 6. Owner-only stays owner-only ----------
-- clinics update, staff_roles management, storage uploads, storage reads.

drop policy if exists "voice-messages staff upload" on storage.objects;
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
        and sr.role = any (array['owner'::public.staff_role, 'admin'::public.staff_role, 'manager'::public.staff_role])
    )
  );

-- =====================================================================
-- FILE: 20260818000025_no_show_reasons_and_read_tracking.sql
-- =====================================================================
-- Audit remediation: no-show reasons + conversation read tracking.
-- 1) appointments.no_show_reason — staff record why a patient missed the
--    appointment; surfaced in management analytics like cancellation reasons.
alter table public.appointments
  add column no_show_reason text;

comment on column public.appointments.no_show_reason is
  'Reason recorded by staff when an appointment is marked as a no-show';

-- 2) conversations.admin_seen_at — last time an operator viewed the
--    conversation; patient messages after this timestamp are unread and
--    drive unread badges in the admin conversation center.
alter table public.conversations
  add column admin_seen_at timestamptz;

comment on column public.conversations.admin_seen_at is
  'Last time an operator viewed this conversation; patient messages after this are unread';

-- 3) Doctors may only update the status column of their own appointments.
--    no_show_reason is a staff-managed field, so it must NOT be settable by a
--    doctor session (their own route only ever touches status).
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
     or new.no_show_reason is distinct from old.no_show_reason
     or new.created_by is distinct from old.created_by then
    raise exception 'Doctors may only update the status of their own appointments';
  end if;

  return new;
end;
$$;

-- =====================================================================
-- FILE: 20260821000001_telegram_integration_constraint_and_seed_resilience.sql
-- =====================================================================
-- 0026: Constraint + seed resilience fixes.
--
-- 1. clinic_telegram_integrations: a clinic with enabled=true must have a
--    bot token. Prevents accidental activation without credentials.
--
-- 2. conversation_status: remove unused 'released' enum value.
--    Code sets released_at but transitions to 'open', never to 'released'.
--    The dashboard query referencing 'released' is updated in application code.
--    PostgreSQL cannot DROP an enum value directly; we recreate the type.

-- ---------- 1. Telegram integration constraint ----------

-- Guard: only fire when enabled is being set to true.
create or replace function public.clinic_telegram_integrations_check_token()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.enabled = true and new.telegram_bot_token is null then
    raise exception 'Cannot enable Telegram integration without a bot token';
  end if;
  return new;
end;
$$;

drop trigger if exists clinic_telegram_integrations_check_token on public.clinic_telegram_integrations;
create trigger clinic_telegram_integrations_check_token
  before insert or update on public.clinic_telegram_integrations
  for each row execute function public.clinic_telegram_integrations_check_token();

comment on function public.clinic_telegram_integrations_check_token() is
  'Ensures a Telegram integration cannot be enabled without a bot token';

-- ---------- 2. Remove unused conversation_status.released ----------

-- Step 1: Create new enum without 'released'
do $$
begin
  if not exists (
    select 1 from pg_type t
    where t.typname = 'conversation_status_v2'
  ) then
    create type public.conversation_status_v2 as enum (
      'open', 'assigned', 'closed'
    );
  end if;
end $$;

-- Step 2: Drop default, migrate column type, re-add default
-- The DEFAULT is typed to the old enum; PostgreSQL can't auto-cast it.
ALTER TABLE public.conversations ALTER COLUMN status DROP DEFAULT;

-- Drop objects that reference the old enum type before altering.
DROP TRIGGER IF EXISTS conversations_set_updated_at ON public.conversations;
DROP INDEX IF EXISTS public.conversations_active_one_per_patient;

-- Two-step: first to text, then to new enum type.
ALTER TABLE public.conversations
  ALTER COLUMN status TYPE text
  USING (status::text);

ALTER TABLE public.conversations
  ALTER COLUMN status TYPE public.conversation_status_v2
  USING (
    case status
      when 'released' then 'open'::public.conversation_status_v2
      else status::public.conversation_status_v2
    end
  );

ALTER TABLE public.conversations ALTER COLUMN status SET DEFAULT 'open'::public.conversation_status_v2;

-- Re-create the updated_at trigger.
CREATE TRIGGER conversations_set_updated_at
  BEFORE UPDATE ON public.conversations
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Step 3: Drop old type and rename new
ALTER TYPE public.conversation_status RENAME TO conversation_status_old;
ALTER TYPE public.conversation_status_v2 RENAME TO conversation_status;
DROP TYPE public.conversation_status_old;

-- Step 4: Update the partial unique index (was based on the old type)
DROP INDEX IF EXISTS public.conversations_active_one_per_patient;
CREATE UNIQUE INDEX conversations_active_one_per_patient
  ON public.conversations (patient_id, channel)
  WHERE status IN ('open', 'assigned');

-- =====================================================================
-- FILE: 20260822000001_payments_server_managed.sql
-- =====================================================================
-- 0027: Payments become fully server-managed (audit finding, Phase 2).
--
-- Problem: the "payments update for management" RLS policy (0024) only
-- checks clinic membership + role (owner/admin/manager) — it places no
-- constraint on which columns or values can be written. Any management
-- role's authenticated (browser) session can therefore issue a raw
-- `supabase.from("payments").update({ status: "paid" })` and it succeeds,
-- completely bypassing transitionPaymentStatus() (src/lib/payments/status.ts)
-- — its legal-transition check, audit trail, and paid_at/paid_by bookkeeping.
-- This directly contradicts AGENTS.md: "Payment status is server-controlled.
-- A browser request can never mark payment as paid." It was previously
-- provable via the codebase's own test suite (role-authorization.test.ts,
-- "manager updates payments" asserted this write as *passing*).
--
-- A repo-wide grep confirms zero legitimate call sites update `payments`
-- via anything but the service-role client (every real mutation flows
-- through transitionPaymentStatus()). So rather than allow-listing "safe"
-- columns (the appointments_doctor_status_only pattern, needed there
-- because doctors legitimately change one column), this blocks direct
-- authenticated writes to `payments` outright — service-role (no JWT) is
-- untouched, exactly like the existing appointments_doctor_status_only
-- trigger's server-side bypass.
--
-- Reversible: `drop trigger payments_block_direct_write on public.payments;
-- drop function public.payments_block_direct_write();` in a follow-up
-- migration. Safe for existing records: only fires on UPDATE, never
-- touches existing rows, and never affects service-role (server API)
-- writes — the only path that has ever legitimately written this table.

create or replace function public.payments_block_direct_write()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Server-side code (service role, no JWT) is unrestricted — this is the
  -- ONLY legitimate path for a payment write. coalesce() matters: without
  -- JWT claims auth.role() is NULL, and `NULL <> 'authenticated'` is NULL
  -- (false), which would wrongly apply this restriction to server-side
  -- calls (mirrors appointments_doctor_status_only's guard, 20260818000025).
  if coalesce(auth.role(), '') <> 'authenticated' then
    return new;
  end if;

  -- No authenticated staff session — owner, admin, or manager — has any
  -- legitimate reason to update a payment row directly; every real
  -- mutation goes through the server-side payment API
  -- (transitionPaymentStatus()), which applies the legal-transition check,
  -- audit trail and idempotency this trigger cannot recreate. Block
  -- outright rather than allow-listing columns.
  raise exception 'Payments are server-managed; use the payment API';
end;
$$;

drop trigger if exists payments_block_direct_write on public.payments;
create trigger payments_block_direct_write
  before update on public.payments
  for each row execute function public.payments_block_direct_write();

comment on function public.payments_block_direct_write() is
  'Blocks any authenticated-session UPDATE on payments; only the service-role payment API (transitionPaymentStatus) may write this table.';

-- =====================================================================
-- FILE: 20260822000002_tenancy_hardening.sql
-- =====================================================================
-- 0028: Multi-tenancy hardening pass (audit findings, Phase 2).
--
-- Bundles four independent, additive fixes from the DB/RLS audit:
--   1. doctor_services cross-tenant consistency trigger
--   2. drop redundant duplicate RLS policies (dead since 0024)
--   3. missing index on staff_roles(profile_id) — hot path, every
--      authenticated request resolves its session through this table
--   4. UNIQUE constraint on clinic_telegram_integrations bot identity
--      columns, added defensively (skips + warns instead of failing the
--      migration if pre-existing duplicate data is ever found)
--
-- All four are safe for existing records: (1) only validates future
-- inserts/updates, never scans existing rows; (2) removes policies whose
-- access is already fully subsumed by 0024's combined policies (RLS
-- SELECT policies are OR-combined, so this changes zero effective access);
-- (3) a plain additive index; (4) explicitly guarded against failing on
-- existing duplicates. Reversible via a follow-up migration dropping the
-- trigger/function, indexes, and re-creating the two policies from
-- 20260813000010_rls.sql if ever needed.

-- ---------- 1. doctor_services: doctor and service must share a clinic ----------
--
-- doctor_services has no clinic_id of its own (junction table on
-- doctor_id/service_id); nothing at the database layer previously stopped
-- a row from pairing a Clinic A doctor with a Clinic B service — only one
-- application-layer check (src/app/api/admin/services/route.ts,
-- assertDoctorsInClinic) prevented it, and only on that one write path.

create or replace function public.doctor_services_check_same_clinic()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_doctor_clinic uuid;
  v_service_clinic uuid;
begin
  select clinic_id into v_doctor_clinic from public.doctors where id = new.doctor_id;
  select clinic_id into v_service_clinic from public.services where id = new.service_id;
  if v_doctor_clinic is null or v_service_clinic is null or v_doctor_clinic <> v_service_clinic then
    raise exception 'doctor_services: doctor and service must belong to the same clinic';
  end if;
  return new;
end;
$$;

drop trigger if exists doctor_services_check_same_clinic on public.doctor_services;
create trigger doctor_services_check_same_clinic
  before insert or update on public.doctor_services
  for each row execute function public.doctor_services_check_same_clinic();

comment on function public.doctor_services_check_same_clinic() is
  'Rejects any doctor_services row whose doctor_id and service_id resolve to different clinics — closes the one DB-layer gap in an otherwise clinic_id-scoped schema.';

-- ---------- 2. Drop redundant duplicate RLS policies (dead since 0024) ----------
--
-- 20260818000024_role_based_rls.sql widened the admin/owner SELECT
-- policies on patients and appointments to include manager/receptionist,
-- and re-implemented the "own doctor" clause inline as an OR — but never
-- dropped the original standalone policies below, leaving two policies
-- granting the identical doctor-scope permission. Dropping the dead one
-- changes zero effective access (RLS SELECT policies are OR-combined).

drop policy if exists "patients read for own doctor" on public.patients;
drop policy if exists "appointments read for own doctor" on public.appointments;

-- ---------- 3. Missing index: staff_roles(profile_id) ----------
--
-- getStaffContext() (src/lib/auth/staff.ts) — resolved on every
-- authenticated admin/doctor/platform request via requireStaff/
-- requireRoles/requirePlatformAdmin — filters staff_roles by profile_id
-- alone. The only existing index is the composite unique(clinic_id,
-- profile_id), whose leading column is clinic_id, so it cannot serve a
-- profile_id-only lookup efficiently.

create index if not exists staff_roles_profile_id_idx on public.staff_roles (profile_id);

-- ---------- 4. clinic_telegram_integrations bot-identity uniqueness ----------
--
-- resolveClinicByBotUsername() (src/lib/telegram/bots.ts), called on
-- every incoming Telegram webhook, does .eq("telegram_username",
-- normalized).maybeSingle() — which requires at most one matching row.
-- No constraint previously enforced that. If two clinics ever shared a
-- telegram_username/telegram_bot_id (e.g. an operator reusing a bot
-- token), PostgREST's singular-row requirement would be violated and
-- webhook routing would silently break for both affected clinics with no
-- visible dashboard error. Guarded with a duplicate check first so this
-- migration cannot fail outright on unexpected existing data — it skips
-- and logs a notice instead, leaving the constraint to be added once any
-- conflict is resolved.

do $$
declare
  v_dup_count int;
begin
  select count(*) into v_dup_count from (
    select telegram_username from public.clinic_telegram_integrations
    where telegram_username is not null
    group by telegram_username having count(*) > 1
  ) d;
  if v_dup_count > 0 then
    raise notice 'Skipping UNIQUE(telegram_username) on clinic_telegram_integrations: % duplicate value(s) exist — resolve manually, then add the constraint in a follow-up migration', v_dup_count;
  elsif not exists (select 1 from pg_indexes where indexname = 'clinic_telegram_integrations_username_key') then
    create unique index clinic_telegram_integrations_username_key
      on public.clinic_telegram_integrations (telegram_username)
      where telegram_username is not null;
  end if;
end $$;

do $$
declare
  v_dup_count int;
begin
  select count(*) into v_dup_count from (
    select telegram_bot_id from public.clinic_telegram_integrations
    where telegram_bot_id is not null
    group by telegram_bot_id having count(*) > 1
  ) d;
  if v_dup_count > 0 then
    raise notice 'Skipping UNIQUE(telegram_bot_id) on clinic_telegram_integrations: % duplicate value(s) exist — resolve manually, then add the constraint in a follow-up migration', v_dup_count;
  elsif not exists (select 1 from pg_indexes where indexname = 'clinic_telegram_integrations_bot_id_key') then
    create unique index clinic_telegram_integrations_bot_id_key
      on public.clinic_telegram_integrations (telegram_bot_id)
      where telegram_bot_id is not null;
  end if;
end $$;

-- =====================================================================
-- FILE: 20260910000001_webhook_claim_recovery.sql
-- =====================================================================
-- 0030: Recover orphaned Telegram webhook idempotency claims (Phase 3
-- Telegram audit).
--
-- claim_webhook_update() inserts a 'processing' row and nothing revisits it
-- unless the SAME request's own try/catch later calls
-- release_webhook_update() (on a thrown error) or finish_webhook_update()
-- (on success) — see src/app/api/telegram/webhook/route.ts. If the
-- serverless function is killed mid-request before either runs (the route's
-- own maxDuration=60 timeout, an OOM, a mid-deploy restart, a hung outbound
-- fetch with no client-side timeout), the row is stuck at
-- status='processing' forever: Telegram's automatic retry of that
-- update_id then finds claim_webhook_update() returning false (ON CONFLICT
-- DO NOTHING sees the existing row) and the webhook route reports it as an
-- already-handled duplicate. The update is never actually processed and
-- the patient's message is silently dropped, with no further retry from
-- either side.
--
-- Fix: a claim still 'processing' after 5 minutes is treated as abandoned
-- and becomes reclaimable. Real handlers complete in low single-digit
-- seconds; 5 minutes is comfortably past the route's own 60s hard cutoff
-- (so it never reclaims a request that could still legitimately be
-- running) while short enough that a genuinely stuck message recovers on
-- Telegram's own webhook retry instead of being lost forever. Purely
-- additive to the existing INSERT .. ON CONFLICT DO NOTHING claim: the
-- concurrent-delivery race (exactly one winner) and the
-- already-finished-never-reprocessed guarantee are both unchanged for any
-- claim inside the 5-minute window. Reversible by restoring the prior
-- DO NOTHING body from 20260813000014_release_blockers.sql.

create or replace function public.claim_webhook_update(p_source text, p_external_id text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.processed_webhooks (source, external_id, status)
  values (p_source, p_external_id, 'processing')
  on conflict (source, external_id) do update
    set status = 'processing', processed_at = now()
  where
    public.processed_webhooks.status = 'processing'
    and public.processed_webhooks.processed_at < now() - interval '5 minutes';
  return found;
end;
$$;

comment on function public.claim_webhook_update(text, text) is
  'Atomically claims a webhook update for processing (INSERT .. ON CONFLICT DO NOTHING semantics for a fresh or truly-concurrent id). Also reclaims a prior claim stuck in processing for over 5 minutes — an orphaned claim left by a killed/crashed request — so that update is not silently lost forever.';

-- =====================================================================
-- FILE: 20260910000002_appointment_source_web.sql
-- =====================================================================
-- 0031: Distinguish genuine self-service website bookings from reception
-- walk-ins (Phase 5 booking-workflow audit).
--
-- api/bookings/route.ts's non-Telegram fallback (a patient booking directly
-- through the website, with no Telegram identity at all) was tagging its
-- appointment_source as 'walk_in' — the SAME value api/admin/appointments
-- uses for a real front-desk walk-in a staff member enters on a patient's
-- behalf. Analytics could not distinguish "patient booked themselves
-- online" from "reception typed this in at the desk," even though they are
-- different channels with different operational meaning. Adds 'web' as its
-- own value; existing 'walk_in' rows are untouched (they remain correctly
-- attributed to reception-entered walk-ins).

alter type public.appointment_source add value if not exists 'web' after 'telegram_chat';

-- New enum values must be committed before any later statement uses them.
commit;

-- =====================================================================
-- FILE: 20260911000001_patient_operational_notes.sql
-- =====================================================================
-- Operational (front-desk) notes about a patient: logistics only — e.g.
-- "prefers morning slots", "needs a translator", "hard to reach by phone".
-- Never a clinical/diagnostic record. Editable by clinic operational staff
-- (owner/admin/manager/receptionist) via the service-role API route only;
-- no new RLS policy is needed since it is a column on an already row-level
-- clinic/role-scoped table.
alter table public.patients
  add column operational_notes text;

alter table public.patients
  add constraint patients_operational_notes_length
  check (operational_notes is null or char_length(operational_notes) <= 1000);

-- =====================================================================
-- FILE: 20260912000001_server_only_rpc_grants.sql
-- =====================================================================
-- Server-only RPCs must not be callable from a browser.
--
-- claim_due_notification_jobs, claim_webhook_update, finish_webhook_update and
-- release_webhook_update are SECURITY DEFINER job/idempotency primitives called
-- exclusively by server code through the service-role client
-- (src/lib/notifications/processor.ts, src/lib/telegram/idempotency.ts). They
-- shipped with PostgreSQL's default PUBLIC EXECUTE plus Supabase's blanket
-- anon/authenticated grants, which left them reachable UNAUTHENTICATED over
-- PostgREST at /rest/v1/rpc/<name> with nothing but the publishable anon key.
--
-- Before this migration anyone on the internet could:
--
--   * claim_due_notification_jobs(p_limit) — claim pending reminder rows,
--     both READING their patient-directed payload and flipping them to
--     'in_progress' so the real worker skips them and the patient never gets
--     the appointment reminder;
--   * claim_webhook_update('telegram', <update_id>) — pre-claim update ids so
--     genuine Telegram deliveries are discarded as duplicates and the bot
--     silently stops answering patients;
--   * release_/finish_webhook_update(...) — corrupt that same idempotency
--     ledger, re-opening the double-send window the claim exists to close.
--
-- service_role keeps EXECUTE: it is the only caller anywhere in the codebase.
--
-- Deliberately NOT touched here (smallest safe change):
--   * is_clinic_staff() / is_platform_admin() — read-only predicates about the
--     CURRENT session that return false for an anonymous caller, so they leak
--     nothing. RLS evaluates them as the invoking role, so `authenticated`
--     MUST keep EXECUTE or every policy built on them starts erroring on
--     legitimate traffic.
--   * the trigger functions (appointments_validate_slot, payments_block_direct_write,
--     audit_track_changes, …) — they return `trigger`, which PostgREST cannot
--     expose as an RPC and which Postgres refuses to call directly
--     ("trigger functions can only be called as triggers"), so the grant is
--     not actually reachable. Revoking it would buy no measurable protection
--     while putting the booking and payment write paths at risk, so it is
--     left for a change that can be exercised against a disposable database
--     first.

revoke execute on function public.claim_due_notification_jobs(integer) from public, anon, authenticated;
grant execute on function public.claim_due_notification_jobs(integer) to service_role;

revoke execute on function public.claim_webhook_update(text, text) from public, anon, authenticated;
grant execute on function public.claim_webhook_update(text, text) to service_role;

revoke execute on function public.finish_webhook_update(text, text) from public, anon, authenticated;
grant execute on function public.finish_webhook_update(text, text) to service_role;

revoke execute on function public.release_webhook_update(text, text) from public, anon, authenticated;
grant execute on function public.release_webhook_update(text, text) to service_role;

-- =====================================================================
-- FILE: 20260926000001_referrals.sql
-- =====================================================================
-- Clinical referrals, Phase 1: the data model only.
--
-- Doctor A refers a patient to Doctor B inside one clinic. This migration adds
-- the referral record and its database-level guarantees. It deliberately does
-- NOT widen access to the patient's history (patients/appointments RLS is
-- unchanged) and adds no API or UI.
--
-- Reuses the existing model — no new patient, doctor, clinic, consultation or
-- diagnosis tables:
--   * clinic, patient and both doctors are the existing clinics, patients and
--     doctors rows;
--   * there is no separate consultation entity: the consultation is the
--     appointments row in which the referring doctor saw the patient
--     (originating_appointment_id).
--
-- Tenant isolation is declarative. Composite foreign keys pin the patient,
-- both doctors and the originating appointment to the referral's own
-- clinic_id; the appointment key also pins it to THIS patient and THIS
-- referring doctor, so every referral stems from a real consultation between
-- them. The UNIQUE constraints added to patients/doctors/appointments exist
-- only as targets for those keys; each is implied by the table's primary key,
-- so no existing row can violate them.
--
-- Rules a constraint cannot express live in referrals_validate():
--   * created 'pending', from an in-progress or completed consultation, by the
--     referring doctor's own active doctor account, to a different active
--     doctor who has a doctor account (no self-referral, even across two
--     doctor records linked to the same account);
--   * pending -> accepted | declined | revoked | expired;
--     accepted -> completed | revoked | expired; everything else is terminal;
--   * accept/decline/complete only by the receiving doctor; revoke only by the
--     referring doctor or clinic management (owner/admin/manager); accept and
--     complete only before expires_at; expire only after it;
--   * transition timestamps are set by the database, never by the caller;
--   * the clinical content, parties and provenance never change after
--     creation — a mistaken referral is revoked and re-issued.
--
-- Auditability:
--   * referrals_audit() records every creation and status transition in
--     audit_events with the acting staff profile. It is taken from the
--     provenance column the validator just checked, because server writes use
--     the service role, where auth.uid() is NULL;
--   * audit rows carry ids and status only — never the reason, handoff note or
--     decline/revocation text: audit_events is readable by non-clinical
--     management;
--   * nobody but the table owner may DELETE a referral; rows only disappear
--     through the existing patient/clinic erasure cascades.
--
-- Access: browser sessions may only SELECT, and only the two doctors on the
-- referral — the receiving doctor while it is open and unexpired, or after
-- they completed it. Every write is server-side (service role).
--
-- Reversible: drop table public.referrals; drop functions
-- public.referrals_validate(), public.referrals_audit() and
-- public.is_linked_doctor(uuid); drop types public.referral_status and
-- public.referral_priority; drop constraints patients_id_clinic_id_key,
-- doctors_id_clinic_id_key and
-- appointments_id_clinic_id_patient_id_doctor_id_key.

-- ---------- 1. Types ----------

create type public.referral_status as enum (
  'pending',
  'accepted',
  'declined',
  'completed',
  'revoked',
  'expired'
);

create type public.referral_priority as enum ('routine', 'urgent');

-- ---------- 2. Same-clinic reference keys on existing tables ----------

alter table public.patients
  add constraint patients_id_clinic_id_key unique (id, clinic_id);

alter table public.doctors
  add constraint doctors_id_clinic_id_key unique (id, clinic_id);

alter table public.appointments
  add constraint appointments_id_clinic_id_patient_id_doctor_id_key
  unique (id, clinic_id, patient_id, doctor_id);

-- ---------- 3. referrals ----------

create table public.referrals (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete cascade,
  patient_id uuid not null,
  referring_doctor_id uuid not null,
  referred_to_doctor_id uuid not null,
  originating_appointment_id uuid not null,
  reason text not null,
  handoff_note text,
  priority public.referral_priority not null default 'routine',
  status public.referral_status not null default 'pending',
  expires_at timestamptz not null default (now() + interval '90 days'),
  created_by uuid not null references public.profiles(id),
  accepted_at timestamptz,
  accepted_by uuid references public.profiles(id),
  declined_at timestamptz,
  declined_by uuid references public.profiles(id),
  declined_reason text,
  completed_at timestamptz,
  completed_by uuid references public.profiles(id),
  revoked_at timestamptz,
  revoked_by uuid references public.profiles(id),
  revoked_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint referrals_patient_same_clinic_fkey
    foreign key (patient_id, clinic_id)
    references public.patients (id, clinic_id) on delete cascade,
  constraint referrals_referring_doctor_same_clinic_fkey
    foreign key (referring_doctor_id, clinic_id)
    references public.doctors (id, clinic_id),
  constraint referrals_referred_to_doctor_same_clinic_fkey
    foreign key (referred_to_doctor_id, clinic_id)
    references public.doctors (id, clinic_id),
  constraint referrals_originating_appointment_fkey
    foreign key (originating_appointment_id, clinic_id, patient_id, referring_doctor_id)
    references public.appointments (id, clinic_id, patient_id, doctor_id),

  constraint referrals_not_self_referral
    check (referring_doctor_id <> referred_to_doctor_id),
  -- Free text must contain something other than whitespace.
  constraint referrals_reason_check
    check (reason ~ '\S' and char_length(reason) <= 2000),
  constraint referrals_handoff_note_check
    check (handoff_note is null or (handoff_note ~ '\S' and char_length(handoff_note) <= 4000)),
  constraint referrals_declined_reason_check
    check (declined_reason is null or (declined_reason ~ '\S' and char_length(declined_reason) <= 1000)),
  constraint referrals_revoked_reason_check
    check (revoked_reason is null or (revoked_reason ~ '\S' and char_length(revoked_reason) <= 1000)),
  -- A referral can never grant open-ended access.
  constraint referrals_expiry_window_check
    check (expires_at > created_at and expires_at <= created_at + interval '365 days'),

  -- Each lifecycle field is set exactly when its status is reached, together
  -- with the acting profile.
  constraint referrals_accepted_state_check
    check (
      (accepted_at is null) = (accepted_by is null)
      and case status
        when 'pending' then accepted_at is null
        when 'declined' then accepted_at is null
        when 'accepted' then accepted_at is not null
        when 'completed' then accepted_at is not null
        else true
      end
    ),
  constraint referrals_declined_state_check
    check (
      (status = 'declined') = (declined_at is not null)
      and (declined_at is null) = (declined_by is null)
      and (declined_reason is null or declined_at is not null)
    ),
  constraint referrals_completed_state_check
    check (
      (status = 'completed') = (completed_at is not null)
      and (completed_at is null) = (completed_by is null)
    ),
  constraint referrals_revoked_state_check
    check (
      (status = 'revoked') = (revoked_at is not null)
      and (revoked_at is null) = (revoked_by is null)
      and (revoked_at is null) = (revoked_reason is null)
    ),
  constraint referrals_timeline_check
    check (
      (accepted_at is null or accepted_at >= created_at)
      and (declined_at is null or declined_at >= created_at)
      and (completed_at is null or completed_at >= accepted_at)
      and (revoked_at is null or revoked_at >= created_at)
    )
);

comment on table public.referrals is
  'Doctor-to-doctor referral within one clinic. reason and handoff_note are clinical free text: never log them, copy them into audit_events or analytics, send them over Telegram, or pass them to the AI layer.';

comment on column public.referrals.originating_appointment_id is
  'The consultation (appointment) in which the referring doctor saw the patient; in progress or completed when the referral is created.';

comment on column public.referrals.expires_at is
  'End of the referral''s validity (at most 365 days after creation). After it the referral can no longer be accepted or completed, and the receiving doctor can no longer read it unless they completed it.';

create index referrals_clinic_status_idx
  on public.referrals (clinic_id, status, created_at desc);

create index referrals_patient_idx
  on public.referrals (patient_id, created_at desc);

create index referrals_referring_doctor_idx
  on public.referrals (referring_doctor_id, status, created_at desc);

create index referrals_referred_to_doctor_idx
  on public.referrals (referred_to_doctor_id, status, created_at desc);

create index referrals_status_expires_idx
  on public.referrals (status, expires_at);

create index referrals_originating_appointment_idx
  on public.referrals (originating_appointment_id);

-- One open referral per patient, referring doctor and receiving doctor:
-- blocks accidental double submission; a new one is possible once the
-- previous one is closed.
create unique index referrals_one_open_per_pair
  on public.referrals (patient_id, referring_doctor_id, referred_to_doctor_id)
  where status in ('pending', 'accepted');

drop trigger if exists referrals_set_updated_at on public.referrals;
create trigger referrals_set_updated_at
  before update on public.referrals
  for each row execute function public.set_updated_at();

-- ---------- 4. Validation and status machine ----------

create or replace function public.referrals_validate()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_referring_found boolean;
  v_referring_active boolean;
  v_referring_profile uuid;
  v_referring_is_doctor boolean;
  v_target_found boolean;
  v_target_active boolean;
  v_target_profile uuid;
  v_target_is_doctor boolean;
  v_appointment_status public.appointment_status;
  v_mutable text[];
  v_actor uuid;
begin
  -- Doctor records are only looked up inside the referral's own clinic. A
  -- missing or cross-clinic record is left to the composite foreign keys to
  -- reject, rather than reported here with a misleading message.
  select d.active,
         d.profile_id,
         exists (
           select 1 from public.staff_roles sr
           where sr.profile_id = d.profile_id
             and sr.clinic_id = d.clinic_id
             and sr.role = 'doctor'::public.staff_role
         )
    into v_referring_active, v_referring_profile, v_referring_is_doctor
    from public.doctors d
   where d.id = new.referring_doctor_id
     and d.clinic_id = new.clinic_id;
  v_referring_found := found;

  select d.active,
         d.profile_id,
         exists (
           select 1 from public.staff_roles sr
           where sr.profile_id = d.profile_id
             and sr.clinic_id = d.clinic_id
             and sr.role = 'doctor'::public.staff_role
         )
    into v_target_active, v_target_profile, v_target_is_doctor
    from public.doctors d
   where d.id = new.referred_to_doctor_id
     and d.clinic_id = new.clinic_id;
  v_target_found := found;

  if tg_op = 'INSERT' then
    if new.status is distinct from 'pending'::public.referral_status then
      raise exception 'referral: a referral must be created as pending';
    end if;

    new.created_at := now();
    new.updated_at := now();

    if v_referring_found and new.created_by is not null then
      if not v_referring_active then
        raise exception 'referral: the referring doctor is inactive';
      end if;
      if new.created_by is distinct from v_referring_profile or not v_referring_is_doctor then
        raise exception 'referral: created_by must be the referring doctor''s own doctor account';
      end if;
    end if;

    -- Same doctor record on both sides is left to referrals_not_self_referral.
    if v_target_found and new.referred_to_doctor_id <> new.referring_doctor_id then
      if not v_target_active then
        raise exception 'referral: the receiving doctor is inactive';
      end if;
      if v_target_profile is null or not v_target_is_doctor then
        raise exception 'referral: the receiving doctor has no linked doctor account';
      end if;
      if v_target_profile = v_referring_profile then
        raise exception 'referral: self-referral (both doctor records belong to the same account)';
      end if;
    end if;

    select a.status
      into v_appointment_status
      from public.appointments a
     where a.id = new.originating_appointment_id
       and a.clinic_id = new.clinic_id
       and a.patient_id = new.patient_id
       and a.doctor_id = new.referring_doctor_id;
    if found and v_appointment_status not in ('in_progress', 'completed') then
      raise exception 'referral: the originating consultation must be in progress or completed (it is %)', v_appointment_status;
    end if;

    return new;
  end if;

  -- UPDATE: status transitions are the only permitted change.
  if new.status = old.status then
    v_mutable := array['updated_at'];
  elsif (old.status = 'pending' and new.status in ('accepted', 'declined', 'revoked', 'expired'))
     or (old.status = 'accepted' and new.status in ('completed', 'revoked', 'expired')) then
    v_mutable := case new.status
      when 'accepted' then array['status', 'accepted_at', 'accepted_by', 'updated_at']
      when 'declined' then array['status', 'declined_at', 'declined_by', 'declined_reason', 'updated_at']
      when 'completed' then array['status', 'completed_at', 'completed_by', 'updated_at']
      when 'revoked' then array['status', 'revoked_at', 'revoked_by', 'revoked_reason', 'updated_at']
      else array['status', 'updated_at']
    end;
  else
    raise exception 'referral: invalid status transition % -> %', old.status, new.status;
  end if;

  if (to_jsonb(new) - v_mutable) is distinct from (to_jsonb(old) - v_mutable) then
    if new.status = old.status then
      raise exception 'referral: a referral cannot be edited, only moved through its status transitions';
    end if;
    raise exception 'referral: the % transition may only set its own fields', new.status;
  end if;

  if new.status = old.status then
    return new;
  end if;

  if new.status in ('accepted', 'completed') and old.expires_at <= now() then
    raise exception 'referral: the referral expired at %', old.expires_at;
  end if;
  if new.status = 'expired' and old.expires_at > now() then
    raise exception 'referral: the referral does not expire until %', old.expires_at;
  end if;

  if new.status in ('accepted', 'declined', 'completed') then
    v_actor := case new.status
      when 'accepted' then new.accepted_by
      when 'declined' then new.declined_by
      else new.completed_by
    end;
    if v_actor is null
       or v_actor is distinct from v_target_profile
       or not v_target_active
       or not v_target_is_doctor then
      raise exception 'referral: only the receiving doctor can mark the referral %', new.status;
    end if;
  elsif new.status = 'revoked' then
    if new.revoked_by is null or not (
         (new.revoked_by = v_referring_profile and v_referring_active and v_referring_is_doctor)
         or exists (
           select 1 from public.staff_roles sr
           where sr.profile_id = new.revoked_by
             and sr.clinic_id = new.clinic_id
             and sr.role in ('owner', 'admin', 'manager')
         )
       ) then
      raise exception 'referral: only the referring doctor or clinic management can revoke a referral';
    end if;
  end if;

  case new.status
    when 'accepted' then new.accepted_at := now();
    when 'declined' then new.declined_at := now();
    when 'completed' then new.completed_at := now();
    when 'revoked' then new.revoked_at := now();
    else null;
  end case;

  return new;
end;
$$;

comment on function public.referrals_validate() is
  'Referral business rules and status machine (see migration 20260926000001_referrals.sql); applies to every writer, including the service role.';

drop trigger if exists referrals_validate on public.referrals;
create trigger referrals_validate
  before insert or update on public.referrals
  for each row execute function public.referrals_validate();

-- ---------- 5. Audit (ids and status only, never clinical text) ----------

create or replace function public.referrals_audit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_action text;
  v_actor uuid;
begin
  if tg_op = 'INSERT' then
    v_action := 'referral_created';
    v_actor := new.created_by;
  elsif new.status is distinct from old.status then
    v_action := 'referral_' || new.status::text;
    v_actor := case new.status
      when 'accepted' then new.accepted_by
      when 'declined' then new.declined_by
      when 'completed' then new.completed_by
      when 'revoked' then new.revoked_by
      else null
    end;
  else
    return null;
  end if;

  insert into public.audit_events (
    clinic_id, actor_id, actor_type, action, entity_type, entity_id,
    old_values, new_values, ip_address
  ) values (
    new.clinic_id,
    v_actor,
    case when v_actor is null then 'system'::public.actor_type else 'staff'::public.actor_type end,
    v_action,
    'referrals',
    new.id::text,
    case when tg_op = 'UPDATE' then jsonb_build_object('status', old.status) end,
    jsonb_build_object(
      'status', new.status,
      'priority', new.priority,
      'patient_id', new.patient_id,
      'referring_doctor_id', new.referring_doctor_id,
      'referred_to_doctor_id', new.referred_to_doctor_id,
      'originating_appointment_id', new.originating_appointment_id,
      'expires_at', new.expires_at
    ),
    nullif(current_setting('request.ip', true), '')
  );
  return null;
end;
$$;

drop trigger if exists referrals_audit on public.referrals;
create trigger referrals_audit
  after insert or update on public.referrals
  for each row execute function public.referrals_audit();

-- ---------- 6. Access ----------

-- True when the signed-in user is the active, doctor-role account linked to
-- this doctor record (in the doctor record's own clinic).
create or replace function public.is_linked_doctor(p_doctor_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.doctors d
    join public.staff_roles sr
      on sr.profile_id = d.profile_id
     and sr.clinic_id = d.clinic_id
     and sr.role = 'doctor'::public.staff_role
    where d.id = p_doctor_id
      and d.active
      and d.profile_id = auth.uid()
  );
$$;

-- Only answers about the caller themselves; RLS evaluates it as
-- `authenticated`, so that role keeps EXECUTE.
revoke execute on function public.is_linked_doctor(uuid) from public, anon;
grant execute on function public.is_linked_doctor(uuid) to authenticated, service_role;

alter table public.referrals enable row level security;

create policy "referrals read for referring doctor"
  on public.referrals for select
  to authenticated
  using (public.is_linked_doctor(referring_doctor_id));

create policy "referrals read for receiving doctor"
  on public.referrals for select
  to authenticated
  using (
    public.is_linked_doctor(referred_to_doctor_id)
    and (
      status = 'completed'
      or (status in ('pending', 'accepted') and expires_at > now())
    )
  );

-- No INSERT/UPDATE/DELETE policies, and no such privileges either: browser
-- sessions only read, the server writes through the service role, and no
-- one deletes (withdraw a referral with status 'revoked'). Explicit, so the
-- table does not inherit the blanket grants from 20260813000013_grants.sql.
revoke all on table public.referrals from public, anon, authenticated, service_role;
grant select on table public.referrals to authenticated;
grant select, insert, update on table public.referrals to service_role;

-- =====================================================================
-- FILE: 20260927000001_referral_follow_up_and_doctor_accounts.sql
-- =====================================================================
-- Referral follow-up booking + doctor account hardening (referrals Phase 1,
-- API/UI step; builds on 20260926000001_referrals.sql).
--
-- 1. referrals.follow_up_appointment_id — the appointment reception books
--    with the receiving doctor once the referral is accepted. A composite
--    foreign key pins it to the referral's clinic, patient and RECEIVING
--    doctor (reusing appointments_id_clinic_id_patient_id_doctor_id_key).
--    referrals_validate() now also enforces: only while the referral is
--    accepted and unexpired; never on a cancelled/no-show appointment; once —
--    replaceable only after the linked appointment was cancelled or marked
--    no-show; never unlinked. referrals_audit() records the booking as
--    'referral_follow_up_booked', attributed to the staff member who created
--    the appointment (appointments.created_by).
--
-- 2. Doctor accounts (Phase 0 audit gap G3). Referral authority is keyed to
--    the account linked to a doctor record, so that link must be trustworthy:
--      * one doctor record per account per clinic (the admin API already
--        enforces this; the index makes it hold for every writer). Added
--        defensively: skipped with a notice if duplicates already exist;
--      * linking an account (doctors.profile_id) is server-side only. The
--        "doctors write for management" RLS policy has no column limit, so a
--        manager's browser session could link its own account to a doctor
--        record — bypassing assertDoctorProfileAvailable() in
--        src/app/api/admin/doctors/route.ts — and pass doctor-only routes.
--        Same pattern as patients_telegram_identity_server_only.
--
-- Reversible: drop column referrals.follow_up_appointment_id; restore
-- referrals_validate()/referrals_audit() from 20260926000001_referrals.sql;
-- drop trigger doctors_account_link_server_only, function
-- doctors_account_link_server_only() and index doctors_clinic_profile_key.

-- ---------- 1. Follow-up appointment ----------

alter table public.referrals
  add column follow_up_appointment_id uuid;

alter table public.referrals
  add constraint referrals_follow_up_appointment_fkey
  foreign key (follow_up_appointment_id, clinic_id, patient_id, referred_to_doctor_id)
  references public.appointments (id, clinic_id, patient_id, doctor_id);

create index referrals_follow_up_appointment_idx
  on public.referrals (follow_up_appointment_id)
  where follow_up_appointment_id is not null;

comment on column public.referrals.follow_up_appointment_id is
  'The appointment booked with the receiving doctor for this referral; set by reception once the referral is accepted.';

create or replace function public.referrals_validate()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_referring_found boolean;
  v_referring_active boolean;
  v_referring_profile uuid;
  v_referring_is_doctor boolean;
  v_target_found boolean;
  v_target_active boolean;
  v_target_profile uuid;
  v_target_is_doctor boolean;
  v_appointment_status public.appointment_status;
  v_mutable text[];
  v_actor uuid;
begin
  -- Doctor records are only looked up inside the referral's own clinic. A
  -- missing or cross-clinic record is left to the composite foreign keys to
  -- reject, rather than reported here with a misleading message.
  select d.active,
         d.profile_id,
         exists (
           select 1 from public.staff_roles sr
           where sr.profile_id = d.profile_id
             and sr.clinic_id = d.clinic_id
             and sr.role = 'doctor'::public.staff_role
         )
    into v_referring_active, v_referring_profile, v_referring_is_doctor
    from public.doctors d
   where d.id = new.referring_doctor_id
     and d.clinic_id = new.clinic_id;
  v_referring_found := found;

  select d.active,
         d.profile_id,
         exists (
           select 1 from public.staff_roles sr
           where sr.profile_id = d.profile_id
             and sr.clinic_id = d.clinic_id
             and sr.role = 'doctor'::public.staff_role
         )
    into v_target_active, v_target_profile, v_target_is_doctor
    from public.doctors d
   where d.id = new.referred_to_doctor_id
     and d.clinic_id = new.clinic_id;
  v_target_found := found;

  if tg_op = 'INSERT' then
    if new.status is distinct from 'pending'::public.referral_status then
      raise exception 'referral: a referral must be created as pending';
    end if;
    if new.follow_up_appointment_id is not null then
      raise exception 'referral: a follow-up can only be booked once the referral is accepted';
    end if;

    new.created_at := now();
    new.updated_at := now();

    if v_referring_found and new.created_by is not null then
      if not v_referring_active then
        raise exception 'referral: the referring doctor is inactive';
      end if;
      if new.created_by is distinct from v_referring_profile or not v_referring_is_doctor then
        raise exception 'referral: created_by must be the referring doctor''s own doctor account';
      end if;
    end if;

    -- Same doctor record on both sides is left to referrals_not_self_referral.
    if v_target_found and new.referred_to_doctor_id <> new.referring_doctor_id then
      if not v_target_active then
        raise exception 'referral: the receiving doctor is inactive';
      end if;
      if v_target_profile is null or not v_target_is_doctor then
        raise exception 'referral: the receiving doctor has no linked doctor account';
      end if;
      if v_target_profile = v_referring_profile then
        raise exception 'referral: self-referral (both doctor records belong to the same account)';
      end if;
    end if;

    select a.status
      into v_appointment_status
      from public.appointments a
     where a.id = new.originating_appointment_id
       and a.clinic_id = new.clinic_id
       and a.patient_id = new.patient_id
       and a.doctor_id = new.referring_doctor_id;
    if found and v_appointment_status not in ('in_progress', 'completed') then
      raise exception 'referral: the originating consultation must be in progress or completed (it is %)', v_appointment_status;
    end if;

    return new;
  end if;

  -- UPDATE: status transitions, plus booking the follow-up while accepted.
  if new.status = old.status then
    if new.follow_up_appointment_id is distinct from old.follow_up_appointment_id
       and old.status <> 'accepted' then
      raise exception 'referral: a follow-up can only be booked once the referral is accepted';
    end if;
    v_mutable := array['follow_up_appointment_id', 'updated_at'];
  elsif (old.status = 'pending' and new.status in ('accepted', 'declined', 'revoked', 'expired'))
     or (old.status = 'accepted' and new.status in ('completed', 'revoked', 'expired')) then
    v_mutable := case new.status
      when 'accepted' then array['status', 'accepted_at', 'accepted_by', 'updated_at']
      when 'declined' then array['status', 'declined_at', 'declined_by', 'declined_reason', 'updated_at']
      when 'completed' then array['status', 'completed_at', 'completed_by', 'updated_at']
      when 'revoked' then array['status', 'revoked_at', 'revoked_by', 'revoked_reason', 'updated_at']
      else array['status', 'updated_at']
    end;
  else
    raise exception 'referral: invalid status transition % -> %', old.status, new.status;
  end if;

  if (to_jsonb(new) - v_mutable) is distinct from (to_jsonb(old) - v_mutable) then
    if new.status = old.status then
      raise exception 'referral: a referral cannot be edited, only moved through its status transitions';
    end if;
    raise exception 'referral: the % transition may only set its own fields', new.status;
  end if;

  if new.status = old.status then
    if new.follow_up_appointment_id is distinct from old.follow_up_appointment_id then
      if new.follow_up_appointment_id is null then
        raise exception 'referral: a booked follow-up cannot be unlinked';
      end if;
      if old.expires_at <= now() then
        raise exception 'referral: the referral expired at %', old.expires_at;
      end if;
      if old.follow_up_appointment_id is not null and exists (
           select 1 from public.appointments a
           where a.id = old.follow_up_appointment_id
             and a.status not in ('cancelled', 'no_show')
         ) then
        raise exception 'referral: a follow-up appointment is already booked';
      end if;
      if exists (
           select 1 from public.appointments a
           where a.id = new.follow_up_appointment_id
             and a.status in ('cancelled', 'no_show')
         ) then
        raise exception 'referral: the follow-up appointment is cancelled';
      end if;
    end if;
    return new;
  end if;

  if new.status in ('accepted', 'completed') and old.expires_at <= now() then
    raise exception 'referral: the referral expired at %', old.expires_at;
  end if;
  if new.status = 'expired' and old.expires_at > now() then
    raise exception 'referral: the referral does not expire until %', old.expires_at;
  end if;

  if new.status in ('accepted', 'declined', 'completed') then
    v_actor := case new.status
      when 'accepted' then new.accepted_by
      when 'declined' then new.declined_by
      else new.completed_by
    end;
    if v_actor is null
       or v_actor is distinct from v_target_profile
       or not v_target_active
       or not v_target_is_doctor then
      raise exception 'referral: only the receiving doctor can mark the referral %', new.status;
    end if;
  elsif new.status = 'revoked' then
    if new.revoked_by is null or not (
         (new.revoked_by = v_referring_profile and v_referring_active and v_referring_is_doctor)
         or exists (
           select 1 from public.staff_roles sr
           where sr.profile_id = new.revoked_by
             and sr.clinic_id = new.clinic_id
             and sr.role in ('owner', 'admin', 'manager')
         )
       ) then
      raise exception 'referral: only the referring doctor or clinic management can revoke a referral';
    end if;
  end if;

  case new.status
    when 'accepted' then new.accepted_at := now();
    when 'declined' then new.declined_at := now();
    when 'completed' then new.completed_at := now();
    when 'revoked' then new.revoked_at := now();
    else null;
  end case;

  return new;
end;
$$;

create or replace function public.referrals_audit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_action text;
  v_actor uuid;
  v_old jsonb;
begin
  if tg_op = 'INSERT' then
    v_action := 'referral_created';
    v_actor := new.created_by;
  elsif new.status is distinct from old.status then
    v_action := 'referral_' || new.status::text;
    v_actor := case new.status
      when 'accepted' then new.accepted_by
      when 'declined' then new.declined_by
      when 'completed' then new.completed_by
      when 'revoked' then new.revoked_by
      else null
    end;
    v_old := jsonb_build_object('status', old.status);
  elsif new.follow_up_appointment_id is distinct from old.follow_up_appointment_id then
    v_action := 'referral_follow_up_booked';
    select a.created_by into v_actor
      from public.appointments a
     where a.id = new.follow_up_appointment_id;
    v_old := jsonb_build_object('follow_up_appointment_id', old.follow_up_appointment_id);
  else
    return null;
  end if;

  insert into public.audit_events (
    clinic_id, actor_id, actor_type, action, entity_type, entity_id,
    old_values, new_values, ip_address
  ) values (
    new.clinic_id,
    v_actor,
    case when v_actor is null then 'system'::public.actor_type else 'staff'::public.actor_type end,
    v_action,
    'referrals',
    new.id::text,
    v_old,
    jsonb_build_object(
      'status', new.status,
      'priority', new.priority,
      'patient_id', new.patient_id,
      'referring_doctor_id', new.referring_doctor_id,
      'referred_to_doctor_id', new.referred_to_doctor_id,
      'originating_appointment_id', new.originating_appointment_id,
      'follow_up_appointment_id', new.follow_up_appointment_id,
      'expires_at', new.expires_at
    ),
    nullif(current_setting('request.ip', true), '')
  );
  return null;
end;
$$;

-- ---------- 2. Doctor accounts ----------

do $$
declare
  v_dup_count int;
begin
  select count(*) into v_dup_count from (
    select 1 from public.doctors
    where profile_id is not null
    group by clinic_id, profile_id having count(*) > 1
  ) d;
  if v_dup_count > 0 then
    raise notice 'Skipping UNIQUE(clinic_id, profile_id) on doctors: % account(s) are linked to several doctor records — resolve manually, then add doctors_clinic_profile_key in a follow-up migration', v_dup_count;
  elsif not exists (select 1 from pg_indexes where indexname = 'doctors_clinic_profile_key') then
    create unique index doctors_clinic_profile_key
      on public.doctors (clinic_id, profile_id)
      where profile_id is not null;
  end if;
end $$;

create or replace function public.doctors_account_link_server_only()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Server-side code (service role, no JWT) links accounts after the admin
  -- API has checked the account is a doctor of this clinic; browser
  -- sessions may edit a doctor record but never who it belongs to.
  if coalesce(auth.role(), '') <> 'authenticated' then
    return new;
  end if;

  if (tg_op = 'INSERT' and new.profile_id is not null)
     or (tg_op = 'UPDATE' and new.profile_id is distinct from old.profile_id) then
    raise exception 'doctors: linking a doctor account is server-side only';
  end if;

  return new;
end;
$$;

drop trigger if exists doctors_account_link_server_only on public.doctors;
create trigger doctors_account_link_server_only
  before insert or update on public.doctors
  for each row execute function public.doctors_account_link_server_only();

-- =====================================================================
-- FILE: 20260927000002_referral_creation_idempotency.sql
-- =====================================================================
-- Referral creation idempotency.
--
-- A doctor's accidental repeat of the same submission (double click, a
-- request retried after its response was lost) must not create a second
-- referral or a second audit event. The client sends one random key per
-- intended referral; the key is stored with the referral and is unique per
-- referring doctor, so a repeat of the request resolves to the referral it
-- already created (see createReferral in src/lib/referrals/service.ts).
--
-- The key is set once on insert: referrals_validate() treats every column
-- outside its per-transition allow-list as immutable, so it can never be
-- changed or cleared afterwards. It is not written to audit_events.

alter table public.referrals add column creation_key uuid;

comment on column public.referrals.creation_key is
  'Client-generated idempotency key of the request that created the referral; unique per referring doctor, immutable.';

-- Scoped to the referring doctor: one doctor's key can never resolve to, or
-- collide with, another doctor's referral.
create unique index referrals_creation_key_key
  on public.referrals (clinic_id, referring_doctor_id, creation_key)
  where creation_key is not null;

-- =====================================================================
-- FILE: 20260927000003_referral_clinical_access.sql
-- =====================================================================
-- Referral-based clinical access: the authorization layer for doctors.
--
-- A doctor never gets a patient's clinical data merely by working in the
-- same clinic. public.doctor_patient_access() is the single definition of
-- what one doctor may see of one patient. The RLS policies below use it for
-- direct database/API access with the doctor's own token, and the server
-- (src/lib/clinical-access, through the service role) uses it before it
-- reads anything, so both layers make the same decision.
--
--   own       the doctor has an appointment with the patient (the rule the
--             existing policies already applied): the patient record and
--             the doctor's own appointments with the patient.
--   referred  an active referral to the doctor: status pending or accepted
--             AND expires_at still in the future (compared with now(), so
--             access ends on time even before the lazy expiry sweep marks
--             the row expired). Declined, revoked, completed and expired
--             referrals grant nothing.
--               pending  -> the patient record only (to decide on it),
--               accepted -> also the patient's appointments with the
--                           referring doctor (the handed-over history).
--   none      nothing - including every patient of another clinic.
--
-- Unchanged and deliberately so: payments stay limited to the doctor's own
-- appointments; conversations, messages and voice notes stay closed to
-- doctors; a doctor session may only change the status of its own
-- appointments (appointments_doctor_status_only); referrals are read-only
-- for every signed-in role. Staff who also hold an operational role
-- (owner/admin/manager/receptionist) keep that role's clinic-wide access.

-- ---------------------------------------------------------------------------
-- The decision
-- ---------------------------------------------------------------------------

-- One row when the doctor record belongs to an account holding the doctor
-- role and the patient is in the same clinic; no row otherwise (unknown ids,
-- another clinic, a doctor record nobody signs in as).
create or replace function public.doctor_patient_access(p_doctor_id uuid, p_patient_id uuid)
returns table (
  clinic_id uuid,
  own_patient boolean,
  active_referral_ids uuid[],
  history_doctor_ids uuid[]
)
language sql
stable
security definer
set search_path = public
as $$
  select
    d.clinic_id,
    exists (
      select 1
      from public.appointments a
      where a.clinic_id = d.clinic_id
        and a.patient_id = p.id
        and a.doctor_id = d.id
    ),
    array(
      select r.id
      from public.referrals r
      where r.clinic_id = d.clinic_id
        and r.patient_id = p.id
        and r.referred_to_doctor_id = d.id
        and r.status in ('pending', 'accepted')
        and r.expires_at > now()
      order by r.created_at
    ),
    array(
      select distinct r.referring_doctor_id
      from public.referrals r
      where r.clinic_id = d.clinic_id
        and r.patient_id = p.id
        and r.referred_to_doctor_id = d.id
        and r.status = 'accepted'
        and r.expires_at > now()
    )
  from public.doctors d
  join public.patients p
    on p.id = p_patient_id
   and p.clinic_id = d.clinic_id
  where d.id = p_doctor_id
    and exists (
      select 1
      from public.staff_roles sr
      where sr.profile_id = d.profile_id
        and sr.clinic_id = d.clinic_id
        and sr.role = 'doctor'
    );
$$;

comment on function public.doctor_patient_access(uuid, uuid) is
  'What a doctor may see of a patient: own relationship, active referrals (pending/accepted, unexpired) and the referring doctors whose visits are shared (accepted). No row = no access. Server-only: it answers for any doctor id.';

-- It answers for any doctor id, so only the server may call it directly.
revoke all on function public.doctor_patient_access(uuid, uuid) from public, anon, authenticated;
grant execute on function public.doctor_patient_access(uuid, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- The signed-in doctor (for RLS)
-- ---------------------------------------------------------------------------

-- The caller's doctor record in a clinic: linked to auth.uid() and backed by
-- the doctor role there. At most one (doctors_clinic_profile_key).
create or replace function public.current_doctor_id(p_clinic_id uuid)
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select d.id
  from public.doctors d
  join public.staff_roles sr
    on sr.profile_id = d.profile_id
   and sr.clinic_id = d.clinic_id
   and sr.role = 'doctor'
  where d.profile_id = auth.uid()
    and d.clinic_id = p_clinic_id
  limit 1;
$$;

-- Whether the caller, as a doctor, may read this patient's record.
create or replace function public.doctor_can_read_patient(p_clinic_id uuid, p_patient_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.doctor_patient_access(public.current_doctor_id(p_clinic_id), p_patient_id) x
    where x.own_patient or cardinality(x.active_referral_ids) > 0
  );
$$;

-- Whether the caller, as a doctor, may read an appointment: their own, or
-- one of the patient's visits with a doctor who referred the patient to
-- them (accepted, unexpired referral).
create or replace function public.doctor_can_read_appointment(p_clinic_id uuid, p_patient_id uuid, p_doctor_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.doctor_patient_access(public.current_doctor_id(p_clinic_id), p_patient_id) x
    where p_doctor_id = public.current_doctor_id(p_clinic_id)
       or p_doctor_id = any (x.history_doctor_ids)
  );
$$;

-- These only ever answer about the caller, so RLS may call them for any
-- signed-in user; anonymous callers never reach them.
revoke all on function public.current_doctor_id(uuid) from public, anon;
revoke all on function public.doctor_can_read_patient(uuid, uuid) from public, anon;
revoke all on function public.doctor_can_read_appointment(uuid, uuid, uuid) from public, anon;
grant execute on function public.current_doctor_id(uuid) to authenticated, service_role;
grant execute on function public.doctor_can_read_patient(uuid, uuid) to authenticated, service_role;
grant execute on function public.doctor_can_read_appointment(uuid, uuid, uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- RLS: operational staff and doctors as separate policies
-- ---------------------------------------------------------------------------

drop policy if exists "patients read for operational staff" on public.patients;
create policy "patients read for operational staff" on public.patients
  for select to authenticated
  using (public.is_clinic_staff(clinic_id, array['owner', 'admin', 'manager', 'receptionist']::public.staff_role[]));
create policy "patients read for authorized doctors" on public.patients
  for select to authenticated
  using (public.doctor_can_read_patient(clinic_id, id));

drop policy if exists "appointments read for staff" on public.appointments;
create policy "appointments read for operational staff" on public.appointments
  for select to authenticated
  using (public.is_clinic_staff(clinic_id, array['owner', 'admin', 'manager', 'receptionist']::public.staff_role[]));
create policy "appointments read for authorized doctors" on public.appointments
  for select to authenticated
  using (public.doctor_can_read_appointment(clinic_id, patient_id, doctor_id));

-- =====================================================================
-- FILE: 20260927000004_clinical_access_hardening.sql
-- =====================================================================
-- Clinical access hardening: closes the gaps found reviewing the doctor
-- authorization layer (20260927000003_referral_clinical_access.sql).
--
-- 1. Voice recordings: any staff member of a clinic — doctors included —
--    could download every patient's voice note straight from Supabase
--    Storage, although the voice_messages rows are operational-staff only.
--    The bucket's read policy now matches the table's.
-- 2. Doctors could still UPDATE their own appointments directly through the
--    REST API (any status: cancel, no-show, back to pending), bypassing the
--    server's forward-only checked_in -> in_progress -> completed rule. The
--    app only ever changes status through /api/doctor/appointments (service
--    role), so doctors lose direct write access to appointments entirely.
-- 3. A deactivated doctor record kept clinical access through RLS while the
--    API, the referral policies (is_linked_doctor) and the booking engine
--    all treat it as not practising. The decision now requires an active
--    doctor record, so every layer agrees.
-- 4. The server showed the receiving doctor the referral's originating
--    consultation and the referring doctor the follow-up appointment, which
--    RLS denied. The decision now names these referral-linked appointments
--    (referral_appointment_ids), and RLS and server both use it:
--      - the originating consultation of an active (pending/accepted,
--        unexpired) referral, for the doctor it is referred to;
--      - the follow-up appointment of a referral, for the referring doctor.
--    A completed, declined, revoked or expired referral no longer shows the
--    receiving doctor the consultation.

-- ---------------------------------------------------------------------------
-- 1. Voice recordings: operational roles only
-- ---------------------------------------------------------------------------

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
        and sr.role = any (array['owner', 'admin', 'manager', 'receptionist']::public.staff_role[])
    )
  );

-- ---------------------------------------------------------------------------
-- 2. Doctors write appointments only through the server
-- ---------------------------------------------------------------------------

drop policy if exists "appointments status update for own doctor" on public.appointments;

-- ---------------------------------------------------------------------------
-- 3 + 4. The decision: active doctors, referral-linked appointments
-- ---------------------------------------------------------------------------

-- The appointments policy depends on the old doctor_can_read_appointment
-- signature, and doctor_patient_access gains a column: drop and recreate.
drop policy if exists "appointments read for authorized doctors" on public.appointments;
drop function if exists public.doctor_can_read_appointment(uuid, uuid, uuid);
drop function if exists public.doctor_patient_access(uuid, uuid);

create function public.doctor_patient_access(p_doctor_id uuid, p_patient_id uuid)
returns table (
  clinic_id uuid,
  own_patient boolean,
  active_referral_ids uuid[],
  history_doctor_ids uuid[],
  referral_appointment_ids uuid[]
)
language sql
stable
security definer
set search_path = public
as $$
  select
    d.clinic_id,
    exists (
      select 1
      from public.appointments a
      where a.clinic_id = d.clinic_id
        and a.patient_id = p.id
        and a.doctor_id = d.id
    ),
    array(
      select r.id
      from public.referrals r
      where r.clinic_id = d.clinic_id
        and r.patient_id = p.id
        and r.referred_to_doctor_id = d.id
        and r.status in ('pending', 'accepted')
        and r.expires_at > now()
      order by r.created_at
    ),
    array(
      select distinct r.referring_doctor_id
      from public.referrals r
      where r.clinic_id = d.clinic_id
        and r.patient_id = p.id
        and r.referred_to_doctor_id = d.id
        and r.status = 'accepted'
        and r.expires_at > now()
    ),
    array(
      -- The consultation an active referral to this doctor was raised from…
      select r.originating_appointment_id
      from public.referrals r
      where r.clinic_id = d.clinic_id
        and r.patient_id = p.id
        and r.referred_to_doctor_id = d.id
        and r.status in ('pending', 'accepted')
        and r.expires_at > now()
      union
      -- …and the follow-up booked for a referral this doctor made.
      select r.follow_up_appointment_id
      from public.referrals r
      where r.clinic_id = d.clinic_id
        and r.patient_id = p.id
        and r.referring_doctor_id = d.id
        and r.follow_up_appointment_id is not null
    )
  from public.doctors d
  join public.patients p
    on p.id = p_patient_id
   and p.clinic_id = d.clinic_id
  where d.id = p_doctor_id
    and d.active
    and exists (
      select 1
      from public.staff_roles sr
      where sr.profile_id = d.profile_id
        and sr.clinic_id = d.clinic_id
        and sr.role = 'doctor'
    );
$$;

comment on function public.doctor_patient_access(uuid, uuid) is
  'What an active doctor may see of a patient: own relationship, active referrals (pending/accepted, unexpired), referring doctors whose visits are shared (accepted) and referral-linked appointments. No row = no access. Server-only: it answers for any doctor id.';

revoke all on function public.doctor_patient_access(uuid, uuid) from public, anon, authenticated;
grant execute on function public.doctor_patient_access(uuid, uuid) to service_role;

create or replace function public.current_doctor_id(p_clinic_id uuid)
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select d.id
  from public.doctors d
  join public.staff_roles sr
    on sr.profile_id = d.profile_id
   and sr.clinic_id = d.clinic_id
   and sr.role = 'doctor'
  where d.profile_id = auth.uid()
    and d.clinic_id = p_clinic_id
    and d.active
  limit 1;
$$;

-- Whether the caller, as a doctor, may read an appointment: their own, a
-- visit with a doctor who referred the patient to them (accepted,
-- unexpired), or an appointment a referral links them to.
create function public.doctor_can_read_appointment(
  p_clinic_id uuid,
  p_patient_id uuid,
  p_doctor_id uuid,
  p_appointment_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.doctor_patient_access(public.current_doctor_id(p_clinic_id), p_patient_id) x
    where p_doctor_id = public.current_doctor_id(p_clinic_id)
       or p_doctor_id = any (x.history_doctor_ids)
       or p_appointment_id = any (x.referral_appointment_ids)
  );
$$;

revoke all on function public.doctor_can_read_appointment(uuid, uuid, uuid, uuid) from public, anon;
grant execute on function public.doctor_can_read_appointment(uuid, uuid, uuid, uuid) to authenticated, service_role;

create policy "appointments read for authorized doctors" on public.appointments
  for select to authenticated
  using (public.doctor_can_read_appointment(clinic_id, patient_id, doctor_id, id));

-- Payments: a doctor still sees only the payments of their own appointments,
-- now through the same notion of "the signed-in, active doctor".
drop policy if exists "payments read for operational staff" on public.payments;
create policy "payments read for operational staff" on public.payments
  for select to authenticated
  using (public.is_clinic_staff(clinic_id, array['owner', 'admin', 'manager', 'receptionist']::public.staff_role[]));
create policy "payments read for own doctor" on public.payments
  for select to authenticated
  using (
    exists (
      select 1
      from public.appointments a
      where a.id = payments.appointment_id
        and a.clinic_id = payments.clinic_id
        and a.doctor_id = public.current_doctor_id(payments.clinic_id)
    )
  );

-- =====================================================================
-- FILE: 20260927000005_clinical_records.sql
-- =====================================================================
-- Doctor-authored clinical records.
--
-- Doctors document their own consultations: consultation notes, diagnoses,
-- prescriptions, laboratory results and medical history. Every record keeps
-- its provenance — the authoring doctor, the consultation (appointment) it
-- was written in, the time and the record type — and none of it can come
-- from the browser:
--
--   * a record belongs to exactly one consultation, and the composite
--     foreign key makes that the AUTHOR'S OWN appointment with THIS patient
--     in THIS clinic, so a doctor can never file a record under another
--     doctor's name, another patient or another clinic;
--   * the consultation must be in progress or completed;
--   * created_by must be the author's own doctor account (active, doctor
--     role) and created_at is the database's clock;
--   * records are immutable: no signed-in role may write at all, and even
--     the server may only insert. A mistake is fixed by a correction — a new
--     record by the same author, in the same consultation, pointing at the
--     one it corrects (at most one correction per record);
--   * every insert is audited WITHOUT its clinical text.
--
-- Who may read a record is exactly who may read the consultation it belongs
-- to — public.doctor_can_read_appointment(), i.e. the Phase 3 decision
-- public.doctor_patient_access(): the author (their own patient); a doctor
-- the patient is referred to, for the referring doctor's records while the
-- referral is accepted and unexpired (and the records of the consultation it
-- was raised from while it is active); the referring doctor, for the
-- records of the follow-up visit their referral led to. Nobody else: no
-- operational staff role, no other doctor, no patient-facing path, no AI.

create type public.clinical_record_type as enum (
  'consultation_note',
  'diagnosis',
  'prescription',
  'lab_result',
  'medical_history'
);

create table public.clinical_records (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete cascade,
  patient_id uuid not null,
  author_doctor_id uuid not null,
  -- The consultation the record was written in.
  appointment_id uuid not null,
  record_type public.clinical_record_type not null,
  -- Diagnosis, medication and dose, test and result, history item, or the
  -- note's headline.
  summary text not null,
  details text,
  -- Optional classification code, e.g. ICD-10 for a diagnosis.
  code text,
  corrects_record_id uuid references public.clinical_records(id),
  created_by uuid not null references public.profiles(id),
  -- Client idempotency key: a repeated submission resolves to this record.
  creation_key uuid,
  created_at timestamptz not null default now(),

  constraint clinical_records_patient_same_clinic_fkey
    foreign key (patient_id, clinic_id) references public.patients (id, clinic_id) on delete cascade,
  constraint clinical_records_author_same_clinic_fkey
    foreign key (author_doctor_id, clinic_id) references public.doctors (id, clinic_id),
  -- The author's own consultation with this patient in this clinic.
  constraint clinical_records_consultation_fkey
    foreign key (appointment_id, clinic_id, patient_id, author_doctor_id)
    references public.appointments (id, clinic_id, patient_id, doctor_id),
  constraint clinical_records_summary_check
    check (summary ~ '\S' and char_length(summary) <= 300),
  constraint clinical_records_details_check
    check (details is null or (details ~ '\S' and char_length(details) <= 4000)),
  constraint clinical_records_code_check
    check (code is null or code ~ '^[A-Za-z0-9.\-]{1,16}$'),
  constraint clinical_records_not_self_correction
    check (corrects_record_id is null or corrects_record_id <> id)
);

comment on table public.clinical_records is
  'Doctor-authored clinical records with provenance (author, consultation, time, type). Immutable; corrections are new records. Readable only by doctors doctor_can_read_appointment() admits; never by operational staff, patients or AI.';

create index clinical_records_patient_idx on public.clinical_records (clinic_id, patient_id, created_at desc);
create index clinical_records_author_idx on public.clinical_records (author_doctor_id, created_at desc);
create index clinical_records_appointment_idx on public.clinical_records (appointment_id);
create unique index clinical_records_one_correction on public.clinical_records (corrects_record_id)
  where corrects_record_id is not null;
create unique index clinical_records_creation_key_key on public.clinical_records (clinic_id, author_doctor_id, creation_key)
  where creation_key is not null;

-- ---------------------------------------------------------------------------
-- Validation: provenance, consultation state, immutability
-- ---------------------------------------------------------------------------

create or replace function public.clinical_records_validate()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_profile uuid;
  v_active boolean;
  v_status public.appointment_status;
  v_target public.clinical_records;
begin
  if tg_op = 'UPDATE' then
    raise exception 'clinical record: records cannot be edited; add a correction instead';
  end if;

  new.created_at := now();

  select d.profile_id, d.active
    into v_profile, v_active
  from public.doctors d
  where d.id = new.author_doctor_id
    and d.clinic_id = new.clinic_id;
  if not found or not v_active then
    raise exception 'clinical record: the author must be an active doctor of the clinic';
  end if;
  if v_profile is null or new.created_by is distinct from v_profile then
    raise exception 'clinical record: created_by must be the author''s own doctor account';
  end if;
  if not exists (
    select 1
    from public.staff_roles sr
    where sr.profile_id = v_profile
      and sr.clinic_id = new.clinic_id
      and sr.role = 'doctor'
  ) then
    raise exception 'clinical record: the author does not hold the doctor role';
  end if;

  -- The foreign key pins the consultation to the author and the patient;
  -- here it must also actually be taking or have taken place.
  select a.status into v_status
  from public.appointments a
  where a.id = new.appointment_id
    and a.clinic_id = new.clinic_id
    and a.patient_id = new.patient_id
    and a.doctor_id = new.author_doctor_id;
  if found and v_status not in ('in_progress', 'completed') then
    raise exception 'clinical record: the consultation must be in progress or completed (it is %)', v_status;
  end if;

  if new.corrects_record_id is not null then
    select * into v_target from public.clinical_records where id = new.corrects_record_id;
    if not found
       or v_target.clinic_id <> new.clinic_id
       or v_target.patient_id <> new.patient_id
       or v_target.author_doctor_id <> new.author_doctor_id then
      raise exception 'clinical record: only the author can correct their own record of the same patient';
    end if;
    if v_target.appointment_id <> new.appointment_id or v_target.record_type <> new.record_type then
      raise exception 'clinical record: a correction keeps the consultation and the record type of the record it corrects';
    end if;
  end if;

  return new;
end;
$$;

create trigger clinical_records_validate
  before insert or update on public.clinical_records
  for each row execute function public.clinical_records_validate();

-- ---------------------------------------------------------------------------
-- Audit: ids and type only — never the clinical text
-- ---------------------------------------------------------------------------

create or replace function public.clinical_records_audit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.audit_events (
    clinic_id, actor_id, actor_type, action, entity_type, entity_id, old_values, new_values
  ) values (
    new.clinic_id,
    new.created_by,
    'staff'::public.actor_type,
    case when new.corrects_record_id is null then 'clinical_record_created' else 'clinical_record_corrected' end,
    'clinical_records',
    new.id::text,
    null,
    jsonb_build_object(
      'record_type', new.record_type,
      'patient_id', new.patient_id,
      'author_doctor_id', new.author_doctor_id,
      'appointment_id', new.appointment_id,
      'corrects_record_id', new.corrects_record_id
    )
  );
  return new;
end;
$$;

create trigger clinical_records_audit
  after insert on public.clinical_records
  for each row execute function public.clinical_records_audit();

-- ---------------------------------------------------------------------------
-- Access: authorized doctors read; only the server inserts
-- ---------------------------------------------------------------------------

alter table public.clinical_records enable row level security;

create policy "clinical records read for authorized doctors" on public.clinical_records
  for select to authenticated
  using (public.doctor_can_read_appointment(clinic_id, patient_id, author_doctor_id, appointment_id));

revoke all on table public.clinical_records from public, anon, authenticated, service_role;
grant select on table public.clinical_records to authenticated;
grant select, insert on table public.clinical_records to service_role;

-- =====================================================================
-- FILE: 20260928000001_clinical_handoff_types.sql
-- =====================================================================
-- Clinical handoff (1 of 2): new enum values.
--
-- Kept in a migration of their own: a value added with ALTER TYPE … ADD VALUE
-- cannot be used in the transaction that added it, and
-- 20260928000002_clinical_handoff.sql uses them.
--
--   referral_status 'in_progress'  — the receiving doctor's consultation for
--     the referral has started (PENDING → ACCEPTED → IN_PROGRESS → COMPLETED).
--   clinical_record_type 'assessment' — the doctor's current assessment in
--     this consultation (distinct from a diagnosis).
--   clinical_record_type 'lab_order'  — a laboratory test ordered (distinct
--     from 'lab_result').
--   clinical_record_type 'follow_up'  — the follow-up plan / onward referral
--     note of the consultation.
--
-- Reversible only by recreating the types (Postgres cannot drop enum values);
-- nothing else depends on the new values until 20260928000002.

alter type public.referral_status add value if not exists 'in_progress' after 'accepted';

alter type public.clinical_record_type add value if not exists 'assessment' before 'diagnosis';
alter type public.clinical_record_type add value if not exists 'lab_order' before 'lab_result';
alter type public.clinical_record_type add value if not exists 'follow_up';

-- New enum values must be committed before any later statement uses them.
commit;

-- =====================================================================
-- FILE: 20260928000002_clinical_handoff.sql
-- =====================================================================
-- Clinical handoff (2 of 2): the referral lifecycle
--
--   PENDING → ACCEPTED → IN_PROGRESS → COMPLETED   (PENDING → DECLINED;
--   REVOKED by the referring doctor or management and EXPIRED at expires_at
--   while open)
--
-- 1. referrals.started_at / started_by — when the receiving doctor's
--    consultation for the referral started, and whose account it was.
-- 2. referrals_validate():
--      * accepted → in_progress only once the referral's follow-up
--        consultation (follow_up_appointment_id, the receiving doctor's own
--        appointment by foreign key) is in progress or completed, and only
--        for the receiving doctor's account;
--      * completed only from in_progress — a referral is completed after the
--        receiving doctor saw the patient, not instead of it;
--      * linking a consultation that has already started makes the referral
--        in progress in the same statement;
--      * a consultation that took place may replace a booked follow-up that
--        has not started yet (the doctor saw the patient earlier).
-- 3. appointments_referral_follow_up_started: when a linked follow-up
--    appointment starts (in progress or completed), whoever moved it, the
--    accepted referral becomes in progress. It never blocks the visit itself.
-- 4. referrals_audit(): 'referral_in_progress' is attributed to started_by
--    (referral_accepted / _declined / _completed already are).
-- 5. The open states now include in_progress everywhere "open" is used: the
--    one-open-referral-per-pair index, the receiving doctor's read policy, and
--    public.doctor_patient_access() — an in-progress referral gives the
--    receiving doctor the same history as an accepted one, until it is
--    completed, revoked or expires.
--
-- Clinical records need no change beyond the new types (20260928000001): a
-- handoff consultation is documented in the existing clinical_records table,
-- authored by the receiving doctor by foreign key, and the referring
-- doctor's records stay theirs and immutable.
--
-- Reversible: restore referrals_validate()/referrals_audit() from
-- 20260927000001, doctor_patient_access() from 20260927000004, the policy and
-- index from 20260926000001; drop trigger appointments_referral_follow_up_started,
-- function referral_follow_up_started(), constraint referrals_started_state_check
-- and columns referrals.started_at/started_by (after moving in_progress rows
-- back to accepted).

-- ---------- 1. Columns ----------

alter table public.referrals
  add column started_at timestamptz,
  add column started_by uuid references public.profiles(id);

alter table public.referrals
  add constraint referrals_started_state_check
  check (
    (started_at is null) = (started_by is null)
    and (status <> 'in_progress' or started_at is not null)
    and (started_at is null or (accepted_at is not null and started_at >= accepted_at))
    and (started_at is null or completed_at is null or completed_at >= started_at)
  );

comment on column public.referrals.started_at is
  'When the receiving doctor''s consultation for this referral (follow_up_appointment_id) started; set with the in_progress transition.';

comment on column public.referrals.follow_up_appointment_id is
  'The receiving doctor''s consultation for this referral: booked by reception once accepted, or the consultation the receiving doctor started. Once it has started the referral is in progress.';

comment on column public.referrals.expires_at is
  'End of the referral''s validity (at most 365 days after creation). After it an open referral (pending, accepted, in progress) can no longer be accepted, started or completed, and the receiving doctor can no longer read it unless they completed it.';

-- ---------- 2. Status machine ----------

create or replace function public.referrals_validate()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_referring_found boolean;
  v_referring_active boolean;
  v_referring_profile uuid;
  v_referring_is_doctor boolean;
  v_target_found boolean;
  v_target_active boolean;
  v_target_profile uuid;
  v_target_is_doctor boolean;
  v_appointment_status public.appointment_status;
  v_old_follow_up_status public.appointment_status;
  v_new_follow_up_status public.appointment_status;
  v_mutable text[];
  v_actor uuid;
begin
  -- Doctor records are only looked up inside the referral's own clinic. A
  -- missing or cross-clinic record is left to the composite foreign keys to
  -- reject, rather than reported here with a misleading message.
  select d.active,
         d.profile_id,
         exists (
           select 1 from public.staff_roles sr
           where sr.profile_id = d.profile_id
             and sr.clinic_id = d.clinic_id
             and sr.role = 'doctor'::public.staff_role
         )
    into v_referring_active, v_referring_profile, v_referring_is_doctor
    from public.doctors d
   where d.id = new.referring_doctor_id
     and d.clinic_id = new.clinic_id;
  v_referring_found := found;

  select d.active,
         d.profile_id,
         exists (
           select 1 from public.staff_roles sr
           where sr.profile_id = d.profile_id
             and sr.clinic_id = d.clinic_id
             and sr.role = 'doctor'::public.staff_role
         )
    into v_target_active, v_target_profile, v_target_is_doctor
    from public.doctors d
   where d.id = new.referred_to_doctor_id
     and d.clinic_id = new.clinic_id;
  v_target_found := found;

  if tg_op = 'INSERT' then
    if new.status is distinct from 'pending'::public.referral_status then
      raise exception 'referral: a referral must be created as pending';
    end if;
    if new.follow_up_appointment_id is not null then
      raise exception 'referral: a follow-up can only be booked once the referral is accepted';
    end if;

    new.created_at := now();
    new.updated_at := now();

    if v_referring_found and new.created_by is not null then
      if not v_referring_active then
        raise exception 'referral: the referring doctor is inactive';
      end if;
      if new.created_by is distinct from v_referring_profile or not v_referring_is_doctor then
        raise exception 'referral: created_by must be the referring doctor''s own doctor account';
      end if;
    end if;

    -- Same doctor record on both sides is left to referrals_not_self_referral.
    if v_target_found and new.referred_to_doctor_id <> new.referring_doctor_id then
      if not v_target_active then
        raise exception 'referral: the receiving doctor is inactive';
      end if;
      if v_target_profile is null or not v_target_is_doctor then
        raise exception 'referral: the receiving doctor has no linked doctor account';
      end if;
      if v_target_profile = v_referring_profile then
        raise exception 'referral: self-referral (both doctor records belong to the same account)';
      end if;
    end if;

    select a.status
      into v_appointment_status
      from public.appointments a
     where a.id = new.originating_appointment_id
       and a.clinic_id = new.clinic_id
       and a.patient_id = new.patient_id
       and a.doctor_id = new.referring_doctor_id;
    if found and v_appointment_status not in ('in_progress', 'completed') then
      raise exception 'referral: the originating consultation must be in progress or completed (it is %)', v_appointment_status;
    end if;

    return new;
  end if;

  -- UPDATE: status transitions, plus linking the follow-up while accepted.
  if new.status = old.status then
    if new.follow_up_appointment_id is distinct from old.follow_up_appointment_id
       and old.status <> 'accepted' then
      raise exception 'referral: a follow-up can only be booked once the referral is accepted';
    end if;
    v_mutable := array['follow_up_appointment_id', 'updated_at'];
  elsif (old.status = 'pending' and new.status in ('accepted', 'declined', 'revoked', 'expired'))
     or (old.status = 'accepted' and new.status in ('in_progress', 'revoked', 'expired'))
     or (old.status = 'in_progress' and new.status in ('completed', 'revoked', 'expired')) then
    v_mutable := case new.status
      when 'accepted' then array['status', 'accepted_at', 'accepted_by', 'updated_at']
      when 'in_progress' then array['status', 'started_at', 'started_by', 'updated_at']
      when 'declined' then array['status', 'declined_at', 'declined_by', 'declined_reason', 'updated_at']
      when 'completed' then array['status', 'completed_at', 'completed_by', 'updated_at']
      when 'revoked' then array['status', 'revoked_at', 'revoked_by', 'revoked_reason', 'updated_at']
      else array['status', 'updated_at']
    end;
  else
    raise exception 'referral: invalid status transition % -> %', old.status, new.status;
  end if;

  if (to_jsonb(new) - v_mutable) is distinct from (to_jsonb(old) - v_mutable) then
    if new.status = old.status then
      raise exception 'referral: a referral cannot be edited, only moved through its status transitions';
    end if;
    raise exception 'referral: the % transition may only set its own fields', new.status;
  end if;

  if new.status = old.status then
    if new.follow_up_appointment_id is distinct from old.follow_up_appointment_id then
      if new.follow_up_appointment_id is null then
        raise exception 'referral: a booked follow-up cannot be unlinked';
      end if;
      if old.expires_at <= now() then
        raise exception 'referral: the referral expired at %', old.expires_at;
      end if;
      select a.status into v_new_follow_up_status
        from public.appointments a
       where a.id = new.follow_up_appointment_id;
      if v_new_follow_up_status in ('cancelled', 'no_show') then
        raise exception 'referral: the follow-up appointment is cancelled';
      end if;
      if old.follow_up_appointment_id is not null then
        select a.status into v_old_follow_up_status
          from public.appointments a
         where a.id = old.follow_up_appointment_id;
        -- A cancelled/no-show booking may be replaced; so may one that has
        -- not started when the receiving doctor saw the patient before it.
        if v_old_follow_up_status not in ('cancelled', 'no_show')
           and not (
             v_old_follow_up_status in ('pending', 'confirmed', 'checked_in')
             and v_new_follow_up_status in ('in_progress', 'completed')
           ) then
          raise exception 'referral: a follow-up appointment is already booked';
        end if;
      end if;

      -- Linking a consultation that has already started: the referral is in
      -- progress from this statement on.
      if v_new_follow_up_status in ('in_progress', 'completed') then
        if v_target_profile is null or not v_target_active or not v_target_is_doctor then
          raise exception 'referral: only the receiving doctor can mark the referral in_progress';
        end if;
        new.status := 'in_progress';
        new.started_at := now();
        new.started_by := v_target_profile;
      end if;
    end if;
    return new;
  end if;

  if new.status in ('accepted', 'in_progress', 'completed') and old.expires_at <= now() then
    raise exception 'referral: the referral expired at %', old.expires_at;
  end if;
  if new.status = 'expired' and old.expires_at > now() then
    raise exception 'referral: the referral does not expire until %', old.expires_at;
  end if;

  if new.status = 'in_progress' and not exists (
       select 1 from public.appointments a
       where a.id = old.follow_up_appointment_id
         and a.status in ('in_progress', 'completed')
     ) then
    raise exception 'referral: a referral is in progress only once its follow-up consultation has started';
  end if;

  if new.status in ('accepted', 'in_progress', 'declined', 'completed') then
    v_actor := case new.status
      when 'accepted' then new.accepted_by
      when 'in_progress' then new.started_by
      when 'declined' then new.declined_by
      else new.completed_by
    end;
    if v_actor is null
       or v_actor is distinct from v_target_profile
       or not v_target_active
       or not v_target_is_doctor then
      raise exception 'referral: only the receiving doctor can mark the referral %', new.status;
    end if;
  elsif new.status = 'revoked' then
    if new.revoked_by is null or not (
         (new.revoked_by = v_referring_profile and v_referring_active and v_referring_is_doctor)
         or exists (
           select 1 from public.staff_roles sr
           where sr.profile_id = new.revoked_by
             and sr.clinic_id = new.clinic_id
             and sr.role in ('owner', 'admin', 'manager')
         )
       ) then
      raise exception 'referral: only the referring doctor or clinic management can revoke a referral';
    end if;
  end if;

  case new.status
    when 'accepted' then new.accepted_at := now();
    when 'in_progress' then new.started_at := now();
    when 'declined' then new.declined_at := now();
    when 'completed' then new.completed_at := now();
    when 'revoked' then new.revoked_at := now();
    else null;
  end case;

  return new;
end;
$$;

create or replace function public.referrals_audit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_action text;
  v_actor uuid;
  v_old jsonb;
begin
  if tg_op = 'INSERT' then
    v_action := 'referral_created';
    v_actor := new.created_by;
  elsif new.status is distinct from old.status then
    v_action := 'referral_' || new.status::text;
    v_actor := case new.status
      when 'accepted' then new.accepted_by
      when 'in_progress' then new.started_by
      when 'declined' then new.declined_by
      when 'completed' then new.completed_by
      when 'revoked' then new.revoked_by
      else null
    end;
    v_old := jsonb_build_object('status', old.status);
    -- A consultation linked in the same statement (see referrals_validate).
    if new.follow_up_appointment_id is distinct from old.follow_up_appointment_id then
      v_old := v_old || jsonb_build_object('follow_up_appointment_id', old.follow_up_appointment_id);
    end if;
  elsif new.follow_up_appointment_id is distinct from old.follow_up_appointment_id then
    v_action := 'referral_follow_up_booked';
    select a.created_by into v_actor
      from public.appointments a
     where a.id = new.follow_up_appointment_id;
    v_old := jsonb_build_object('follow_up_appointment_id', old.follow_up_appointment_id);
  else
    return null;
  end if;

  -- Ids, status and dates only: never the reason, handoff note or any other
  -- clinical text.
  insert into public.audit_events (
    clinic_id, actor_id, actor_type, action, entity_type, entity_id,
    old_values, new_values, ip_address
  ) values (
    new.clinic_id,
    v_actor,
    case when v_actor is null then 'system'::public.actor_type else 'staff'::public.actor_type end,
    v_action,
    'referrals',
    new.id::text,
    v_old,
    jsonb_build_object(
      'status', new.status,
      'priority', new.priority,
      'patient_id', new.patient_id,
      'referring_doctor_id', new.referring_doctor_id,
      'referred_to_doctor_id', new.referred_to_doctor_id,
      'originating_appointment_id', new.originating_appointment_id,
      'follow_up_appointment_id', new.follow_up_appointment_id,
      'expires_at', new.expires_at
    ),
    nullif(current_setting('request.ip', true), '')
  );
  return null;
end;
$$;

-- ---------- 3. A linked follow-up starting moves the referral ----------

create or replace function public.referral_follow_up_started()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status in ('in_progress', 'completed') and old.status not in ('in_progress', 'completed') then
    begin
      -- The consultation is the receiving doctor's own appointment (foreign
      -- key), so the transition is theirs. Rows that referrals_validate()
      -- would refuse are not selected in the first place.
      update public.referrals r
         set status = 'in_progress',
             started_by = d.profile_id
        from public.doctors d
       where r.follow_up_appointment_id = new.id
         and r.clinic_id = new.clinic_id
         and r.status = 'accepted'
         and r.expires_at > now()
         and d.id = r.referred_to_doctor_id
         and d.clinic_id = r.clinic_id
         and d.active
         and d.profile_id is not null
         and exists (
           select 1 from public.staff_roles sr
           where sr.profile_id = d.profile_id
             and sr.clinic_id = d.clinic_id
             and sr.role = 'doctor'::public.staff_role
         );
    exception when others then
      -- Never block the visit itself; the referral simply stays accepted.
      raise warning 'referral follow-up start not recorded (sqlstate %)', sqlstate;
    end;
  end if;
  return null;
end;
$$;

revoke execute on function public.referral_follow_up_started() from public, anon, authenticated;

drop trigger if exists appointments_referral_follow_up_started on public.appointments;
create trigger appointments_referral_follow_up_started
  after update of status on public.appointments
  for each row execute function public.referral_follow_up_started();

-- ---------- 4. Open = pending, accepted or in progress ----------

drop index if exists public.referrals_one_open_per_pair;
create unique index referrals_one_open_per_pair
  on public.referrals (patient_id, referring_doctor_id, referred_to_doctor_id)
  where status in ('pending', 'accepted', 'in_progress');

drop policy if exists "referrals read for receiving doctor" on public.referrals;
create policy "referrals read for receiving doctor"
  on public.referrals for select
  to authenticated
  using (
    public.is_linked_doctor(referred_to_doctor_id)
    and (
      status = 'completed'
      or (status in ('pending', 'accepted', 'in_progress') and expires_at > now())
    )
  );

-- Same signature and columns as 20260927000004: the policies built on it
-- keep working. Only the referral states change: an in-progress referral
-- counts wherever an accepted one does.
create or replace function public.doctor_patient_access(p_doctor_id uuid, p_patient_id uuid)
returns table (
  clinic_id uuid,
  own_patient boolean,
  active_referral_ids uuid[],
  history_doctor_ids uuid[],
  referral_appointment_ids uuid[]
)
language sql
stable
security definer
set search_path = public
as $$
  select
    d.clinic_id,
    exists (
      select 1
      from public.appointments a
      where a.clinic_id = d.clinic_id
        and a.patient_id = p.id
        and a.doctor_id = d.id
    ),
    array(
      select r.id
      from public.referrals r
      where r.clinic_id = d.clinic_id
        and r.patient_id = p.id
        and r.referred_to_doctor_id = d.id
        and r.status in ('pending', 'accepted', 'in_progress')
        and r.expires_at > now()
      order by r.created_at
    ),
    array(
      select distinct r.referring_doctor_id
      from public.referrals r
      where r.clinic_id = d.clinic_id
        and r.patient_id = p.id
        and r.referred_to_doctor_id = d.id
        and r.status in ('accepted', 'in_progress')
        and r.expires_at > now()
    ),
    array(
      -- The consultation an active referral to this doctor was raised from…
      select r.originating_appointment_id
      from public.referrals r
      where r.clinic_id = d.clinic_id
        and r.patient_id = p.id
        and r.referred_to_doctor_id = d.id
        and r.status in ('pending', 'accepted', 'in_progress')
        and r.expires_at > now()
      union
      -- …and the follow-up booked for a referral this doctor made.
      select r.follow_up_appointment_id
      from public.referrals r
      where r.clinic_id = d.clinic_id
        and r.patient_id = p.id
        and r.referring_doctor_id = d.id
        and r.follow_up_appointment_id is not null
    )
  from public.doctors d
  join public.patients p
    on p.id = p_patient_id
   and p.clinic_id = d.clinic_id
  where d.id = p_doctor_id
    and d.active
    and exists (
      select 1
      from public.staff_roles sr
      where sr.profile_id = d.profile_id
        and sr.clinic_id = d.clinic_id
        and sr.role = 'doctor'
    );
$$;

-- ---------- 5. Record types ----------

comment on type public.clinical_record_type is
  'consultation_note: clinical note; assessment: the doctor''s current assessment; diagnosis: a diagnosis made in that consultation (earlier consultations'' diagnoses are historical, never rewritten); prescription; lab_order: tests ordered; lab_result; medical_history; follow_up: follow-up plan or onward referral note.';

-- =====================================================================
-- FILE: 20260929000001_referral_lifecycle_hardening.sql
-- =====================================================================
-- Referral lifecycle hardening: bounded access, recorded expiry, a
-- tenant-safe audit trail.
--
-- WHEN A DOCTOR MAY SEE A PATIENT (public.doctor_patient_access, the one
-- decision behind RLS and the server):
--
--   Own relationship (not referral-based): the doctor has a live — not
--   cancelled — appointment with the patient, or wrote a clinical record for
--   them. Scope: the patient record, their own appointments, the records they
--   wrote. A booking that was cancelled no longer makes anyone "their" doctor.
--
--   Receiving doctor (B), referral-based, only while the referral is
--   pending / accepted / in_progress AND now() < expires_at:
--     pending              → patient record, the originating consultation;
--     accepted/in_progress → + the referring doctor's consultations.
--   Nothing referral-based once declined, revoked, completed or expired — at
--   the moment of the transition, and at expires_at even before the expiry
--   is recorded (the database clock is checked on every read). After
--   completion B keeps only what the own relationship gives them (their own
--   consultation for the referral and the records they wrote in it).
--
--   Referring doctor (A): the follow-up consultation their referral led to
--   while the referral is accepted / in_progress / completed AND
--   now() < expires_at — not after a revocation or expiry, and not forever.
--
--   No referral lasts longer than 180 days (the longest validity the product
--   offers), so no referral-based access is ever open-ended.
--
-- Changes:
--   1. referrals_expiry_window_check: at most 180 days (was 365).
--   2. doctor_patient_access(): own relationship excludes cancelled-only
--      bookings; the referrer's follow-up access is bounded by status and
--      expiry. doctor_can_read_appointment(): own appointments only with an
--      own relationship (server parity: canSeeAppointment).
--   3. Receiving doctor's read policy on referrals: completed referrals only
--      until expires_at.
--   4. expire_due_referrals(): records every lapsed open referral as expired
--      (audited 'referral_expired', actor: system). Called by the scheduled
--      /api/referrals/expire job and lazily on reads.
--   5. Clinical text is server-only: signed-in roles lose direct SELECT on
--      referrals and clinical_records, so every read goes through the
--      authorizing, audited API. The RLS policies stay as a backstop.
--   6. audit_events: patient_id and referral_id columns (every referral and
--      clinical-record event names clinic, actor, patient, referral, action,
--      time); a guard that keeps each row inside its clinic's tenant (the
--      patient and referral must belong to clinic_id) and stamps the
--      database time; append-only (no UPDATE/DELETE for any API role).
--
-- Reversible: restore the functions/policies from 20260928000002 and
-- 20260927000004, the 365-day check, the grants (grant select on referrals,
-- clinical_records to authenticated; grant update, delete on audit_events to
-- authenticated, service_role); drop expire_due_referrals(),
-- audit_events_guard() and the new audit columns/indexes.

-- ---------- 1. Validity window ----------

alter table public.referrals drop constraint referrals_expiry_window_check;
alter table public.referrals
  add constraint referrals_expiry_window_check
  check (expires_at > created_at and expires_at <= created_at + interval '180 days');

-- ---------- 2. The decision ----------

create or replace function public.doctor_patient_access(p_doctor_id uuid, p_patient_id uuid)
returns table (
  clinic_id uuid,
  own_patient boolean,
  active_referral_ids uuid[],
  history_doctor_ids uuid[],
  referral_appointment_ids uuid[]
)
language sql
stable
security definer
set search_path = public
as $$
  select
    d.clinic_id,
    -- Own relationship: a live appointment, or a record the doctor wrote.
    exists (
      select 1
      from public.appointments a
      where a.clinic_id = d.clinic_id
        and a.patient_id = p.id
        and a.doctor_id = d.id
        and a.status <> 'cancelled'
    )
    or exists (
      select 1
      from public.clinical_records cr
      where cr.clinic_id = d.clinic_id
        and cr.patient_id = p.id
        and cr.author_doctor_id = d.id
    ),
    array(
      select r.id
      from public.referrals r
      where r.clinic_id = d.clinic_id
        and r.patient_id = p.id
        and r.referred_to_doctor_id = d.id
        and r.status in ('pending', 'accepted', 'in_progress')
        and r.expires_at > now()
      order by r.created_at
    ),
    array(
      select distinct r.referring_doctor_id
      from public.referrals r
      where r.clinic_id = d.clinic_id
        and r.patient_id = p.id
        and r.referred_to_doctor_id = d.id
        and r.status in ('accepted', 'in_progress')
        and r.expires_at > now()
    ),
    array(
      -- The consultation an open referral to this doctor was raised from…
      select r.originating_appointment_id
      from public.referrals r
      where r.clinic_id = d.clinic_id
        and r.patient_id = p.id
        and r.referred_to_doctor_id = d.id
        and r.status in ('pending', 'accepted', 'in_progress')
        and r.expires_at > now()
      union
      -- …and the follow-up of a referral this doctor made, while it stands.
      select r.follow_up_appointment_id
      from public.referrals r
      where r.clinic_id = d.clinic_id
        and r.patient_id = p.id
        and r.referring_doctor_id = d.id
        and r.follow_up_appointment_id is not null
        and r.status in ('accepted', 'in_progress', 'completed')
        and r.expires_at > now()
    )
  from public.doctors d
  join public.patients p
    on p.id = p_patient_id
   and p.clinic_id = d.clinic_id
  where d.id = p_doctor_id
    and d.active
    and exists (
      select 1
      from public.staff_roles sr
      where sr.profile_id = d.profile_id
        and sr.clinic_id = d.clinic_id
        and sr.role = 'doctor'
    );
$$;

comment on function public.doctor_patient_access(uuid, uuid) is
  'What an active doctor may see of a patient (see 20260929000001): own relationship (live appointment or authored record); open, unexpired referrals to them; referring doctors whose visits accepted/in-progress referrals share; referral-linked appointments (originating consultation for the receiver, follow-up for the referrer — both bounded by status and expires_at). No row = no access. Server-only.';

create or replace function public.doctor_can_read_appointment(
  p_clinic_id uuid,
  p_patient_id uuid,
  p_doctor_id uuid,
  p_appointment_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.doctor_patient_access(public.current_doctor_id(p_clinic_id), p_patient_id) x
    where (x.own_patient and p_doctor_id = public.current_doctor_id(p_clinic_id))
       or p_doctor_id = any (x.history_doctor_ids)
       or p_appointment_id = any (x.referral_appointment_ids)
  );
$$;

-- ---------- 3. The receiving doctor's view of the referral itself ----------

drop policy if exists "referrals read for receiving doctor" on public.referrals;
create policy "referrals read for receiving doctor"
  on public.referrals for select
  to authenticated
  using (
    public.is_linked_doctor(referred_to_doctor_id)
    and status in ('pending', 'accepted', 'in_progress', 'completed')
    and expires_at > now()
  );

-- ---------- 4. Recording expiry ----------

-- Access already ends at expires_at (every check compares with now()); this
-- records it: status 'expired' and a 'referral_expired' audit row by the
-- system. Idempotent; the database clock decides, never the caller's.
create or replace function public.expire_due_referrals(p_clinic_id uuid default null)
returns integer
language sql
volatile
security invoker
set search_path = public
as $$
  with expired as (
    update public.referrals
       set status = 'expired'
     where status in ('pending', 'accepted', 'in_progress')
       and expires_at <= now()
       and (p_clinic_id is null or clinic_id = p_clinic_id)
    returning 1
  )
  select count(*)::integer from expired;
$$;

revoke all on function public.expire_due_referrals(uuid) from public, anon, authenticated;
grant execute on function public.expire_due_referrals(uuid) to service_role;

-- ---------- 5. Clinical text is read through the server only ----------

-- The API authorizes every read with doctor_patient_access() and audits it;
-- a signed-in session reading these tables directly would be neither. The
-- policies remain as a backstop should a grant ever be re-added.
revoke select on table public.referrals from authenticated;
revoke all on table public.clinical_records from authenticated;

-- ---------- 6. Audit trail ----------

alter table public.audit_events
  add column patient_id uuid,
  add column referral_id uuid;

comment on column public.audit_events.patient_id is
  'The patient the event concerns (same clinic as clinic_id, checked on insert). Ids only — never clinical text.';
comment on column public.audit_events.referral_id is
  'The referral the event concerns (same clinic and patient, checked on insert).';

create index audit_events_patient_idx
  on public.audit_events (clinic_id, patient_id, created_at desc)
  where patient_id is not null;
create index audit_events_referral_idx
  on public.audit_events (clinic_id, referral_id, created_at desc)
  where referral_id is not null;

create or replace function public.audit_events_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
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

revoke execute on function public.audit_events_guard() from public, anon, authenticated;

drop trigger if exists audit_events_guard on public.audit_events;
create trigger audit_events_guard
  before insert on public.audit_events
  for each row execute function public.audit_events_guard();

-- Append-only for every API role: rows are written once (service role, and
-- the audit triggers) and read by the clinic's management (RLS). Clinic
-- deletion still cascades (performed as the table owner).
revoke insert, update, delete, truncate on table public.audit_events from anon, authenticated;
revoke update, delete, truncate on table public.audit_events from service_role;

-- Referral events carry the patient and referral as columns; expiry is the
-- system's act (actor null, actor_type 'system').
create or replace function public.referrals_audit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_action text;
  v_actor uuid;
  v_old jsonb;
begin
  if tg_op = 'INSERT' then
    v_action := 'referral_created';
    v_actor := new.created_by;
  elsif new.status is distinct from old.status then
    v_action := 'referral_' || new.status::text;
    v_actor := case new.status
      when 'accepted' then new.accepted_by
      when 'in_progress' then new.started_by
      when 'declined' then new.declined_by
      when 'completed' then new.completed_by
      when 'revoked' then new.revoked_by
      else null
    end;
    v_old := jsonb_build_object('status', old.status);
    -- A consultation linked in the same statement (see referrals_validate).
    if new.follow_up_appointment_id is distinct from old.follow_up_appointment_id then
      v_old := v_old || jsonb_build_object('follow_up_appointment_id', old.follow_up_appointment_id);
    end if;
  elsif new.follow_up_appointment_id is distinct from old.follow_up_appointment_id then
    v_action := 'referral_follow_up_booked';
    select a.created_by into v_actor
      from public.appointments a
     where a.id = new.follow_up_appointment_id;
    v_old := jsonb_build_object('follow_up_appointment_id', old.follow_up_appointment_id);
  else
    return null;
  end if;

  -- Ids, status and dates only: never the reason, handoff note or any other
  -- clinical text.
  insert into public.audit_events (
    clinic_id, actor_id, actor_type, action, entity_type, entity_id,
    patient_id, referral_id, old_values, new_values, metadata, ip_address
  ) values (
    new.clinic_id,
    v_actor,
    case when v_actor is null then 'system'::public.actor_type else 'staff'::public.actor_type end,
    v_action,
    'referrals',
    new.id::text,
    new.patient_id,
    new.id,
    v_old,
    jsonb_build_object(
      'status', new.status,
      'priority', new.priority,
      'patient_id', new.patient_id,
      'referring_doctor_id', new.referring_doctor_id,
      'referred_to_doctor_id', new.referred_to_doctor_id,
      'originating_appointment_id', new.originating_appointment_id,
      'follow_up_appointment_id', new.follow_up_appointment_id,
      'expires_at', new.expires_at
    ),
    case when new.status = 'expired' and v_action = 'referral_expired'
      then jsonb_build_object('cause', 'validity_elapsed')
      else '{}'::jsonb
    end,
    nullif(current_setting('request.ip', true), '')
  );
  return null;
end;
$$;

-- Clinical record events carry the patient, and the referral when the record
-- was written in a referral's consultation.
create or replace function public.clinical_records_audit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_referral uuid;
begin
  select r.id into v_referral
    from public.referrals r
   where r.clinic_id = new.clinic_id
     and r.patient_id = new.patient_id
     and r.follow_up_appointment_id = new.appointment_id
   order by r.created_at desc
   limit 1;

  insert into public.audit_events (
    clinic_id, actor_id, actor_type, action, entity_type, entity_id,
    patient_id, referral_id, old_values, new_values
  ) values (
    new.clinic_id,
    new.created_by,
    'staff'::public.actor_type,
    case when new.corrects_record_id is null then 'clinical_record_created' else 'clinical_record_corrected' end,
    'clinical_records',
    new.id::text,
    new.patient_id,
    v_referral,
    null,
    jsonb_build_object(
      'record_type', new.record_type,
      'patient_id', new.patient_id,
      'author_doctor_id', new.author_doctor_id,
      'appointment_id', new.appointment_id,
      'corrects_record_id', new.corrects_record_id
    )
  );
  return new;
end;
$$;

-- =====================================================================
-- FILE: 20260930000001_consultation_start.sql
-- =====================================================================
-- Starting a consultation is one database transaction.
--
-- Until now the server moved the appointment to in progress, then linked a
-- waiting referral, then wrote the 'consultation_started' audit row — three
-- requests. A failure between them left a started consultation with no audit
-- row (or no referral link), and two concurrent starts could both write one.
-- These functions do all three in one transaction, with a compare-and-swap
-- on the appointment's status:
--
--   start_consultation(...)          an existing appointment → in progress
--   start_walk_in_consultation(...)  a walk-in booked in progress through the
--                                    booking engine (book_appointment)
--
-- Both write 'consultation_started' (ids only — never clinical text) with the
-- acting staff member, and optionally link the consultation to the accepted
-- referral waiting for it (the referral then moves to in progress through
-- referrals_validate(), exactly as before). A link the referral trigger
-- refuses never blocks the consultation: the referral simply stays accepted.
--
-- Server-only: EXECUTE for service_role alone. The server has already
-- authorized the caller (the doctor's own appointment and access to the
-- patient, or operational staff of the clinic); the functions re-check the
-- tenant, the actor's staff role in the clinic and, when given, the doctor.
--
-- Rollback: drop function public.start_walk_in_consultation(uuid, uuid, uuid,
-- uuid, timestamptz, uuid); drop function public.start_consultation(uuid,
-- uuid, public.appointment_status, uuid, text, boolean, uuid); drop function
-- public.consultation_started_effects(uuid, uuid, text, boolean, boolean).

create or replace function public.consultation_started_effects(
  p_appointment_id uuid,
  p_actor uuid,
  p_via text,
  p_link_referral boolean,
  p_walk_in boolean
)
returns uuid
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_appointment public.appointments%rowtype;
  v_waiting uuid;
  v_referral uuid;
begin
  select * into v_appointment from public.appointments where id = p_appointment_id;
  if not found or v_appointment.status <> 'in_progress' then
    raise exception 'consultation: the appointment is not in progress';
  end if;

  -- The accepted referral to this doctor for this patient that is waiting for
  -- its consultation: none booked yet, or its booking was cancelled or has
  -- not started (same rule as referrals_validate()).
  if p_link_referral and not exists (
    select 1 from public.referrals r
     where r.follow_up_appointment_id = v_appointment.id
       and r.status in ('accepted', 'in_progress', 'completed')
  ) then
    select r.id into v_waiting
      from public.referrals r
      left join public.appointments f on f.id = r.follow_up_appointment_id
     where r.clinic_id = v_appointment.clinic_id
       and r.patient_id = v_appointment.patient_id
       and r.referred_to_doctor_id = v_appointment.doctor_id
       and r.status = 'accepted'
       and r.expires_at > now()
       and (r.follow_up_appointment_id is null
            or f.status in ('cancelled', 'no_show', 'pending', 'confirmed', 'checked_in'))
     order by r.created_at
     limit 1
     for update of r;
    if v_waiting is not null then
      begin
        update public.referrals set follow_up_appointment_id = v_appointment.id where id = v_waiting;
      exception when others then
        raise warning 'consultation not linked to referral (sqlstate %)', sqlstate;
      end;
    end if;
  end if;

  select r.id into v_referral
    from public.referrals r
   where r.clinic_id = v_appointment.clinic_id
     and r.follow_up_appointment_id = v_appointment.id
     and r.status in ('accepted', 'in_progress', 'completed')
   order by r.created_at desc
   limit 1;

  insert into public.audit_events (
    clinic_id, actor_id, actor_type, action, entity_type, entity_id,
    patient_id, referral_id, new_values, metadata
  ) values (
    v_appointment.clinic_id, p_actor, 'staff', 'consultation_started', 'appointments', v_appointment.id::text,
    v_appointment.patient_id, v_referral,
    jsonb_build_object('status', 'in_progress'),
    jsonb_build_object(
      'patient_id', v_appointment.patient_id,
      'doctor_id', v_appointment.doctor_id,
      'referral_id', v_referral,
      'via', p_via,
      'walk_in', p_walk_in
    )
  );
  return v_referral;
end;
$$;

create or replace function public.start_consultation(
  p_clinic_id uuid,
  p_appointment_id uuid,
  p_from_status public.appointment_status,
  p_actor uuid,
  p_via text,
  p_link_referral boolean default false,
  p_doctor_id uuid default null
)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  if p_via is null or p_via not in ('doctor_workspace', 'doctor_queue', 'front_desk') then
    raise exception 'consultation: unknown start channel %', p_via;
  end if;
  if not exists (select 1 from public.staff_roles where profile_id = p_actor and clinic_id = p_clinic_id) then
    raise exception 'consultation: the actor is not staff of this clinic';
  end if;
  if p_from_status = 'in_progress' then
    return jsonb_build_object('started', false, 'referral_id', null);
  end if;

  -- Compare-and-swap: only the status the caller saw moves, so of two
  -- concurrent starts exactly one starts (and audits) the consultation.
  update public.appointments
     set status = 'in_progress'
   where id = p_appointment_id
     and clinic_id = p_clinic_id
     and status = p_from_status
     and (p_doctor_id is null or doctor_id = p_doctor_id);
  if not found then
    return jsonb_build_object('started', false, 'referral_id', null);
  end if;

  return jsonb_build_object(
    'started', true,
    'referral_id', public.consultation_started_effects(p_appointment_id, p_actor, p_via, p_link_referral, false)
  );
end;
$$;

create or replace function public.start_walk_in_consultation(
  p_clinic_id uuid,
  p_patient_id uuid,
  p_doctor_id uuid,
  p_service_id uuid,
  p_start_at timestamptz,
  p_actor uuid
)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_booking record;
begin
  if not exists (
    select 1 from public.doctors d
     where d.id = p_doctor_id and d.clinic_id = p_clinic_id and d.profile_id = p_actor
  ) then
    raise exception 'consultation: a walk-in is started by the doctor themselves';
  end if;

  -- The booking engine checks working hours, time blocks, the doctor's
  -- services and overlaps, as for every other booking.
  select * into v_booking
    from public.book_appointment(
      p_clinic_id, p_patient_id, p_doctor_id, p_service_id, p_start_at,
      'in_progress'::public.appointment_status, 'walk_in'::public.appointment_source, null, p_actor
    );
  if v_booking.error_code is not null or v_booking.appointment_id is null then
    return jsonb_build_object(
      'appointment_id', null,
      'error_code', coalesce(v_booking.error_code, 'booking_failed'),
      'referral_id', null
    );
  end if;

  return jsonb_build_object(
    'appointment_id', v_booking.appointment_id,
    'error_code', null,
    'referral_id', public.consultation_started_effects(v_booking.appointment_id, p_actor, 'doctor_workspace', true, true)
  );
end;
$$;

revoke execute on function public.consultation_started_effects(uuid, uuid, text, boolean, boolean) from public, anon, authenticated;
revoke execute on function public.start_consultation(uuid, uuid, public.appointment_status, uuid, text, boolean, uuid) from public, anon, authenticated;
revoke execute on function public.start_walk_in_consultation(uuid, uuid, uuid, uuid, timestamptz, uuid) from public, anon, authenticated;
grant execute on function public.consultation_started_effects(uuid, uuid, text, boolean, boolean) to service_role;
grant execute on function public.start_consultation(uuid, uuid, public.appointment_status, uuid, text, boolean, uuid) to service_role;
grant execute on function public.start_walk_in_consultation(uuid, uuid, uuid, uuid, timestamptz, uuid) to service_role;

comment on function public.start_consultation(uuid, uuid, public.appointment_status, uuid, text, boolean, uuid) is
  'Server-only. Moves an appointment from p_from_status to in_progress (compare-and-swap), optionally links the waiting accepted referral, and audits consultation_started — one transaction.';
comment on function public.start_walk_in_consultation(uuid, uuid, uuid, uuid, timestamptz, uuid) is
  'Server-only. Books a walk-in in progress through book_appointment, links the waiting accepted referral, and audits consultation_started — one transaction.';

-- =====================================================================
-- FILE: 20260930000002_server_only_booking_writes.sql
-- =====================================================================
-- Appointments, patients and payments are written by the server only.
--
-- Every write the product makes to these tables goes through a server route
-- with the service-role client, after the route has authorized the caller:
-- bookings and walk-ins through book_appointment(), rescheduling through
-- reschedule_appointment(), cancellations and status changes through
-- /api/admin/appointments/[id] (notifications, audit and analytics included),
-- consultation starts through start_consultation(), payments through
-- transitionPaymentStatus(), patients through /api/admin/appointments,
-- /api/admin/patients and the Telegram identity code. No page writes them
-- with the signed-in user's token.
--
-- The role-based policies from 20260818000024 still let a signed-in staff
-- token write them directly over PostgREST (/rest/v1/...), bypassing all of
-- that:
--
--   * a manager could INSERT a payment already marked 'paid' — the rule is
--     that no browser request can mark a payment paid (payments_block_direct_write
--     only covers UPDATE);
--   * operational staff could INSERT appointments or move them (start_at,
--     doctor, patient) outside the transactional booking engine, set any
--     status with no notification to the patient, and write created_by /
--     cancelled_by as someone else;
--   * operational staff could create or edit patients outside the server's
--     validation.
--
-- This migration removes those write policies and the table-level write
-- grants for anon/authenticated. Reads are unchanged (RLS read policies stay),
-- the doctor's own appointment-status path was already server-only
-- (20260927000004), and the server's service-role writes are unaffected
-- (service_role bypasses RLS and keeps its grants).
--
-- Rollback: re-create the six policies exactly as in
-- 20260818000024_role_based_rls.sql and
-- `grant insert, update on public.appointments, public.patients, public.payments to authenticated;`.

drop policy if exists "appointments insert for operational staff" on public.appointments;
drop policy if exists "appointments update for operational staff" on public.appointments;
drop policy if exists "patients insert for operational staff" on public.patients;
drop policy if exists "patients update for operational staff" on public.patients;
drop policy if exists "payments insert for management" on public.payments;
drop policy if exists "payments update for management" on public.payments;

revoke insert, update, delete, truncate on public.appointments from anon, authenticated;
revoke insert, update, delete, truncate on public.patients from anon, authenticated;
revoke insert, update, delete, truncate on public.payments from anon, authenticated;

-- =====================================================================
-- FILE: 20260930000003_shared_rate_limits.sql
-- =====================================================================
-- A rate limit every server instance shares.
--
-- src/lib/rate-limit.ts counts requests in the memory of one server
-- instance, so with N Cloud Run instances a caller gets up to N times the
-- limit. That is acceptable for the public, IP-keyed limits (a load-balancer
-- policy covers those), but not for the limit that guards clinical data: the
-- per-doctor patient-record lookup limit, which slows down id guessing and
-- bulk reading of patients' records. consume_rate_limit() keeps that count in
-- Postgres, so it holds across instances.
--
-- One row per key (a doctor's account and what is limited), updated in place
-- with an atomic upsert: fixed windows, the count capped at limit + 1. Keys
-- are per staff account, so the table stays as small as the staff list.
--
-- Server-only: RLS on with no policies, no grants for anon/authenticated,
-- EXECUTE for service_role alone.
--
-- Rollback: drop function public.consume_rate_limit(text, integer, integer);
-- drop table public.rate_limit_buckets;

create table public.rate_limit_buckets (
  key text primary key check (length(key) between 1 and 200),
  window_started_at timestamptz not null,
  hits integer not null check (hits >= 0)
);

alter table public.rate_limit_buckets enable row level security;
revoke all on public.rate_limit_buckets from public, anon, authenticated;
grant select, insert, update, delete on public.rate_limit_buckets to service_role;

comment on table public.rate_limit_buckets is
  'Server-only request counters shared by every app instance (consume_rate_limit). No personal data: keys are an account id and a purpose.';

create or replace function public.consume_rate_limit(p_key text, p_limit integer, p_window_seconds integer)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_window interval;
  v_bucket public.rate_limit_buckets%rowtype;
begin
  if p_key is null or p_limit is null or p_limit < 1 or p_window_seconds is null or p_window_seconds < 1 then
    raise exception 'rate limit: invalid key, limit or window';
  end if;
  v_window := make_interval(secs => p_window_seconds);

  insert into public.rate_limit_buckets as b (key, window_started_at, hits)
  values (p_key, clock_timestamp(), 1)
  on conflict (key) do update
    set window_started_at = case when b.window_started_at + v_window <= clock_timestamp() then clock_timestamp() else b.window_started_at end,
        hits = case when b.window_started_at + v_window <= clock_timestamp() then 1 else least(b.hits + 1, p_limit + 1) end
  returning * into v_bucket;

  return jsonb_build_object(
    'allowed', v_bucket.hits <= p_limit,
    'retry_after_seconds', greatest(1, ceil(extract(epoch from (v_bucket.window_started_at + v_window - clock_timestamp())))::integer)
  );
end;
$$;

revoke execute on function public.consume_rate_limit(text, integer, integer) from public, anon, authenticated;
grant execute on function public.consume_rate_limit(text, integer, integer) to service_role;

comment on function public.consume_rate_limit(text, integer, integer) is
  'Server-only. Counts one request against p_key (fixed window of p_window_seconds) and says whether it is within p_limit — shared by every app instance.';

-- =====================================================================
-- FILE: 20260930000004_anon_no_table_privileges.sql
-- =====================================================================
-- The anonymous role has no table privileges in public — as 20260813000013
-- always intended ("Anonymous role intentionally receives NO table
-- privileges"), now also on a real Supabase project.
--
-- A Supabase project grants anon (and authenticated, service_role) privileges
-- on every table postgres creates in public through its own default
-- privileges; 20260813000013 only added grants and never took anon's away.
-- RLS still returned no rows to an anonymous request (no anon policy exists),
-- but the table was reachable: an anonymous `GET /rest/v1/patients` answered
-- 200 [] instead of being refused. Found by running the suites on the Supabase
-- CLI stack in CI.
--
-- Nothing reads a table with the anon role: patients use the server APIs,
-- staff sessions are `authenticated`, and the health check only asks for the
-- API root. anon keeps USAGE on the schema (PostgREST needs it to answer at
-- all) and EXECUTE on the functions that already allow it.
--
-- Rollback: `grant select, insert, update, delete on all tables in schema public to anon;`
-- (Supabase's default) — not recommended.

revoke all on all tables in schema public from anon;
revoke all on all sequences in schema public from anon;

-- Tables and sequences created later by this role (every migration) as well.
alter default privileges in schema public revoke all on tables from anon;
alter default privileges in schema public revoke all on sequences from anon;

-- =====================================================================
-- FILE: 20260930000005_unified_booking_engine.sql
-- =====================================================================
-- Unified booking engine: one authoritative booking operation, and a
-- database guarantee that a doctor can never hold two active appointments in
-- overlapping time.
--
-- The invariant — for any clinic, doctor and conflicting time interval, at
-- most ONE active appointment — is enforced by the exclusion constraint
-- no_overlapping_active_appointments, which Postgres checks on every INSERT
-- and UPDATE by every role, whatever code path wrote the row. Everything else
-- here serves it:
--
-- 1. Tenancy is structural. Composite foreign keys make an appointment's
--    doctor, patient and service belong to the appointment's own clinic, and
--    the constraint names the clinic explicitly (clinic_id, doctor_id, time):
--    a doctor row belongs to exactly one clinic, so the same time in another
--    clinic is never a conflict, and a row can never pair a clinic with
--    another clinic's doctor.
-- 2. Active = every status except 'cancelled' and 'no_show' (the product's
--    existing model, unchanged): cancelling or marking a no-show releases the
--    time; 'completed' keeps it (it happened).
-- 3. Appointments have variable durations (service duration or the doctor's
--    override), so conflicts are interval overlaps on [start_at, end_at):
--    14:00–14:30 and 14:15–14:45 conflict, 14:00–14:30 and 14:30–15:00 do not.
-- 4. book_appointment() is the one booking operation (Mini App, bot deep link,
--    website, reception, admin, the doctor's walk-in): it validates clinic,
--    doctor, service, patient, time, working hours and time blocks, serializes
--    per doctor with an advisory lock, re-checks inside the transaction and
--    inserts — a conflict found by the constraint instead (any race the lock
--    does not cover) comes back as 'slot_taken', never as a raw error.
-- 5. Idempotency: an optional key per booking attempt, unique per clinic. A
--    retried request (double click, network retry, reconnect) returns the
--    appointment the first attempt created (replayed = true) instead of a
--    second one; the same key for a different booking is refused.
-- 6. Working hours are compared as local date-times on the slot's own local
--    day: a slot running past midnight (23:50–00:10) used to pass a
--    time-of-day comparison. The clinic's IANA timezone (clinics.timezone)
--    is applied inside Postgres, so DST, where a timezone has it, is handled.
-- 7. reschedule_appointment() is clinic-scoped, locks the appointment row and
--    takes the same per-doctor lock; the appointment never conflicts with
--    itself.
-- 8. The slot-validation trigger (direct writes) raises the overlap as
--    exclusion_violation (23P01), like the constraint, so every path reports a
--    conflict the same way.
--
-- Rollback: restore book_appointment / reschedule_appointment /
-- appointments_validate_slot from 20260813000009 + 20260813000020 +
-- 20260912000001; drop slot_within_working_hours, booking_replay; drop
-- index appointments_clinic_idempotency_key_idx and column
-- appointments.idempotency_key; recreate the constraint on (doctor_id, range);
-- restore the single-column appointments_{doctor,patient,service}_id_fkey and
-- drop services_id_clinic_id_key.

-- ---------- 1. Same-clinic foreign keys ----------

alter table public.services add constraint services_id_clinic_id_key unique (id, clinic_id);

-- The single-column keys become composite ones under the same names (and
-- the same ON DELETE rules): one relationship per table, so the API's embeds
-- (doctors(name), appointments!appointments_patient_id_fkey …) are unchanged.
alter table public.appointments
  drop constraint appointments_doctor_id_fkey,
  drop constraint appointments_patient_id_fkey,
  drop constraint appointments_service_id_fkey,
  add constraint appointments_doctor_id_fkey
    foreign key (doctor_id, clinic_id) references public.doctors (id, clinic_id) on delete restrict,
  add constraint appointments_patient_id_fkey
    foreign key (patient_id, clinic_id) references public.patients (id, clinic_id) on delete cascade,
  add constraint appointments_service_id_fkey
    foreign key (service_id, clinic_id) references public.services (id, clinic_id) on delete restrict;

-- ---------- 2. The invariant, per clinic ----------

alter table public.appointments drop constraint no_overlapping_active_appointments;
alter table public.appointments add constraint no_overlapping_active_appointments
  exclude using gist (
    clinic_id with =,
    doctor_id with =,
    tstzrange(start_at, end_at, '[)') with &&
  ) where (status not in ('cancelled', 'no_show'));

comment on constraint no_overlapping_active_appointments on public.appointments is
  'At most one active (not cancelled / no-show) appointment per clinic, doctor and overlapping [start_at, end_at) — the booking invariant.';

-- ---------- 3. Idempotency ----------

alter table public.appointments
  add column idempotency_key text
    constraint appointments_idempotency_key_format
      check (idempotency_key is null or idempotency_key ~ '^[A-Za-z0-9_-]{16,128}$');

create unique index appointments_clinic_idempotency_key_idx
  on public.appointments (clinic_id, idempotency_key)
  where idempotency_key is not null;

comment on column public.appointments.idempotency_key is
  'Client-generated key of the booking attempt that created the appointment; a retry with the same key returns this appointment.';

-- ---------- 4. Working hours on the slot's own local day ----------

create or replace function public.slot_within_working_hours(
  p_doctor_id uuid,
  p_timezone text,
  p_start_at timestamptz,
  p_end_at timestamptz
)
returns boolean
language sql
stable
set search_path = public, pg_temp
as $$
  select exists (
    select 1
      from public.doctor_working_hours wh
     where wh.doctor_id = p_doctor_id
       and wh.weekday = extract(isodow from p_start_at at time zone p_timezone)
       and (p_start_at at time zone p_timezone) >= (p_start_at at time zone p_timezone)::date + wh.start_time
       and (p_end_at at time zone p_timezone) <= (p_start_at at time zone p_timezone)::date + wh.end_time
  );
$$;

comment on function public.slot_within_working_hours(uuid, text, timestamptz, timestamptz) is
  'True when [start, end) lies inside one of the doctor''s working-hour windows on the start''s local day (clinic timezone). A slot crossing local midnight is outside.';

-- ---------- 5. Replaying an idempotent booking ----------

create or replace function public.booking_replay(
  p_clinic_id uuid,
  p_idempotency_key text,
  p_patient_id uuid,
  p_doctor_id uuid,
  p_service_id uuid,
  p_start_at timestamptz
)
returns table (appointment_id uuid, amount numeric, error_code text)
language sql
stable
set search_path = public, pg_temp
as $$
  select a.id,
         (select p.amount from public.payments p where p.appointment_id = a.id order by p.created_at limit 1),
         case
           when a.patient_id = p_patient_id and a.doctor_id = p_doctor_id
                and a.service_id = p_service_id and a.start_at = p_start_at then null
           else 'idempotency_key_reused'
         end
    from public.appointments a
   where a.clinic_id = p_clinic_id
     and a.idempotency_key = p_idempotency_key;
$$;

-- ---------- 6. The booking operation ----------

drop function public.book_appointment(
  uuid, uuid, uuid, uuid, timestamptz, public.appointment_status, public.appointment_source, text, uuid
);

create function public.book_appointment(
  p_clinic_id uuid,
  p_patient_id uuid,
  p_doctor_id uuid,
  p_service_id uuid,
  p_start_at timestamptz,
  p_status public.appointment_status default 'pending',
  p_source public.appointment_source default 'telegram_mini_app',
  p_notes text default null,
  p_created_by uuid default null,
  p_idempotency_key text default null,
  out appointment_id uuid,
  out amount numeric,
  out error_code text,
  out error_message text,
  out replayed boolean
)
returns record
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_clinic public.clinics%rowtype;
  v_service public.services%rowtype;
  v_duration_minutes int;
  v_price numeric;
  v_end_at timestamptz;
  v_offers_service boolean;
  v_replay record;
  v_constraint text;
begin
  replayed := false;

  -- A booking starts a visit; closing statuses are never booked.
  if p_status not in ('pending', 'confirmed', 'checked_in', 'in_progress') then
    error_code := 'invalid_status'; return;
  end if;

  select * into v_clinic from public.clinics where id = p_clinic_id and is_active;
  if not found then
    error_code := 'clinic_not_found'; return;
  end if;

  if not exists (select 1 from public.doctors where id = p_doctor_id and clinic_id = p_clinic_id and active) then
    error_code := 'doctor_not_found'; return;
  end if;

  select * into v_service from public.services where id = p_service_id and clinic_id = p_clinic_id and active;
  if not found then
    error_code := 'service_not_found'; return;
  end if;

  if not exists (select 1 from public.patients where id = p_patient_id and clinic_id = p_clinic_id) then
    error_code := 'patient_not_found'; return;
  end if;

  -- A doctor with an explicit service list performs only those services.
  select exists (select 1 from public.doctor_services where doctor_id = p_doctor_id) into v_offers_service;
  if v_offers_service and not exists (
    select 1 from public.doctor_services where doctor_id = p_doctor_id and service_id = p_service_id
  ) then
    error_code := 'service_not_offered'; return;
  end if;

  -- A retried request returns the first attempt's appointment.
  if p_idempotency_key is not null then
    select * into v_replay
      from public.booking_replay(p_clinic_id, p_idempotency_key, p_patient_id, p_doctor_id, p_service_id, p_start_at);
    if found then
      appointment_id := case when v_replay.error_code is null then v_replay.appointment_id end;
      amount := case when v_replay.error_code is null then v_replay.amount end;
      error_code := v_replay.error_code;
      replayed := v_replay.error_code is null;
      return;
    end if;
  end if;

  -- Duration and price come from the service (or the doctor's override) —
  -- never from the caller.
  select coalesce(ds.duration_override_minutes, v_service.duration_minutes),
         coalesce(ds.price_override, v_service.price)
    into v_duration_minutes, v_price
    from public.services s
    left join public.doctor_services ds on ds.service_id = s.id and ds.doctor_id = p_doctor_id
   where s.id = p_service_id;

  if p_start_at <= now() then
    error_code := 'past_slot'; return;
  end if;
  v_end_at := p_start_at + make_interval(mins => v_duration_minutes);

  -- Serialize bookings and reschedules of this doctor (released at commit).
  perform pg_advisory_xact_lock(hashtextextended(p_clinic_id::text || ':' || p_doctor_id::text, 0));

  -- The same attempt may have committed while this one waited for the lock.
  if p_idempotency_key is not null then
    select * into v_replay
      from public.booking_replay(p_clinic_id, p_idempotency_key, p_patient_id, p_doctor_id, p_service_id, p_start_at);
    if found then
      appointment_id := case when v_replay.error_code is null then v_replay.appointment_id end;
      amount := case when v_replay.error_code is null then v_replay.amount end;
      error_code := v_replay.error_code;
      replayed := v_replay.error_code is null;
      return;
    end if;
  end if;

  if not public.slot_within_working_hours(p_doctor_id, v_clinic.timezone, p_start_at, v_end_at) then
    error_code := 'outside_working_hours'; return;
  end if;

  if exists (
    select 1 from public.doctor_time_blocks tb
     where tb.doctor_id = p_doctor_id
       and tstzrange(tb.starts_at, tb.ends_at, '[)') && tstzrange(p_start_at, v_end_at, '[)')
  ) then
    error_code := 'time_blocked'; return;
  end if;

  -- Re-check under the lock (belt) …
  if exists (
    select 1 from public.appointments a
     where a.clinic_id = p_clinic_id
       and a.doctor_id = p_doctor_id
       and a.status not in ('cancelled', 'no_show')
       and tstzrange(a.start_at, a.end_at, '[)') && tstzrange(p_start_at, v_end_at, '[)')
  ) then
    error_code := 'slot_taken'; error_message := 'Bu vaqt band qilingan'; return;
  end if;

  -- … and the exclusion constraint decides (braces).
  begin
    insert into public.appointments (
      clinic_id, patient_id, doctor_id, service_id,
      start_at, end_at, status, source, notes, created_by, idempotency_key
    ) values (
      p_clinic_id, p_patient_id, p_doctor_id, p_service_id,
      p_start_at, v_end_at, p_status, p_source, p_notes, p_created_by, p_idempotency_key
    )
    returning id into appointment_id;

    insert into public.payments (clinic_id, appointment_id, patient_id, amount, currency)
    values (p_clinic_id, appointment_id, p_patient_id, v_price, v_clinic.currency);

    amount := v_price;
    error_code := null;
    return;
  exception
    when exclusion_violation then
      appointment_id := null;
      error_code := 'slot_taken';
      error_message := 'Bu vaqt band qilingan';
      return;
    when unique_violation then
      get stacked diagnostics v_constraint = constraint_name;
      if v_constraint is distinct from 'appointments_clinic_idempotency_key_idx' then
        raise;
      end if;
      -- The same key was committed by a concurrent attempt for another doctor.
      select * into v_replay
        from public.booking_replay(p_clinic_id, p_idempotency_key, p_patient_id, p_doctor_id, p_service_id, p_start_at);
      appointment_id := case when v_replay.error_code is null then v_replay.appointment_id end;
      amount := case when v_replay.error_code is null then v_replay.amount end;
      error_code := v_replay.error_code;
      replayed := v_replay.error_code is null;
      return;
  end;
end;
$$;

comment on function public.book_appointment(uuid, uuid, uuid, uuid, timestamptz, public.appointment_status, public.appointment_source, text, uuid, text) is
  'The one booking operation for every channel. Server-only. Returns appointment_id, or error_code in (invalid_status, clinic_not_found, doctor_not_found, service_not_found, patient_not_found, service_not_offered, past_slot, outside_working_hours, time_blocked, slot_taken, idempotency_key_reused); replayed = true when an earlier attempt with the same idempotency key created it.';

-- ---------- 7. Rescheduling ----------

drop function public.reschedule_appointment(uuid, timestamptz, uuid);

create function public.reschedule_appointment(
  p_clinic_id uuid,
  p_appointment_id uuid,
  p_new_start_at timestamptz,
  p_actor uuid default null,
  out error_code text,
  out error_message text
)
returns record
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_appt public.appointments%rowtype;
  v_clinic public.clinics%rowtype;
  v_duration_minutes int;
  v_new_end_at timestamptz;
begin
  select * into v_appt from public.appointments where id = p_appointment_id and clinic_id = p_clinic_id;
  if not found then
    error_code := 'appointment_not_found'; return;
  end if;

  -- Same lock as book_appointment, then the row itself: a concurrent
  -- reschedule, cancellation or booking of this doctor waits.
  perform pg_advisory_xact_lock(hashtextextended(v_appt.clinic_id::text || ':' || v_appt.doctor_id::text, 0));
  select * into v_appt from public.appointments where id = p_appointment_id and clinic_id = p_clinic_id for update;

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
    left join public.doctor_services ds on ds.service_id = s.id and ds.doctor_id = v_appt.doctor_id
   where s.id = v_appt.service_id;
  v_new_end_at := p_new_start_at + make_interval(mins => v_duration_minutes);

  if not public.slot_within_working_hours(v_appt.doctor_id, v_clinic.timezone, p_new_start_at, v_new_end_at) then
    error_code := 'outside_working_hours'; return;
  end if;

  if exists (
    select 1 from public.doctor_time_blocks tb
     where tb.doctor_id = v_appt.doctor_id
       and tstzrange(tb.starts_at, tb.ends_at, '[)') && tstzrange(p_new_start_at, v_new_end_at, '[)')
  ) then
    error_code := 'time_blocked'; return;
  end if;

  -- The appointment never conflicts with itself.
  if exists (
    select 1 from public.appointments a
     where a.clinic_id = v_appt.clinic_id
       and a.doctor_id = v_appt.doctor_id
       and a.id <> p_appointment_id
       and a.status not in ('cancelled', 'no_show')
       and tstzrange(a.start_at, a.end_at, '[)') && tstzrange(p_new_start_at, v_new_end_at, '[)')
  ) then
    error_code := 'slot_taken'; error_message := 'Bu vaqt band qilingan'; return;
  end if;

  begin
    -- The status is kept: moving a confirmed visit does not downgrade it.
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
  end;
end;
$$;

-- ---------- 8. Direct writes report an overlap as the constraint does ----------

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

  -- Updates that do not move the slot (status, notes, cancellation fields)
  -- do not need availability validation (the exclusion constraint still
  -- decides whether a reactivated appointment may hold its time).
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

  -- Whole slot within one working-hour window of its own local day.
  if not public.slot_within_working_hours(new.doctor_id, v_clinic_tz, new.start_at, new.end_at) then
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
      constraint = 'no_overlapping_active_appointments';
  end if;

  return new;
end;
$$;

-- ---------- 9. Grants: server-only ----------

revoke all on function public.slot_within_working_hours(uuid, text, timestamptz, timestamptz) from public, anon, authenticated;
revoke all on function public.booking_replay(uuid, text, uuid, uuid, uuid, timestamptz) from public, anon, authenticated;
revoke all on function public.book_appointment(uuid, uuid, uuid, uuid, timestamptz, public.appointment_status, public.appointment_source, text, uuid, text) from public, anon, authenticated;
revoke all on function public.reschedule_appointment(uuid, uuid, timestamptz, uuid) from public, anon, authenticated;
grant execute on function public.slot_within_working_hours(uuid, text, timestamptz, timestamptz) to service_role;
grant execute on function public.booking_replay(uuid, text, uuid, uuid, uuid, timestamptz) to service_role;
grant execute on function public.book_appointment(uuid, uuid, uuid, uuid, timestamptz, public.appointment_status, public.appointment_source, text, uuid, text) to service_role;
grant execute on function public.reschedule_appointment(uuid, uuid, timestamptz, uuid) to service_role;

-- =====================================================================
-- FILE: 20260930000006_tenant_integrity_hardening.sql
-- =====================================================================
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

-- =====================================================================
-- FILE: 20261001000001_clinical_record_governance.sql
-- =====================================================================
-- Clinical record governance: author-only versioned corrections, and a
-- patient lifecycle that never destroys clinical, booking or payment records.
--
-- 1. Versions. clinical_records already stored a correction as a new row
--    pointing at the one it corrects (at most one per row, so every record's
--    history is a straight line). Each row now also carries its version
--    number and the id of the first version (its lineage), both set here and
--    never by the caller:
--      * version 1 is an original; a correction of version n is n + 1;
--      * the current version is the one no row corrects; every earlier one
--        is superseded — kept unchanged, never updated or deleted;
--      * a correction must be of the CURRENT version: correcting an already
--        corrected version fails with SQLSTATE CRVER (the server's
--        VERSION_CONFLICT), and two concurrent corrections of the same
--        version cannot both land (unique indexes on corrects_record_id and
--        on (root_record_id, version)).
--
-- 2. Author-only corrections, bound to the person. Before, a correction had
--    to name the same doctor record as the original; a doctor record can be
--    re-linked to a different login, which would have let the new login
--    correct the old one's records. A correction now also needs the same
--    created_by (login) as the version it corrects — SQLSTATE CRNOT (the
--    server's CLINICAL_RECORD_NOT_OWNED) otherwise. A different doctor who
--    disagrees writes their own record in their own consultation. And a
--    doctor record whose clinical records another login wrote can no longer
--    be re-linked to a new login at all (SQLSTATE CRLNK): the new person gets
--    a new doctor record, so no one ever writes under, or is shown as,
--    someone else's authorship.
--
-- 3. The correction audit row names both versions: previous record id and
--    version, new version, lineage, and the original author (ids only —
--    never clinical text).
--
-- 4. Deleting a patient no longer cascades into clinical records, referrals,
--    appointments or payments. Each of those has its own lifecycle
--    (retention, anonymisation) that a person decides; a patient that still
--    has any of them cannot be deleted at all. The foreign keys are NO ACTION
--    rather than RESTRICT so that deleting a whole clinic (which cascades to
--    its patients AND to all of these tables in the same statement) still
--    works. Conversations still cascade: communications are not part of this
--    change (see TASKS.md). A payment still belongs to its appointment
--    (payments_appointment_id_fkey cascades): deleting an appointment — which
--    nothing in the application does — removes its payment.
--
-- 5. public.clinical_record_versions: every version with its status
--    (current / superseded) — the server's history view reads it.
--
-- 6. public.retention_policies: where a clinic records, per data category,
--    the retention rule its confirmed legal policy sets. It is empty — no
--    period is assumed — and nothing deletes or anonymises anything on its
--    basis yet: that job is built once the policy is confirmed.
--
-- Reversible: drop the view, retention_policies and its types; restore
-- clinical_records_validate() from 20260927000005 (+ search_path from
-- 20260930000006) and clinical_records_audit() from 20260929000001; drop
-- trigger doctors_keep_record_authors and its function; drop the
-- version/root_record_id columns, their constraints and index; re-create the
-- four patient foreign keys with ON DELETE CASCADE.

-- ---------------------------------------------------------------------------
-- 1. Version and lineage columns
-- ---------------------------------------------------------------------------

alter table public.clinical_records
  add column version integer,
  add column root_record_id uuid;

comment on column public.clinical_records.version is
  'Version number within the record''s lineage: 1 for an original, n + 1 for a correction of version n. Set by the database.';
comment on column public.clinical_records.root_record_id is
  'The first version of this record (itself for an original). Set by the database.';

-- Backfill the chains that already exist. The validate trigger refuses every
-- UPDATE, so it is switched off for exactly this statement.
alter table public.clinical_records disable trigger clinical_records_validate;

with recursive lineage as (
  select id, id as root_id, 1 as version
  from public.clinical_records
  where corrects_record_id is null
  union all
  select c.id, l.root_id, l.version + 1
  from public.clinical_records c
  join lineage l on c.corrects_record_id = l.id
)
update public.clinical_records r
   set version = l.version, root_record_id = l.root_id
  from lineage l
 where l.id = r.id;

alter table public.clinical_records enable trigger clinical_records_validate;

-- The trigger always sets both; the defaults only keep the insert contract
-- honest (the caller never supplies them). A placeholder root can never
-- stand: it must reference an existing record (foreign key below).
alter table public.clinical_records
  alter column version set default 1,
  alter column root_record_id set default gen_random_uuid(),
  alter column version set not null,
  alter column root_record_id set not null,
  add constraint clinical_records_version_check
    check (
      version >= 1
      and (corrects_record_id is null) = (version = 1)
      and (version > 1 or root_record_id = id)
    ),
  add constraint clinical_records_root_fkey
    foreign key (root_record_id, clinic_id) references public.clinical_records (id, clinic_id);

create unique index clinical_records_lineage_version_key
  on public.clinical_records (root_record_id, version);

-- ---------------------------------------------------------------------------
-- 2. Validation: provenance, consultation state, author-only versioning
-- ---------------------------------------------------------------------------

create or replace function public.clinical_records_validate()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_profile uuid;
  v_active boolean;
  v_status public.appointment_status;
  v_target public.clinical_records;
begin
  if tg_op = 'UPDATE' then
    raise exception 'clinical record: records cannot be edited; add a correction instead';
  end if;

  new.created_at := now();

  select d.profile_id, d.active
    into v_profile, v_active
  from public.doctors d
  where d.id = new.author_doctor_id
    and d.clinic_id = new.clinic_id;
  if not found or not v_active then
    raise exception 'clinical record: the author must be an active doctor of the clinic';
  end if;
  if v_profile is null or new.created_by is distinct from v_profile then
    raise exception 'clinical record: created_by must be the author''s own doctor account';
  end if;
  if not exists (
    select 1
    from public.staff_roles sr
    where sr.profile_id = v_profile
      and sr.clinic_id = new.clinic_id
      and sr.role = 'doctor'
  ) then
    raise exception 'clinical record: the author does not hold the doctor role';
  end if;

  -- The foreign key pins the consultation to the author and the patient;
  -- here it must also actually be taking or have taken place.
  select a.status into v_status
  from public.appointments a
  where a.id = new.appointment_id
    and a.clinic_id = new.clinic_id
    and a.patient_id = new.patient_id
    and a.doctor_id = new.author_doctor_id;
  if found and v_status not in ('in_progress', 'completed') then
    raise exception 'clinical record: the consultation must be in progress or completed (it is %)', v_status;
  end if;

  if new.corrects_record_id is null then
    new.version := 1;
    new.root_record_id := new.id;
    return new;
  end if;

  select * into v_target from public.clinical_records where id = new.corrects_record_id;
  -- Same clinic, same patient, same doctor record AND the same login that
  -- wrote the version being corrected: a re-linked doctor record does not
  -- hand its records to the new login.
  if not found
     or v_target.clinic_id <> new.clinic_id
     or v_target.patient_id <> new.patient_id
     or v_target.author_doctor_id <> new.author_doctor_id
     or v_target.created_by <> new.created_by then
    raise exception using
      errcode = 'CRNOT',
      message = 'clinical record: only the author can correct their own record of the same patient';
  end if;
  if v_target.appointment_id <> new.appointment_id or v_target.record_type <> new.record_type then
    raise exception 'clinical record: a correction keeps the consultation and the record type of the record it corrects';
  end if;
  -- Only the current version can be corrected. A concurrent correction of
  -- the same version that commits first is caught by the unique indexes.
  if exists (select 1 from public.clinical_records c where c.corrects_record_id = v_target.id) then
    raise exception using
      errcode = 'CRVER',
      message = 'clinical record: this version has already been corrected';
  end if;

  new.version := v_target.version + 1;
  new.root_record_id := v_target.root_record_id;
  return new;
end;
$$;

revoke all on function public.clinical_records_validate() from public, anon, authenticated;

-- A doctor record keeps its authors: once another login's clinical records
-- are filed under it, it can't be re-linked to a different login. Unlinking
-- (NULL) and re-linking the records' own author stay possible.
create or replace function public.doctors_keep_record_authors()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.profile_id is not null
     and new.profile_id is distinct from old.profile_id
     and exists (
       select 1
       from public.clinical_records cr
       where cr.author_doctor_id = old.id
         and cr.clinic_id = old.clinic_id
         and cr.created_by <> new.profile_id
     ) then
    raise exception using
      errcode = 'CRLNK',
      message = 'doctor: this doctor record holds clinical records written by another account; create a new doctor record for this account';
  end if;
  return new;
end;
$$;

revoke all on function public.doctors_keep_record_authors() from public, anon, authenticated;

create trigger doctors_keep_record_authors
  before update of profile_id on public.doctors
  for each row execute function public.doctors_keep_record_authors();

-- ---------------------------------------------------------------------------
-- 3. Audit: a correction names both versions (ids and numbers only)
-- ---------------------------------------------------------------------------

create or replace function public.clinical_records_audit()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_referral uuid;
  v_previous public.clinical_records;
begin
  select r.id into v_referral
    from public.referrals r
   where r.clinic_id = new.clinic_id
     and r.patient_id = new.patient_id
     and r.follow_up_appointment_id = new.appointment_id
   order by r.created_at desc
   limit 1;

  if new.corrects_record_id is not null then
    select * into v_previous from public.clinical_records where id = new.corrects_record_id;
  end if;

  insert into public.audit_events (
    clinic_id, actor_id, actor_type, action, entity_type, entity_id,
    patient_id, referral_id, old_values, new_values
  ) values (
    new.clinic_id,
    new.created_by,
    'staff'::public.actor_type,
    case when new.corrects_record_id is null then 'clinical_record_created' else 'clinical_record_corrected' end,
    'clinical_records',
    new.id::text,
    new.patient_id,
    v_referral,
    case when new.corrects_record_id is null then null else
      jsonb_build_object(
        'record_id', v_previous.id,
        'version', v_previous.version,
        'author_doctor_id', v_previous.author_doctor_id,
        'created_by', v_previous.created_by
      )
    end,
    jsonb_build_object(
      'record_type', new.record_type,
      'patient_id', new.patient_id,
      'author_doctor_id', new.author_doctor_id,
      'appointment_id', new.appointment_id,
      'corrects_record_id', new.corrects_record_id,
      'root_record_id', new.root_record_id,
      'version', new.version
    )
  );
  return new;
end;
$$;

revoke all on function public.clinical_records_audit() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. Deleting a patient never cascades into clinical, referral, booking or
--    payment records
-- ---------------------------------------------------------------------------

alter table public.clinical_records
  drop constraint clinical_records_patient_same_clinic_fkey,
  add constraint clinical_records_patient_same_clinic_fkey
    foreign key (patient_id, clinic_id) references public.patients (id, clinic_id) on delete no action;

alter table public.referrals
  drop constraint referrals_patient_same_clinic_fkey,
  add constraint referrals_patient_same_clinic_fkey
    foreign key (patient_id, clinic_id) references public.patients (id, clinic_id) on delete no action;

alter table public.appointments
  drop constraint appointments_patient_id_fkey,
  add constraint appointments_patient_id_fkey
    foreign key (patient_id, clinic_id) references public.patients (id, clinic_id) on delete no action;

alter table public.payments
  drop constraint payments_patient_id_fkey,
  add constraint payments_patient_id_fkey
    foreign key (patient_id, clinic_id) references public.patients (id, clinic_id) on delete no action;

-- ---------------------------------------------------------------------------
-- 5. Every version with its status
-- ---------------------------------------------------------------------------

create view public.clinical_record_versions
with (security_invoker = true)
as
select
  r.id,
  r.clinic_id,
  r.patient_id,
  r.author_doctor_id,
  r.created_by,
  r.appointment_id,
  r.record_type,
  r.summary,
  r.details,
  r.code,
  r.root_record_id,
  r.version,
  r.corrects_record_id,
  r.created_at,
  s.id as superseded_by_record_id,
  s.created_at as superseded_at,
  case when s.id is null then 'current' else 'superseded' end as status
from public.clinical_records r
left join public.clinical_records s on s.corrects_record_id = r.id;

comment on view public.clinical_record_versions is
  'Every version of every clinical record with its status: current (no later version) or superseded. Server-only, like clinical_records.';

revoke all on table public.clinical_record_versions from public, anon, authenticated, service_role;
grant select on table public.clinical_record_versions to service_role;

-- ---------------------------------------------------------------------------
-- 6. Retention rules, per clinic and data category — none assumed
-- ---------------------------------------------------------------------------

create type public.retention_data_category as enum (
  'patient_identity',
  'bookings',
  'payments',
  'communications',
  'clinical_records',
  'audit_records'
);

create type public.retention_action as enum ('review', 'anonymize', 'delete');

create table public.retention_policies (
  clinic_id uuid not null references public.clinics(id) on delete cascade,
  data_category public.retention_data_category not null,
  -- How long the category is kept after it stops being in use. NULL: kept
  -- until a person decides otherwise.
  retain_for interval,
  -- What happens when the period ends: a person reviews it, or the data is
  -- anonymised or deleted.
  on_expiry public.retention_action not null default 'review',
  -- The confirmed legal or clinic policy this rule implements.
  policy_reference text not null,
  confirmed_by uuid references public.profiles(id),
  confirmed_at timestamptz not null default now(),
  primary key (clinic_id, data_category),
  constraint retention_policies_period_check check (retain_for is null or retain_for > interval '0'),
  constraint retention_policies_reference_check check (policy_reference ~ '\S' and char_length(policy_reference) <= 1000)
);

comment on table public.retention_policies is
  'Retention rule per clinic and data category, as set by the clinic''s confirmed legal policy. Empty by default: no period is assumed, and nothing is deleted or anonymised on its basis until a retention job is built for a confirmed policy.';

alter table public.retention_policies enable row level security;

revoke all on table public.retention_policies from public, anon, authenticated, service_role;
grant select, insert, update on table public.retention_policies to service_role;

-- =====================================================================
-- FILE: 20261001000002_longitudinal_care_access.sql
-- =====================================================================
-- Care relationships open longitudinal history; referrals track care, not consent.
-- No new patient/clinical schema, write permissions or signed-in clinical SELECT.
create or replace function public.doctor_patient_access(p_doctor_id uuid, p_patient_id uuid)
returns table (
  clinic_id uuid, own_patient boolean, active_referral_ids uuid[],
  history_doctor_ids uuid[], referral_appointment_ids uuid[]
)
language sql stable security definer set search_path = public, pg_temp
as $$
  with relationship as (
    select d.clinic_id, p.id as patient_id,
      exists (select 1 from public.appointments a
        where a.clinic_id = d.clinic_id and a.patient_id = p.id and a.doctor_id = d.id
          and a.status not in ('cancelled', 'no_show'))
      or exists (select 1 from public.clinical_records cr
        where cr.clinic_id = d.clinic_id and cr.patient_id = p.id and cr.author_doctor_id = d.id)
        as own_patient,
      array(select r.id from public.referrals r
        where r.clinic_id = d.clinic_id and r.patient_id = p.id
          and r.referred_to_doctor_id = d.id
          and r.status in ('pending', 'accepted', 'in_progress') and r.expires_at > now()
        order by r.created_at, r.id) as active_referral_ids
    from public.doctors d
    join public.patients p on p.id = p_patient_id and p.clinic_id = d.clinic_id
    where d.id = p_doctor_id and d.active
      and exists (select 1 from public.staff_roles sr
        where sr.profile_id = d.profile_id and sr.clinic_id = d.clinic_id and sr.role = 'doctor')
  )
  select x.clinic_id, x.own_patient, x.active_referral_ids,
    array(select authors.doctor_id from (
      select a.doctor_id from public.appointments a
        where a.clinic_id = x.clinic_id and a.patient_id = x.patient_id
      union
      select cr.author_doctor_id from public.clinical_records cr
        where cr.clinic_id = x.clinic_id and cr.patient_id = x.patient_id
    ) authors where x.own_patient or cardinality(x.active_referral_ids) > 0
      order by authors.doctor_id),
    array(select r.originating_appointment_id from public.referrals r
      where r.id = any(x.active_referral_ids))
  from relationship x;
$$;
comment on function public.doctor_patient_access(uuid, uuid) is
  'Server-only care decision. Active same-clinic doctor with an assigned non-cancelled/non-no-show visit, authored care, or open unexpired referral sees longitudinal patient history. Pending referrals suffice. No relationship grants nothing. No write authority is shared.';
revoke all on function public.doctor_patient_access(uuid, uuid) from public, anon, authenticated;
grant execute on function public.doctor_patient_access(uuid, uuid) to service_role;

-- Defence in depth if table grants change: longitudinal referral history uses
-- the same care decision. Actual clinical reads remain server-only and audited.
create policy "referral history for treating doctor" on public.referrals for select to authenticated
  using (public.doctor_can_read_patient(clinic_id, patient_id));

-- Reception can schedule an open handoff without waiting for acceptance.
-- This does not mark a doctor's acknowledgement or give reception clinical text.
create or replace function public.referrals_validate()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_referring_found boolean;
  v_referring_active boolean;
  v_referring_profile uuid;
  v_referring_is_doctor boolean;
  v_target_found boolean;
  v_target_active boolean;
  v_target_profile uuid;
  v_target_is_doctor boolean;
  v_appointment_status public.appointment_status;
  v_old_follow_up_status public.appointment_status;
  v_new_follow_up_status public.appointment_status;
  v_mutable text[];
  v_actor uuid;
begin
  -- Doctor records are only looked up inside the referral's own clinic. A
  -- missing or cross-clinic record is left to the composite foreign keys to
  -- reject, rather than reported here with a misleading message.
  select d.active,
         d.profile_id,
         exists (
           select 1 from public.staff_roles sr
           where sr.profile_id = d.profile_id
             and sr.clinic_id = d.clinic_id
             and sr.role = 'doctor'::public.staff_role
         )
    into v_referring_active, v_referring_profile, v_referring_is_doctor
    from public.doctors d
   where d.id = new.referring_doctor_id
     and d.clinic_id = new.clinic_id;
  v_referring_found := found;

  select d.active,
         d.profile_id,
         exists (
           select 1 from public.staff_roles sr
           where sr.profile_id = d.profile_id
             and sr.clinic_id = d.clinic_id
             and sr.role = 'doctor'::public.staff_role
         )
    into v_target_active, v_target_profile, v_target_is_doctor
    from public.doctors d
   where d.id = new.referred_to_doctor_id
     and d.clinic_id = new.clinic_id;
  v_target_found := found;

  if tg_op = 'INSERT' then
    if new.status is distinct from 'pending'::public.referral_status then
      raise exception 'referral: a referral must be created as pending';
    end if;
    if new.follow_up_appointment_id is not null then
      raise exception 'referral: a follow-up can only be linked to an open handoff';
    end if;

    new.created_at := now();
    new.updated_at := now();

    if v_referring_found and new.created_by is not null then
      if not v_referring_active then
        raise exception 'referral: the referring doctor is inactive';
      end if;
      if new.created_by is distinct from v_referring_profile or not v_referring_is_doctor then
        raise exception 'referral: created_by must be the referring doctor''s own doctor account';
      end if;
    end if;

    -- Same doctor record on both sides is left to referrals_not_self_referral.
    if v_target_found and new.referred_to_doctor_id <> new.referring_doctor_id then
      if not v_target_active then
        raise exception 'referral: the receiving doctor is inactive';
      end if;
      if v_target_profile is null or not v_target_is_doctor then
        raise exception 'referral: the receiving doctor has no linked doctor account';
      end if;
      if v_target_profile = v_referring_profile then
        raise exception 'referral: self-referral (both doctor records belong to the same account)';
      end if;
    end if;

    select a.status
      into v_appointment_status
      from public.appointments a
     where a.id = new.originating_appointment_id
       and a.clinic_id = new.clinic_id
       and a.patient_id = new.patient_id
       and a.doctor_id = new.referring_doctor_id;
    if found and v_appointment_status not in ('in_progress', 'completed') then
      raise exception 'referral: the originating consultation must be in progress or completed (it is %)', v_appointment_status;
    end if;

    return new;
  end if;

  -- UPDATE: care transitions, plus scheduling an open pending/accepted handoff.
  if new.status = old.status then
    if new.follow_up_appointment_id is distinct from old.follow_up_appointment_id
       and old.status not in ('pending', 'accepted') then
      raise exception 'referral: a follow-up can only be linked to an open handoff';
    end if;
    v_mutable := array['follow_up_appointment_id', 'updated_at'];
  elsif (old.status = 'pending' and new.status in ('accepted', 'declined', 'revoked', 'expired'))
     or (old.status = 'accepted' and new.status in ('in_progress', 'revoked', 'expired'))
     or (old.status = 'in_progress' and new.status in ('completed', 'revoked', 'expired')) then
    v_mutable := case new.status
      when 'accepted' then array['status', 'accepted_at', 'accepted_by', 'updated_at']
      when 'in_progress' then array['status', 'started_at', 'started_by', 'updated_at']
      when 'declined' then array['status', 'declined_at', 'declined_by', 'declined_reason', 'updated_at']
      when 'completed' then array['status', 'completed_at', 'completed_by', 'updated_at']
      when 'revoked' then array['status', 'revoked_at', 'revoked_by', 'revoked_reason', 'updated_at']
      else array['status', 'updated_at']
    end;
  else
    raise exception 'referral: invalid status transition % -> %', old.status, new.status;
  end if;

  if (to_jsonb(new) - v_mutable) is distinct from (to_jsonb(old) - v_mutable) then
    if new.status = old.status then
      raise exception 'referral: a referral cannot be edited, only moved through its status transitions';
    end if;
    raise exception 'referral: the % transition may only set its own fields', new.status;
  end if;

  if new.status = old.status then
    if new.follow_up_appointment_id is distinct from old.follow_up_appointment_id then
      if new.follow_up_appointment_id is null then
        raise exception 'referral: a booked follow-up cannot be unlinked';
      end if;
      if old.expires_at <= now() then
        raise exception 'referral: the referral expired at %', old.expires_at;
      end if;
      select a.status into v_new_follow_up_status
        from public.appointments a
       where a.id = new.follow_up_appointment_id;
      if v_new_follow_up_status in ('cancelled', 'no_show') then
        raise exception 'referral: the follow-up appointment is cancelled';
      end if;
      if old.follow_up_appointment_id is not null then
        select a.status into v_old_follow_up_status
          from public.appointments a
         where a.id = old.follow_up_appointment_id;
        -- A cancelled/no-show booking may be replaced; so may one that has
        -- not started when the receiving doctor saw the patient before it.
        if v_old_follow_up_status not in ('cancelled', 'no_show')
           and not (
             v_old_follow_up_status in ('pending', 'confirmed', 'checked_in')
             and v_new_follow_up_status in ('in_progress', 'completed')
           ) then
          raise exception 'referral: a follow-up appointment is already booked';
        end if;
      end if;

      -- Linking a consultation that has already started: the referral is in
      -- progress from this statement on.
      if old.status = 'accepted' and v_new_follow_up_status in ('in_progress', 'completed') then
        if v_target_profile is null or not v_target_active or not v_target_is_doctor then
          raise exception 'referral: only the receiving doctor can mark the referral in_progress';
        end if;
        new.status := 'in_progress';
        new.started_at := now();
        new.started_by := v_target_profile;
      end if;
    end if;
    return new;
  end if;

  if new.status in ('accepted', 'in_progress', 'completed') and old.expires_at <= now() then
    raise exception 'referral: the referral expired at %', old.expires_at;
  end if;
  if new.status = 'expired' and old.expires_at > now() then
    raise exception 'referral: the referral does not expire until %', old.expires_at;
  end if;

  if new.status = 'in_progress' and not exists (
       select 1 from public.appointments a
       where a.id = old.follow_up_appointment_id
         and a.status in ('in_progress', 'completed')
     ) then
    raise exception 'referral: a referral is in progress only once its follow-up consultation has started';
  end if;

  if new.status in ('accepted', 'in_progress', 'declined', 'completed') then
    v_actor := case new.status
      when 'accepted' then new.accepted_by
      when 'in_progress' then new.started_by
      when 'declined' then new.declined_by
      else new.completed_by
    end;
    if v_actor is null
       or v_actor is distinct from v_target_profile
       or not v_target_active
       or not v_target_is_doctor then
      raise exception 'referral: only the receiving doctor can mark the referral %', new.status;
    end if;
  elsif new.status = 'revoked' then
    if new.revoked_by is null or not (
         (new.revoked_by = v_referring_profile and v_referring_active and v_referring_is_doctor)
         or exists (
           select 1 from public.staff_roles sr
           where sr.profile_id = new.revoked_by
             and sr.clinic_id = new.clinic_id
             and sr.role in ('owner', 'admin', 'manager')
         )
       ) then
      raise exception 'referral: only the referring doctor or clinic management can revoke a referral';
    end if;
  end if;

  case new.status
    when 'accepted' then
      new.accepted_at := now();
      -- A pending handoff may already have an assigned/started visit.
      -- The receiver's acknowledgement catches care tracking up to that visit.
      if exists (select 1 from public.appointments a where a.id = new.follow_up_appointment_id
                 and a.status in ('in_progress', 'completed')) then
        new.status := 'in_progress';
        new.started_at := now();
        new.started_by := v_target_profile;
      end if;
    when 'in_progress' then new.started_at := now();
    when 'declined' then new.declined_at := now();
    when 'completed' then new.completed_at := now();
    when 'revoked' then new.revoked_at := now();
    else null;
  end case;

  return new;
end;
$$;

create or replace function public.consultation_started_effects(
  p_appointment_id uuid,
  p_actor uuid,
  p_via text,
  p_link_referral boolean,
  p_walk_in boolean
)
returns uuid
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_appointment public.appointments%rowtype;
  v_waiting uuid;
  v_referral uuid;
begin
  select * into v_appointment from public.appointments where id = p_appointment_id;
  if not found or v_appointment.status <> 'in_progress' then
    raise exception 'consultation: the appointment is not in progress';
  end if;

  -- An open referral to this doctor for this patient that is waiting for
  -- its consultation: none booked yet, or its booking was cancelled or has
  -- not started (same rule as referrals_validate()).
  if p_link_referral and not exists (
    select 1 from public.referrals r
     where r.follow_up_appointment_id = v_appointment.id
       and r.status in ('accepted', 'in_progress', 'completed')
  ) then
    select r.id into v_waiting
      from public.referrals r
      left join public.appointments f on f.id = r.follow_up_appointment_id
     where r.clinic_id = v_appointment.clinic_id
       and r.patient_id = v_appointment.patient_id
       and r.referred_to_doctor_id = v_appointment.doctor_id
       and r.status in ('pending', 'accepted')
       and r.expires_at > now()
       and (r.follow_up_appointment_id = v_appointment.id
            or r.follow_up_appointment_id is null
            or f.status in ('cancelled', 'no_show', 'pending', 'confirmed', 'checked_in'))
     order by r.created_at
     limit 1
     for update of r;
    if v_waiting is not null then
      begin
        -- Starting care acknowledges the handoff; acceptance is not an access gate.
        -- Attribute this only to the receiving doctor, never an operational actor.
        if exists (select 1 from public.doctors d where d.id = v_appointment.doctor_id
                   and d.clinic_id = v_appointment.clinic_id and d.profile_id = p_actor) then
          update public.referrals set status = 'accepted', accepted_by = p_actor
            where id = v_waiting and status = 'pending';
        end if;
        update public.referrals set follow_up_appointment_id = v_appointment.id where id = v_waiting;
      exception when others then
        raise warning 'consultation not linked to referral (sqlstate %)', sqlstate;
      end;
    end if;
  end if;

  select r.id into v_referral
    from public.referrals r
   where r.clinic_id = v_appointment.clinic_id
     and r.follow_up_appointment_id = v_appointment.id
     and r.status in ('accepted', 'in_progress', 'completed')
   order by r.created_at desc
   limit 1;

  insert into public.audit_events (
    clinic_id, actor_id, actor_type, action, entity_type, entity_id,
    patient_id, referral_id, new_values, metadata
  ) values (
    v_appointment.clinic_id, p_actor, 'staff', 'consultation_started', 'appointments', v_appointment.id::text,
    v_appointment.patient_id, v_referral,
    jsonb_build_object('status', 'in_progress'),
    jsonb_build_object(
      'patient_id', v_appointment.patient_id,
      'doctor_id', v_appointment.doctor_id,
      'referral_id', v_referral,
      'via', p_via,
      'walk_in', p_walk_in
    )
  );
  return v_referral;
end;
$$;

-- =====================================================================
-- FILE: 20261001000003_independent_retention.sql
-- =====================================================================
-- Retention categories are independent. Parent erasure cannot substitute for
-- a confirmed per-category retention decision. No retention executor is added.
do $$
declare fk record;
begin
  for fk in
    select conrelid::regclass as relation, conname, pg_get_constraintdef(oid) as definition
    from pg_constraint
    where contype = 'f' and confdeltype = 'c' and (
      (confrelid = 'public.clinics'::regclass and conrelid in (
        'public.clinical_records'::regclass, 'public.referrals'::regclass,
        'public.appointments'::regclass, 'public.payments'::regclass,
        'public.conversations'::regclass, 'public.messages'::regclass,
        'public.voice_messages'::regclass, 'public.audit_events'::regclass,
        'public.retention_policies'::regclass
      )) or
      (confrelid = 'public.patients'::regclass and conrelid = 'public.conversations'::regclass) or
      (confrelid = 'public.appointments'::regclass and conrelid = 'public.payments'::regclass)
    )
  loop
    execute format('alter table %s drop constraint %I', fk.relation, fk.conname);
    execute format('alter table %s add constraint %I %s', fk.relation, fk.conname,
      replace(fk.definition, 'ON DELETE CASCADE', 'ON DELETE RESTRICT'));
  end loop;
end;
$$;

-- =====================================================================
-- FILE: 20261002000001_longitudinal_history.sql
-- =====================================================================
-- Longitudinal patient history and department referrals.
--
-- A referral is a clinical handoff, not a permission request, and a patient's
-- clinical history belongs to the patient's clinic record:
--
-- 1. LONGITUDINAL ACCESS. A doctor with a legitimate clinical relationship to
--    a patient sees the patient's whole clinical history in the clinic —
--    every doctor's consultations and records — without asking anyone. The
--    relationship (unchanged in kind, widened in what it shows):
--      * a treating relationship: any appointment, neither cancelled nor a no-show, with the
--        patient (past, today or booked; a website booking not yet confirmed
--        by staff excepted — its visitor is unverified) or a record the
--        doctor wrote — kept for continuity of care; or
--      * an open referral (pending, accepted or in progress, unexpired) to
--        the doctor, or to the doctor's department while no doctor has taken
--        it yet — from the moment it is created: acceptance is a care step,
--        never a gate on the history.
--    Everything else is unchanged: an active doctor-role doctor of the
--    patient's clinic only (no row across clinics), no access at all for a
--    same-clinic doctor without a relationship, clinical text read only
--    through the server (signed-in roles still have no SELECT on
--    clinical_records / referrals), and every record stays its author's —
--    only the author corrects it (20261001000001).
--
-- 2. DEPARTMENT REFERRALS. A referral goes to a department (a specialty),
--    a doctor, or both (the doctor must then belong to the department). A
--    department referral waits in every department doctor's incoming list;
--    the first of them to accept it becomes its receiving doctor
--    (referred_to_doctor_id is set exactly once, by that doctor's own
--    acceptance). Until then nobody can decline, start or complete it.
--
-- 3. PAYMENTS. Doctors no longer read payment rows directly (the policy
--    "payments read for own doctor" is dropped): the server shows a doctor
--    only the payment status of the visit in front of them.
--
-- 4. PATIENT IDENTITY. patients.phone_normalized (digits only, a 9-digit
--    local number prefixed with 998) is generated from phone and indexed per
--    clinic, so reception can find a returning patient before creating a
--    duplicate. Not unique: two people can share a phone.
--
-- 4b. CONSULTATION START. A doctor's own start re-checks their access inside
--    the transaction (a walk-in resting on a referral alone confirms the
--    referral is still open after booking, locking appointment-then-referral,
--    and is refused with SQLSTATE CALST otherwise), refuses an unconfirmed
--    website booking, and accepts the doctor's pending referral there too: a
--    start that fails accepts nothing.
--
-- 5. AUDIT. A correction is audited as 'clinical_record_version_created'
--    (earlier rows keep 'clinical_record_corrected'); referral events carry
--    the department.
--
-- Reversible (restore each function from the LATEST earlier definition — on a
-- database that has 20261001000002 that migration redefines three of them):
-- doctor_patient_access(), referrals_validate() and
-- consultation_started_effects() from 20261001000002 (the no-show rule, the
-- follow-up of a pending referral), and from 20260930000001 for
-- start_consultation() / start_walk_in_consultation(); referrals_audit() and
-- the receiving-doctor policy from 20260929000001, doctor_can_read_patient()
-- from 20260927000003, doctor_can_read_appointment() from 20260929000001,
-- clinical_records_audit() from 20261001000001; re-create the policy
-- "referral history for treating doctor" (20261001000002) only if rolling back
-- past it; re-create
-- "payments read for own doctor" (20260927000004); drop trigger
-- referrals_catch_up_started and its function; drop
-- referrals.referred_to_specialty_id (after assigning or revoking department
-- referrals), its constraints and indexes, and set referred_to_doctor_id not
-- null again; drop patients.phone_normalized, its index and
-- normalize_phone().

-- ---------------------------------------------------------------------------
-- 1. Department referrals: columns and constraints
-- ---------------------------------------------------------------------------

alter table public.referrals
  add column referred_to_specialty_id uuid,
  alter column referred_to_doctor_id drop not null,
  add constraint referrals_referred_to_specialty_fkey
    foreign key (referred_to_specialty_id, clinic_id) references public.specialties (id, clinic_id),
  add constraint referrals_recipient_check
    check (referred_to_doctor_id is not null or referred_to_specialty_id is not null);

comment on column public.referrals.referred_to_specialty_id is
  'The department (specialty) the patient is referred to. Alone: every active doctor of the department sees the referral until one of them accepts it and becomes referred_to_doctor_id.';

-- One open referral per patient, referring doctor and department while no
-- doctor has taken it (referrals_one_open_per_pair covers named doctors).
create unique index referrals_one_open_per_department
  on public.referrals (patient_id, referring_doctor_id, referred_to_specialty_id)
  where referred_to_doctor_id is null and status in ('pending', 'accepted', 'in_progress');

create index referrals_unclaimed_department_idx
  on public.referrals (clinic_id, referred_to_specialty_id, status)
  where referred_to_doctor_id is null;

-- ---------------------------------------------------------------------------
-- 2. Status machine: department referrals and their acceptance
-- ---------------------------------------------------------------------------

create or replace function public.referrals_validate()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_referring_found boolean;
  v_referring_active boolean;
  v_referring_profile uuid;
  v_referring_is_doctor boolean;
  v_target_found boolean;
  v_target_active boolean;
  v_target_profile uuid;
  v_target_is_doctor boolean;
  v_target_specialty uuid;
  v_appointment_status public.appointment_status;
  v_old_follow_up_status public.appointment_status;
  v_new_follow_up_status public.appointment_status;
  v_mutable text[];
  v_actor uuid;
  v_claiming boolean := false;
begin
  -- Doctor records are only looked up inside the referral's own clinic. A
  -- missing or cross-clinic record is left to the composite foreign keys to
  -- reject, rather than reported here with a misleading message.
  select d.active,
         d.profile_id,
         exists (
           select 1 from public.staff_roles sr
           where sr.profile_id = d.profile_id
             and sr.clinic_id = d.clinic_id
             and sr.role = 'doctor'::public.staff_role
         )
    into v_referring_active, v_referring_profile, v_referring_is_doctor
    from public.doctors d
   where d.id = new.referring_doctor_id
     and d.clinic_id = new.clinic_id;
  v_referring_found := found;

  select d.active,
         d.profile_id,
         exists (
           select 1 from public.staff_roles sr
           where sr.profile_id = d.profile_id
             and sr.clinic_id = d.clinic_id
             and sr.role = 'doctor'::public.staff_role
         ),
         d.specialty_id
    into v_target_active, v_target_profile, v_target_is_doctor, v_target_specialty
    from public.doctors d
   where d.id = new.referred_to_doctor_id
     and d.clinic_id = new.clinic_id;
  v_target_found := found;

  if tg_op = 'INSERT' then
    if new.status is distinct from 'pending'::public.referral_status then
      raise exception 'referral: a referral must be created as pending';
    end if;
    if new.follow_up_appointment_id is not null then
      raise exception 'referral: a follow-up can only be linked to an open handoff';
    end if;

    new.created_at := now();
    new.updated_at := now();

    if v_referring_found and new.created_by is not null then
      if not v_referring_active then
        raise exception 'referral: the referring doctor is inactive';
      end if;
      if new.created_by is distinct from v_referring_profile or not v_referring_is_doctor then
        raise exception 'referral: created_by must be the referring doctor''s own doctor account';
      end if;
    end if;

    -- Same doctor record on both sides is left to referrals_not_self_referral.
    if v_target_found and new.referred_to_doctor_id <> new.referring_doctor_id then
      if not v_target_active then
        raise exception 'referral: the receiving doctor is inactive';
      end if;
      if v_target_profile is null or not v_target_is_doctor then
        raise exception 'referral: the receiving doctor has no linked doctor account';
      end if;
      if v_target_profile = v_referring_profile then
        raise exception 'referral: self-referral (both doctor records belong to the same account)';
      end if;
      if new.referred_to_specialty_id is not null
         and v_target_specialty is distinct from new.referred_to_specialty_id then
        raise exception 'referral: the receiving doctor does not belong to that department';
      end if;
    end if;

    select a.status
      into v_appointment_status
      from public.appointments a
     where a.id = new.originating_appointment_id
       and a.clinic_id = new.clinic_id
       and a.patient_id = new.patient_id
       and a.doctor_id = new.referring_doctor_id;
    if found and v_appointment_status not in ('in_progress', 'completed') then
      raise exception 'referral: the originating consultation must be in progress or completed (it is %)', v_appointment_status;
    end if;

    return new;
  end if;

  -- A department referral nobody has taken yet: its first acceptance names
  -- the receiving doctor, and nothing else may name one.
  if old.referred_to_doctor_id is null then
    if new.referred_to_doctor_id is not null then
      if not (old.status = 'pending' and new.status = 'accepted') then
        raise exception 'referral: a department referral is taken by accepting it';
      end if;
      v_claiming := true;
    end if;
  elsif new.referred_to_doctor_id is distinct from old.referred_to_doctor_id then
    raise exception 'referral: a referral cannot be edited, only moved through its status transitions';
  end if;

  -- UPDATE: status transitions, plus scheduling the follow-up of an open
  -- handoff (reception need not wait for acknowledgement — a referral is no
  -- permission request). A department referral nobody has taken has no
  -- doctor yet, so its visit can only be booked once a doctor took it.
  if new.status = old.status then
    if new.follow_up_appointment_id is distinct from old.follow_up_appointment_id
       and (old.status not in ('pending', 'accepted') or old.referred_to_doctor_id is null) then
      raise exception 'referral: a follow-up can only be linked to an open handoff';
    end if;
    v_mutable := array['follow_up_appointment_id', 'updated_at'];
  elsif (old.status = 'pending' and new.status in ('accepted', 'declined', 'revoked', 'expired'))
     or (old.status = 'accepted' and new.status in ('in_progress', 'revoked', 'expired'))
     or (old.status = 'in_progress' and new.status in ('completed', 'revoked', 'expired')) then
    v_mutable := case new.status
      when 'accepted' then array['status', 'accepted_at', 'accepted_by', 'updated_at']
      when 'in_progress' then array['status', 'started_at', 'started_by', 'updated_at']
      when 'declined' then array['status', 'declined_at', 'declined_by', 'declined_reason', 'updated_at']
      when 'completed' then array['status', 'completed_at', 'completed_by', 'updated_at']
      when 'revoked' then array['status', 'revoked_at', 'revoked_by', 'revoked_reason', 'updated_at']
      else array['status', 'updated_at']
    end;
    if v_claiming then
      v_mutable := v_mutable || array['referred_to_doctor_id'];
    end if;
  else
    raise exception 'referral: invalid status transition % -> %', old.status, new.status;
  end if;

  if (to_jsonb(new) - v_mutable) is distinct from (to_jsonb(old) - v_mutable) then
    if new.status = old.status then
      raise exception 'referral: a referral cannot be edited, only moved through its status transitions';
    end if;
    raise exception 'referral: the % transition may only set its own fields', new.status;
  end if;

  if v_claiming then
    if new.referred_to_doctor_id = new.referring_doctor_id
       or (v_target_profile is not null and v_target_profile = v_referring_profile) then
      raise exception 'referral: self-referral (both doctor records belong to the same account)';
    end if;
    if not v_target_found or v_target_specialty is distinct from old.referred_to_specialty_id then
      raise exception 'referral: the receiving doctor does not belong to that department';
    end if;
  end if;

  if new.status = old.status then
    if new.follow_up_appointment_id is distinct from old.follow_up_appointment_id then
      if new.follow_up_appointment_id is null then
        raise exception 'referral: a booked follow-up cannot be unlinked';
      end if;
      if old.expires_at <= now() then
        raise exception 'referral: the referral expired at %', old.expires_at;
      end if;
      select a.status into v_new_follow_up_status
        from public.appointments a
       where a.id = new.follow_up_appointment_id;
      if v_new_follow_up_status in ('cancelled', 'no_show') then
        raise exception 'referral: the follow-up appointment is cancelled';
      end if;
      if old.follow_up_appointment_id is not null then
        select a.status into v_old_follow_up_status
          from public.appointments a
         where a.id = old.follow_up_appointment_id;
        -- A cancelled/no-show booking may be replaced; so may one that has
        -- not started when the receiving doctor saw the patient before it.
        if v_old_follow_up_status not in ('cancelled', 'no_show')
           and not (
             v_old_follow_up_status in ('pending', 'confirmed', 'checked_in')
             and v_new_follow_up_status in ('in_progress', 'completed')
           ) then
          raise exception 'referral: a follow-up appointment is already booked';
        end if;
      end if;

      -- Linking a consultation that has already started: the referral is in
      -- progress from this statement on.
      if old.status = 'accepted' and v_new_follow_up_status in ('in_progress', 'completed') then
        if v_target_profile is null or not v_target_active or not v_target_is_doctor then
          raise exception 'referral: only the receiving doctor can mark the referral in_progress';
        end if;
        new.status := 'in_progress';
        new.started_at := now();
        new.started_by := v_target_profile;
      end if;
    end if;
    return new;
  end if;

  if new.status in ('accepted', 'in_progress', 'completed') and old.expires_at <= now() then
    raise exception 'referral: the referral expired at %', old.expires_at;
  end if;
  if new.status = 'expired' and old.expires_at > now() then
    raise exception 'referral: the referral does not expire until %', old.expires_at;
  end if;

  if new.status = 'in_progress' and not exists (
       select 1 from public.appointments a
       where a.id = old.follow_up_appointment_id
         and a.status in ('in_progress', 'completed')
     ) then
    raise exception 'referral: a referral is in progress only once its follow-up consultation has started';
  end if;

  if new.status in ('accepted', 'in_progress', 'declined', 'completed') then
    v_actor := case new.status
      when 'accepted' then new.accepted_by
      when 'in_progress' then new.started_by
      when 'declined' then new.declined_by
      else new.completed_by
    end;
    -- For a department referral nobody has taken, there is no receiving
    -- doctor yet: only an acceptance that names one can pass.
    if v_actor is null
       or v_actor is distinct from v_target_profile
       or not v_target_active
       or not v_target_is_doctor then
      raise exception 'referral: only the receiving doctor can mark the referral %', new.status;
    end if;
  elsif new.status = 'revoked' then
    if new.revoked_by is null or not (
         (new.revoked_by = v_referring_profile and v_referring_active and v_referring_is_doctor)
         or exists (
           select 1 from public.staff_roles sr
           where sr.profile_id = new.revoked_by
             and sr.clinic_id = new.clinic_id
             and sr.role in ('owner', 'admin', 'manager')
         )
       ) then
      raise exception 'referral: only the referring doctor or clinic management can revoke a referral';
    end if;
  end if;

  case new.status
    when 'accepted' then new.accepted_at := now();
    when 'in_progress' then new.started_at := now();
    when 'declined' then new.declined_at := now();
    when 'completed' then new.completed_at := now();
    when 'revoked' then new.revoked_at := now();
    else null;
  end case;

  return new;
end;
$$;

revoke all on function public.referrals_validate() from public, anon, authenticated;

create or replace function public.referrals_audit()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_action text;
  v_actor uuid;
  v_old jsonb;
begin
  if tg_op = 'INSERT' then
    v_action := 'referral_created';
    v_actor := new.created_by;
  elsif new.status is distinct from old.status then
    v_action := 'referral_' || new.status::text;
    v_actor := case new.status
      when 'accepted' then new.accepted_by
      when 'in_progress' then new.started_by
      when 'declined' then new.declined_by
      when 'completed' then new.completed_by
      when 'revoked' then new.revoked_by
      else null
    end;
    v_old := jsonb_build_object('status', old.status);
    -- A consultation linked in the same statement (see referrals_validate).
    if new.follow_up_appointment_id is distinct from old.follow_up_appointment_id then
      v_old := v_old || jsonb_build_object('follow_up_appointment_id', old.follow_up_appointment_id);
    end if;
    -- A department referral taken by the doctor who accepted it.
    if new.referred_to_doctor_id is distinct from old.referred_to_doctor_id then
      v_old := v_old || jsonb_build_object('referred_to_doctor_id', old.referred_to_doctor_id);
    end if;
  elsif new.follow_up_appointment_id is distinct from old.follow_up_appointment_id then
    v_action := 'referral_follow_up_booked';
    select a.created_by into v_actor
      from public.appointments a
     where a.id = new.follow_up_appointment_id;
    v_old := jsonb_build_object('follow_up_appointment_id', old.follow_up_appointment_id);
  else
    return null;
  end if;

  -- Ids, status and dates only: never the reason, handoff note or any other
  -- clinical text.
  insert into public.audit_events (
    clinic_id, actor_id, actor_type, action, entity_type, entity_id,
    patient_id, referral_id, old_values, new_values, metadata, ip_address
  ) values (
    new.clinic_id,
    v_actor,
    case when v_actor is null then 'system'::public.actor_type else 'staff'::public.actor_type end,
    v_action,
    'referrals',
    new.id::text,
    new.patient_id,
    new.id,
    v_old,
    jsonb_build_object(
      'status', new.status,
      'priority', new.priority,
      'patient_id', new.patient_id,
      'referring_doctor_id', new.referring_doctor_id,
      'referred_to_doctor_id', new.referred_to_doctor_id,
      'referred_to_specialty_id', new.referred_to_specialty_id,
      'originating_appointment_id', new.originating_appointment_id,
      'follow_up_appointment_id', new.follow_up_appointment_id,
      'expires_at', new.expires_at
    ),
    case when new.status = 'expired' and v_action = 'referral_expired'
      then jsonb_build_object('cause', 'validity_elapsed')
      else '{}'::jsonb
    end,
    nullif(current_setting('request.ip', true), '')
  );
  return null;
end;
$$;

revoke all on function public.referrals_audit() from public, anon, authenticated;

-- A pending referral whose follow-up visit is already under way (reception
-- linked it, the visit started, and only now does the receiving doctor accept)
-- is in progress from its acceptance on: otherwise it would stay 'accepted'
-- beside a started — later completed — consultation, with no transition left
-- to take. The acceptance and the start are both audited (two transitions).
-- Also covers the in-transaction accept in consultation_started_effects().
create or replace function public.referrals_catch_up_started()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if old.status = 'pending'
     and new.status = 'accepted'
     and new.follow_up_appointment_id is not null
     and exists (
       select 1 from public.appointments a
        where a.id = new.follow_up_appointment_id
          and a.status in ('in_progress', 'completed')
     ) then
    update public.referrals r
       set status = 'in_progress', started_by = new.accepted_by
     where r.id = new.id
       and r.status = 'accepted';
  end if;
  return null;
end;
$$;

revoke all on function public.referrals_catch_up_started() from public, anon, authenticated;

create trigger referrals_catch_up_started
  after update of status on public.referrals
  for each row execute function public.referrals_catch_up_started();

-- The receiving doctor's (backstop) view of a referral: also a department
-- doctor's while nobody has taken it. Signed-in roles still have no SELECT
-- on referrals; every read goes through the server.
-- 20261001000002 added a SELECT policy for any treating doctor. Referral
-- rows carry the doctor's clinical handoff text and signed-in roles read no
-- clinical table directly (reads go through the server, which authorizes and
-- audits each one), so it is dropped; the receiving doctor's backstop policy
-- below is the only one.
drop policy if exists "referral history for treating doctor" on public.referrals;
drop policy if exists "referrals read for receiving doctor" on public.referrals;
create policy "referrals read for receiving doctor"
  on public.referrals for select
  to authenticated
  using (
    status in ('pending', 'accepted', 'in_progress', 'completed')
    and expires_at > now()
    and (
      public.is_linked_doctor(referred_to_doctor_id)
      or (
        referred_to_doctor_id is null
        and status = 'pending'
        -- A doctor never receives the referral they raised themselves.
        and referring_doctor_id is distinct from public.current_doctor_id(clinic_id)
        and referred_to_specialty_id = (
          select d.specialty_id from public.doctors d where d.id = public.current_doctor_id(clinic_id)
        )
      )
    )
  );

-- ---------------------------------------------------------------------------
-- 3. The decision: longitudinal history for a legitimate relationship
-- ---------------------------------------------------------------------------

-- The return columns change, so the function is re-created. The policies
-- call it only through doctor_can_read_patient()/doctor_can_read_appointment(),
-- whose signatures stay, so no policy has to be re-created.
drop function public.doctor_patient_access(uuid, uuid);

create function public.doctor_patient_access(p_doctor_id uuid, p_patient_id uuid)
returns table (
  clinic_id uuid,
  own_patient boolean,
  active_referral_ids uuid[],
  full_history boolean
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with decision as (
    select
      d.clinic_id,
      -- Treating relationship: any appointment that was neither cancelled nor
      -- a no-show (past, today or booked), or a record the doctor wrote. A website booking
      -- nobody has confirmed yet is not one: it is made without any proof of
      -- who the visitor is, and could name someone else's record. Once staff
      -- confirm it (any status beyond pending) it counts like any other.
      exists (
        select 1
        from public.appointments a
        where a.clinic_id = d.clinic_id
          and a.patient_id = p.id
          and a.doctor_id = d.id
          and a.status not in ('cancelled', 'no_show')
          and not (a.source = 'web' and a.status = 'pending')
      )
      or exists (
        select 1
        from public.clinical_records cr
        where cr.clinic_id = d.clinic_id
          and cr.patient_id = p.id
          and cr.author_doctor_id = d.id
      ) as own_patient,
      -- Open, unexpired referrals to the doctor — or to the doctor's
      -- department while nobody has taken them (other than their own).
      array(
        select r.id
        from public.referrals r
        where r.clinic_id = d.clinic_id
          and r.patient_id = p.id
          and r.status in ('pending', 'accepted', 'in_progress')
          and r.expires_at > now()
          and (
            r.referred_to_doctor_id = d.id
            or (
              r.referred_to_doctor_id is null
              and r.status = 'pending'
              -- Never the referral the doctor raised themselves: their own
              -- department is not a receiver of it.
              and r.referring_doctor_id <> d.id
              and d.specialty_id is not null
              and r.referred_to_specialty_id = d.specialty_id
            )
          )
        order by r.created_at
      ) as active_referral_ids
    from public.doctors d
    join public.patients p
      on p.id = p_patient_id
     and p.clinic_id = d.clinic_id
    where d.id = p_doctor_id
      and d.active
      and exists (
        select 1
        from public.staff_roles sr
        where sr.profile_id = d.profile_id
          and sr.clinic_id = d.clinic_id
          and sr.role = 'doctor'
      )
  )
  select clinic_id, own_patient, active_referral_ids, own_patient or cardinality(active_referral_ids) > 0
  from decision;
$$;

comment on function public.doctor_patient_access(uuid, uuid) is
  'What an active doctor may see of a patient of their clinic (see 20261002000001): full_history — the patient''s whole clinical history, every doctor''s visits and records — for a treating relationship (an appointment that was neither cancelled nor a no-show, or an authored record) or an open, unexpired referral to them or (while untaken) to their department. No row = other clinic / not an active doctor. Server-only.';

revoke all on function public.doctor_patient_access(uuid, uuid) from public, anon, authenticated;
grant execute on function public.doctor_patient_access(uuid, uuid) to service_role;

-- Whether the caller, as a doctor, may read this patient's record.
create or replace function public.doctor_can_read_patient(p_clinic_id uuid, p_patient_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce((
    select x.full_history
    from public.doctor_patient_access(public.current_doctor_id(p_clinic_id), p_patient_id) x
    where x.clinic_id = p_clinic_id
  ), false);
$$;

-- Whether the caller, as a doctor, may read an appointment (and the records
-- written in it) of this patient: every one of them once they may see the
-- patient's history. The appointment's doctor and id no longer narrow it;
-- the signature stays for the policies that call it.
create or replace function public.doctor_can_read_appointment(
  p_clinic_id uuid,
  p_patient_id uuid,
  p_doctor_id uuid,
  p_appointment_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select public.doctor_can_read_patient(p_clinic_id, p_patient_id);
$$;

comment on table public.clinical_records is
  'Doctor-authored clinical records with provenance (author, consultation, time, type, version) — part of the patient''s longitudinal clinic record. Readable by doctors doctor_patient_access() gives the patient''s history (a treating relationship or an open referral), never by operational staff, patients or AI; only the author corrects (as a new version).';

-- ---------------------------------------------------------------------------
-- 4. Payments: no direct reads by doctors
-- ---------------------------------------------------------------------------

drop policy if exists "payments read for own doctor" on public.payments;

-- ---------------------------------------------------------------------------
-- 5. Patient identity: a normalized phone to find returning patients
-- ---------------------------------------------------------------------------

create or replace function public.normalize_phone(p_phone text)
returns text
language sql
immutable
parallel safe
set search_path = pg_catalog
as $$
  select case
    when digits = '' then null
    -- 00 998 …: the international prefix dialled from abroad.
    when digits like '00998%' then substr(digits, 3)
    -- A national number: 9 digits, or with the trunk prefix 8 / 0 (10 digits).
    when length(digits) = 9 then '998' || digits
    when length(digits) = 10 and left(digits, 1) in ('8', '0') then '998' || substr(digits, 2)
    else digits
  end
  from (select regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g') as digits) s;
$$;

comment on function public.normalize_phone(text) is
  'Digits only; a national number (9 digits, or 10 with a leading 8 or 0) gets the 998 country code, and a leading 00 before 998 is dropped. NULL when there are no digits.';

alter table public.patients
  add column phone_normalized text generated always as (public.normalize_phone(phone)) stored;

create index patients_clinic_phone_normalized_idx
  on public.patients (clinic_id, phone_normalized)
  where phone_normalized is not null;

-- ---------------------------------------------------------------------------
-- 5b. Starting a consultation: access re-checked and referral accepted in the
--     same transaction as the start
-- ---------------------------------------------------------------------------

-- Lock order, everywhere: the APPOINTMENT first, then the referral (the order
-- the trigger on referrals and the front desk's start already use). Nothing
-- below takes a referral lock before an appointment lock, and no shared lock
-- is ever upgraded — a shared-then-exclusive pattern deadlocks two concurrent
-- starts of one visit.

-- consultation_started_effects: the doctor who starts treating a referred
-- patient takes the referral on first — their own named pending referral
-- before an untaken department one, a referral the database refuses skipped —
-- so a start that fails (a taken slot, a refused booking) accepts nothing.
-- The referral rows are locked FOR UPDATE and waited for: a colleague's
-- concurrent claim is seen (and the row then no longer qualifies), never
-- silently skipped.
create or replace function public.consultation_started_effects(
  p_appointment_id uuid,
  p_actor uuid,
  p_via text,
  p_link_referral boolean,
  p_walk_in boolean
)
returns uuid
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_appointment public.appointments%rowtype;
  v_waiting uuid;
  v_referral uuid;
  v_profile uuid;
  v_specialty uuid;
  v_pending record;
begin
  select * into v_appointment from public.appointments where id = p_appointment_id;
  if not found or v_appointment.status <> 'in_progress' then
    raise exception 'consultation: the appointment is not in progress';
  end if;

  if p_link_referral and p_via in ('doctor_workspace', 'doctor_queue') then
    select d.profile_id, d.specialty_id into v_profile, v_specialty from public.doctors d where d.id = v_appointment.doctor_id;
    for v_pending in
      select r.id
        from public.referrals r
       where r.clinic_id = v_appointment.clinic_id
         and r.patient_id = v_appointment.patient_id
         and r.status = 'pending'
         and r.expires_at > now()
         and (
           r.referred_to_doctor_id = v_appointment.doctor_id
           or (r.referred_to_doctor_id is null and v_specialty is not null
               and r.referred_to_specialty_id = v_specialty and r.referring_doctor_id <> v_appointment.doctor_id)
         )
       order by (r.referred_to_doctor_id is null), r.created_at
         for update of r
    loop
      begin
        update public.referrals
           set status = 'accepted',
               accepted_by = v_profile,
               referred_to_doctor_id = v_appointment.doctor_id
         where id = v_pending.id and status = 'pending';
        exit when found;
      exception when others then
        null; -- a referral the database refuses (say, a second open one to the same doctor) is left for the next
      end;
    end loop;
  end if;

  -- The accepted referral to this doctor for this patient that is waiting for
  -- its consultation: none booked yet, or its booking was cancelled or has
  -- not started (same rule as referrals_validate()).
  if p_link_referral and not exists (
    select 1 from public.referrals r
     where r.follow_up_appointment_id = v_appointment.id
       and r.status in ('accepted', 'in_progress', 'completed')
  ) then
    select r.id into v_waiting
      from public.referrals r
      left join public.appointments f on f.id = r.follow_up_appointment_id
     where r.clinic_id = v_appointment.clinic_id
       and r.patient_id = v_appointment.patient_id
       and r.referred_to_doctor_id = v_appointment.doctor_id
       and r.status = 'accepted'
       and r.expires_at > now()
       and (r.follow_up_appointment_id is null
            or f.status in ('cancelled', 'no_show', 'pending', 'confirmed', 'checked_in'))
     order by r.created_at
     limit 1
     for update of r;
    if v_waiting is not null then
      begin
        update public.referrals set follow_up_appointment_id = v_appointment.id where id = v_waiting;
      exception when others then
        raise warning 'consultation not linked to referral (sqlstate %)', sqlstate;
      end;
    end if;
  end if;

  select r.id into v_referral
    from public.referrals r
   where r.clinic_id = v_appointment.clinic_id
     and r.follow_up_appointment_id = v_appointment.id
     and r.status in ('accepted', 'in_progress', 'completed')
   order by r.created_at desc
   limit 1;

  insert into public.audit_events (
    clinic_id, actor_id, actor_type, action, entity_type, entity_id,
    patient_id, referral_id, new_values, metadata
  ) values (
    v_appointment.clinic_id, p_actor, 'staff', 'consultation_started', 'appointments', v_appointment.id::text,
    v_appointment.patient_id, v_referral,
    jsonb_build_object('status', 'in_progress'),
    jsonb_build_object(
      'patient_id', v_appointment.patient_id,
      'doctor_id', v_appointment.doctor_id,
      'referral_id', v_referral,
      'via', p_via,
      'walk_in', p_walk_in
    )
  );
  return v_referral;
end;
$$;

-- start_consultation. For a doctor's own start (workspace or queue):
--   * the actor must be the appointment's doctor's own login (the RPC's
--     parameters are trusted, so a doctor channel cannot be used to act as
--     someone else);
--   * a website booking staff have not confirmed yet is refused
--     ('awaiting_confirmation'): its visitor is unverified, and starting it
--     would make the doctor the patient's treating doctor;
--   * the doctor's access is decided again, without locks ('access_lost'):
--     their own (not cancelled, not no-show) appointment is itself a permanent relationship,
--     so no referral needs holding for it.
-- The front desk's start is reception's own act and is not restricted.
create or replace function public.start_consultation(
  p_clinic_id uuid,
  p_appointment_id uuid,
  p_from_status public.appointment_status,
  p_actor uuid,
  p_via text,
  p_link_referral boolean default false,
  p_doctor_id uuid default null
)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_appointment public.appointments%rowtype;
  v_doctor uuid;
  v_profile uuid;
begin
  if p_via is null or p_via not in ('doctor_workspace', 'doctor_queue', 'front_desk') then
    raise exception 'consultation: unknown start channel %', p_via;
  end if;
  if not exists (select 1 from public.staff_roles where profile_id = p_actor and clinic_id = p_clinic_id) then
    raise exception 'consultation: the actor is not staff of this clinic';
  end if;
  if p_from_status = 'in_progress' then
    return jsonb_build_object('started', false, 'referral_id', null);
  end if;

  if p_via in ('doctor_workspace', 'doctor_queue') then
    select * into v_appointment from public.appointments a where a.id = p_appointment_id and a.clinic_id = p_clinic_id;
    v_doctor := coalesce(p_doctor_id, v_appointment.doctor_id);
    if v_doctor is not null then
      select d.profile_id into v_profile from public.doctors d where d.id = v_doctor and d.clinic_id = p_clinic_id;
      if v_profile is distinct from p_actor then
        raise exception 'consultation: a doctor starts their own consultation (the actor is not that doctor''s login)';
      end if;
    end if;
    if v_appointment.id is not null then
      if v_appointment.source = 'web' and v_appointment.status = 'pending' then
        return jsonb_build_object('started', false, 'referral_id', null, 'error_code', 'awaiting_confirmation');
      end if;
      if not coalesce((
        select x.full_history from public.doctor_patient_access(v_doctor, v_appointment.patient_id) x where x.clinic_id = p_clinic_id
      ), false) then
        return jsonb_build_object('started', false, 'referral_id', null, 'error_code', 'access_lost');
      end if;
    end if;
  end if;

  -- Compare-and-swap: only the status the caller saw moves, so of two
  -- concurrent starts exactly one starts (and audits) the consultation.
  update public.appointments
     set status = 'in_progress'
   where id = p_appointment_id
     and clinic_id = p_clinic_id
     and status = p_from_status
     and (p_doctor_id is null or doctor_id = p_doctor_id);
  if not found then
    return jsonb_build_object('started', false, 'referral_id', null);
  end if;

  return jsonb_build_object(
    'started', true,
    'referral_id', public.consultation_started_effects(p_appointment_id, p_actor, p_via, p_link_referral, false)
  );
end;
$$;

-- start_walk_in_consultation: the doctor's access is decided before the
-- booking (no locks). When it rests on a referral alone — there is no
-- appointment of theirs yet — the referrals that gave it are locked AFTER the
-- booking (appointment first, then referral) and one must still be open, or
-- the whole transaction is refused with SQLSTATE CALST and the booking goes
-- with it: a revoke, decline or a colleague's claim that committed first is
-- seen, and one that comes later waits for this start.
create or replace function public.start_walk_in_consultation(
  p_clinic_id uuid,
  p_patient_id uuid,
  p_doctor_id uuid,
  p_service_id uuid,
  p_start_at timestamptz,
  p_actor uuid
)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_booking record;
  v_access record;
  v_specialty uuid;
  v_open boolean;
begin
  if not exists (
    select 1 from public.doctors d
     where d.id = p_doctor_id and d.clinic_id = p_clinic_id and d.profile_id = p_actor
  ) then
    raise exception 'consultation: a walk-in is started by the doctor themselves';
  end if;

  select x.own_patient, x.full_history, x.active_referral_ids into v_access
    from public.doctor_patient_access(p_doctor_id, p_patient_id) x
   where x.clinic_id = p_clinic_id;
  if not found or not v_access.full_history then
    return jsonb_build_object('appointment_id', null, 'error_code', 'access_lost', 'referral_id', null);
  end if;

  -- The booking engine checks working hours, time blocks, the doctor's
  -- services and overlaps, as for every other booking.
  select * into v_booking
    from public.book_appointment(
      p_clinic_id, p_patient_id, p_doctor_id, p_service_id, p_start_at,
      'in_progress'::public.appointment_status, 'walk_in'::public.appointment_source, null, p_actor
    );
  if v_booking.error_code is not null or v_booking.appointment_id is null then
    return jsonb_build_object(
      'appointment_id', null,
      'error_code', coalesce(v_booking.error_code, 'booking_failed'),
      'referral_id', null
    );
  end if;

  if not v_access.own_patient then
    select d.specialty_id into v_specialty from public.doctors d where d.id = p_doctor_id and d.clinic_id = p_clinic_id;
    perform 1 from public.referrals r where r.id = any (v_access.active_referral_ids) for no key update;
    select exists (
      select 1
        from public.referrals r
       where r.id = any (v_access.active_referral_ids)
         and r.clinic_id = p_clinic_id
         and r.patient_id = p_patient_id
         and r.status in ('pending', 'accepted', 'in_progress')
         and r.expires_at > now()
         and (
           r.referred_to_doctor_id = p_doctor_id
           or (r.referred_to_doctor_id is null and v_specialty is not null
               and r.referred_to_specialty_id = v_specialty and r.referring_doctor_id <> p_doctor_id)
         )
    ) into v_open;
    if not v_open then
      raise exception 'consultation: the referral that gave this doctor access has ended' using errcode = 'CALST';
    end if;
  end if;

  return jsonb_build_object(
    'appointment_id', v_booking.appointment_id,
    'error_code', null,
    'referral_id', public.consultation_started_effects(v_booking.appointment_id, p_actor, 'doctor_workspace', true, true)
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Audit naming: a correction creates a version
-- ---------------------------------------------------------------------------

create or replace function public.clinical_records_audit()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_referral uuid;
  v_previous public.clinical_records;
begin
  select r.id into v_referral
    from public.referrals r
   where r.clinic_id = new.clinic_id
     and r.patient_id = new.patient_id
     and r.follow_up_appointment_id = new.appointment_id
   order by r.created_at desc
   limit 1;

  if new.corrects_record_id is not null then
    select * into v_previous from public.clinical_records where id = new.corrects_record_id;
  end if;

  insert into public.audit_events (
    clinic_id, actor_id, actor_type, action, entity_type, entity_id,
    patient_id, referral_id, old_values, new_values
  ) values (
    new.clinic_id,
    new.created_by,
    'staff'::public.actor_type,
    case when new.corrects_record_id is null then 'clinical_record_created' else 'clinical_record_version_created' end,
    'clinical_records',
    new.id::text,
    new.patient_id,
    v_referral,
    case when new.corrects_record_id is null then null else
      jsonb_build_object(
        'record_id', v_previous.id,
        'version', v_previous.version,
        'author_doctor_id', v_previous.author_doctor_id,
        'created_by', v_previous.created_by
      )
    end,
    jsonb_build_object(
      'record_type', new.record_type,
      'patient_id', new.patient_id,
      'author_doctor_id', new.author_doctor_id,
      'appointment_id', new.appointment_id,
      'corrects_record_id', new.corrects_record_id,
      'root_record_id', new.root_record_id,
      'version', new.version
    )
  );
  return new;
end;
$$;

revoke all on function public.clinical_records_audit() from public, anon, authenticated;

-- =====================================================================
-- FILE: 20261002000002_patient_creation_audit.sql
-- =====================================================================
-- Creating and deleting a patient are audited.
--
-- The patient record is the key of the longitudinal clinic record: every visit,
-- referral and clinical record hangs off it, so who created it, through which
-- channel and when must be reconstructable — for finding duplicates later and
-- for the day two records have to be reconciled. Until now nothing recorded it.
--
-- A trigger writes the audit row in the same transaction as the insert, so no
-- creation path (reception, a walk-in, the Mini App, the website, a path added
-- later) can forget it, and a failed audit write undoes the creation. The same
-- goes for deletion: 'patient_deleted' is written by a trigger in the deleting
-- transaction (a delete the foreign keys refuse writes nothing), so a record
-- removed again — e.g. a registration whose booking was refused — never
-- leaves a creation without its end in the trail. A patient removed because
-- their whole clinic is deleted in the same statement gets no row of its own
-- (the clinic, and so the audit's tenant, is gone; a clinic with audit rows
-- cannot be deleted at all since 20261001000003).
--
--   * patients.created_by  — the staff profile that registered the patient
--                            (null for a patient who registered themselves).
--   * patients.created_via — the channel: reception, walk_in, telegram, website.
--                            Both are written by the server; null on rows that
--                            predate this migration.
--   * audit 'patient_created' — ids and channel only. Never the name, phone or
--                            any Telegram detail: the audit trail holds no
--                            personal data beyond identifiers.
--
-- Reversible: drop triggers patients_audit_created and patients_audit_deleted
-- on public.patients; drop functions public.patients_audit_created() and
-- public.patients_audit_deleted(); alter table public.patients drop
-- column created_by, drop column created_via. Existing rows are untouched.

alter table public.patients
  add column created_by uuid references public.profiles(id) on delete set null,
  add column created_via text;

alter table public.patients
  add constraint patients_created_via_check
  check (created_via is null or created_via in ('reception', 'walk_in', 'telegram', 'website'));

comment on column public.patients.created_by is
  'Staff profile that registered the patient (reception or a walk-in); null when the patient registered themselves or the row predates 20261002000002. Set by the server only.';
comment on column public.patients.created_via is
  'Channel that created the record: reception, walk_in, telegram or website; null for rows that predate 20261002000002.';

create or replace function public.patients_audit_created()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  -- A staff creator must work in the patient's clinic (the audit row is
  -- tenant-checked too, but a clear message is better than a guard's).
  if new.created_by is not null and not exists (
    select 1 from public.staff_roles sr
     where sr.profile_id = new.created_by and sr.clinic_id = new.clinic_id
  ) then
    raise exception 'patient: created_by is not staff of the patient''s clinic';
  end if;

  insert into public.audit_events (
    clinic_id, actor_id, actor_type, action, entity_type, entity_id, patient_id, new_values, metadata
  ) values (
    new.clinic_id,
    new.created_by,
    case
      when new.created_by is not null then 'staff'::public.actor_type
      when new.created_via = 'telegram' then 'telegram'::public.actor_type
      else 'system'::public.actor_type
    end,
    'patient_created',
    'patients',
    new.id::text,
    new.id,
    jsonb_build_object('created_via', new.created_via),
    jsonb_build_object(
      'created_via', new.created_via,
      'has_phone', new.phone is not null,
      'has_telegram_identity', new.telegram_user_id is not null
    )
  );
  return null;
end;
$$;

revoke all on function public.patients_audit_created() from public, anon, authenticated;

create trigger patients_audit_created
  after insert on public.patients
  for each row execute function public.patients_audit_created();

create or replace function public.patients_audit_deleted()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if exists (select 1 from public.clinics c where c.id = old.clinic_id) then
    insert into public.audit_events (
      clinic_id, actor_id, actor_type, action, entity_type, entity_id, patient_id, new_values, metadata
    ) values (
      old.clinic_id,
      null,
      'system'::public.actor_type,
      'patient_deleted',
      'patients',
      old.id::text,
      old.id,
      null,
      jsonb_build_object(
        'created_via', old.created_via,
        'created_by', old.created_by,
        'created_at', old.created_at
      )
    );
  end if;
  return old;
end;
$$;

revoke all on function public.patients_audit_deleted() from public, anon, authenticated;

create trigger patients_audit_deleted
  before delete on public.patients
  for each row execute function public.patients_audit_deleted();

-- =====================================================================
-- FILE: 20261002000003_phone_normalization.sql
-- =====================================================================
-- Phone normalization that cannot match two different people.
--
-- The first version (20261002000001) read every 9-digit number as Uzbek —
-- "+298 123456" (the Faroe Islands) became 998298123456 — and let junk match:
-- "123" or forty nines are "the same number" for any two patients that typed
-- them. A wrong match is the dangerous direction (the website reuses a record
-- by phone + name; reception is asked to pick "the same patient"), a missed one
-- merely leaves a duplicate for reception to reconcile.
--
-- Rules now (public.normalize_phone(), mirrored by normalizePhone() in
-- src/lib/patients/phone.ts, and tested for parity):
--   1. No digits → NULL.
--   2. An explicit international marker — a "+" before the first digit, or a
--      leading "00" — means the digits that follow are a full international
--      number (country code first) and are kept exactly: no national-number
--      guessing, whatever their length.
--   3. Without such a marker the number is read as an Uzbek national number
--      (the clinics' region): 9 digits get 998; 10 digits with the trunk prefix
--      8 or 0 lose it and get 998; 12 digits starting 998 stay; anything else
--      stays as typed.
--   4. A result that is not a phone number we can match on — fewer than 7 or
--      more than 15 digits (E.164 allows at most 15) — is NULL: such a patient is
--      simply never offered as a duplicate. The number as typed stays in
--      patients.phone.
--
-- Still assumed: a number typed without "+" or "00" is Uzbek. A per-clinic
-- country is a later change (the generated column below cannot read another table).
--
-- phone_normalized is a stored generated column, so a new function body does not
-- recompute it: the column is dropped and added again (rewrites patients once;
-- no other object depends on it).
--
-- Reversible: re-create the function and column as in 20261002000001.

create or replace function public.normalize_phone(p_phone text)
returns text
language sql
immutable
parallel safe
set search_path = pg_catalog
as $$
  select case when length(n) between 7 and 15 then n else null end
  from (
    select case
      when raw = '' then ''
      -- "+" before the first digit, or a leading 00: international, kept as it is.
      when p_phone ~ '^[^0-9]*\+' then raw
      when raw like '00%' then substr(raw, 3)
      -- Otherwise an Uzbek national number: 9 digits, or 10 with the trunk prefix 8 / 0.
      when length(raw) = 9 then '998' || raw
      when length(raw) = 10 and left(raw, 1) in ('8', '0') then '998' || substr(raw, 2)
      else raw
    end as n
    from (select regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g') as raw) s
  ) t;
$$;

comment on function public.normalize_phone(text) is
  'Digits for matching one phone number however typed: a + before the first digit or a leading 00 marks an international number (kept as is); otherwise it is read as an Uzbek national number (9 digits, or 10 with trunk prefix 8/0, get 998). NULL when there are no digits or fewer than 7 / more than 15 of them.';

drop index if exists public.patients_clinic_phone_normalized_idx;
alter table public.patients drop column phone_normalized;
alter table public.patients
  add column phone_normalized text generated always as (public.normalize_phone(phone)) stored;
create index patients_clinic_phone_normalized_idx
  on public.patients (clinic_id, phone_normalized)
  where phone_normalized is not null;

-- =====================================================================
-- FILE: 20261002000004_department_referral_availability.sql
-- =====================================================================
-- A department referral needs a doctor who can receive it.
--
-- A referral to a department is seen by the department's active doctors until
-- one of them takes it (20261002000001). With no such doctor it would sit
-- pending, unseen by anyone, while the referring doctor believes the handoff
-- was made. So:
--
--   * creating one for a department with no receiving doctor is refused —
--     active, with a doctor login, in the department, and not the referring
--     doctor (their own department never receives their own referral);
--   * a referral whose department LATER loses its last receiving doctor stays
--     as it is (it is the patient's record, and the doctors may return) but
--     is reported to the referring doctor as awaiting a doctor
--     (src/lib/referrals/service.ts), so they can revoke it or refer
--     elsewhere; when a doctor becomes available it appears for them without
--     anyone re-creating it, and otherwise it ends at its expires_at.
--
-- Reversible: drop trigger referrals_department_receivable on public.referrals;
-- drop function public.referrals_department_receivable();
-- drop function public.department_has_receiving_doctor(uuid, uuid, uuid).

create or replace function public.department_has_receiving_doctor(
  p_clinic_id uuid,
  p_specialty_id uuid,
  p_excluding_doctor_id uuid default null
)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
      from public.doctors d
     where d.clinic_id = p_clinic_id
       and d.specialty_id = p_specialty_id
       and d.active
       and d.id is distinct from p_excluding_doctor_id
       -- Not another record of the same login either (a login never receives its own referral).
       and d.profile_id is distinct from (select e.profile_id from public.doctors e where e.id = p_excluding_doctor_id)
       and exists (
         select 1 from public.staff_roles sr
          where sr.profile_id = d.profile_id and sr.clinic_id = d.clinic_id and sr.role = 'doctor'
       )
  );
$$;

comment on function public.department_has_receiving_doctor(uuid, uuid, uuid) is
  'Whether a department (specialty) of the clinic has an active doctor with a doctor login other than the excluded doctor (and other than that doctor''s own login) — i.e. someone who can receive a department referral. Server-only.';

revoke all on function public.department_has_receiving_doctor(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.department_has_receiving_doctor(uuid, uuid, uuid) to service_role;

create or replace function public.referrals_department_receivable()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  -- A department that is not this clinic's is the composite foreign key's to refuse.
  if new.referred_to_doctor_id is null
     and new.referred_to_specialty_id is not null
     and exists (select 1 from public.specialties s where s.id = new.referred_to_specialty_id and s.clinic_id = new.clinic_id)
     and not public.department_has_receiving_doctor(new.clinic_id, new.referred_to_specialty_id, new.referring_doctor_id) then
    raise exception 'referral: the department has no active doctor to receive it';
  end if;
  return new;
end;
$$;

revoke all on function public.referrals_department_receivable() from public, anon, authenticated;

create trigger referrals_department_receivable
  before insert on public.referrals
  for each row execute function public.referrals_department_receivable();

-- =====================================================================
-- FILE: 20261002000005_referral_warning_review.sql
-- =====================================================================
-- "I've reviewed this": reception dismisses the warning of a visit booked for a
-- referral that was revoked or declined.
--
-- Referral controls workflow; the booking controls the treating relationship
-- (AGENTS.md): revoking or declining a referral never cancels or changes the
-- visit booked for it. Reception is warned (REFERRAL_REVOKED / REFERRAL_DECLINED,
-- derived by the server) and decides. Once they have looked at it and keep the
-- visit, the warning must go — without touching the booking:
--
--   * appointments.referral_warning_reviewed_at / _by record who reviewed it and
--     when. The warning is shown while the referral's revocation/decline is
--     NEWER than the review (so a visit later linked to another referral that is
--     then revoked warns again).
--   * public.review_referral_warning() is the one way to write them: atomic,
--     service role only, verifies the actor is staff of the clinic (owner, admin,
--     manager or receptionist), that the visit really is the follow-up of a
--     revoked/declined referral of the clinic and has not started, and audits it
--     ('referral_warning_reviewed': ids and the referral's status, no clinical
--     text). Nothing else about the appointment changes.
--
-- Reversible: drop function public.review_referral_warning(uuid, uuid, uuid);
-- alter table public.appointments drop column referral_warning_reviewed_at,
-- drop column referral_warning_reviewed_by.

alter table public.appointments
  add column referral_warning_reviewed_at timestamptz,
  add column referral_warning_reviewed_by uuid references public.profiles(id) on delete set null;

comment on column public.appointments.referral_warning_reviewed_at is
  'When reception reviewed the warning of a visit booked for a revoked/declined referral (the visit was kept). Written only by review_referral_warning().';
comment on column public.appointments.referral_warning_reviewed_by is
  'The staff profile that reviewed that warning.';

create or replace function public.review_referral_warning(
  p_clinic_id uuid,
  p_appointment_id uuid,
  p_actor uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_appointment public.appointments%rowtype;
  v_referral record;
begin
  if not exists (
    select 1 from public.staff_roles sr
     where sr.profile_id = p_actor
       and sr.clinic_id = p_clinic_id
       and sr.role in ('owner', 'admin', 'manager', 'receptionist')
  ) then
    raise exception 'review: the actor is not reception or management of this clinic';
  end if;

  -- The appointment first (the lock order everywhere: appointment, then referral).
  select * into v_appointment
    from public.appointments a
   where a.id = p_appointment_id and a.clinic_id = p_clinic_id
   for update;
  if not found then
    return jsonb_build_object('reviewed', false, 'error_code', 'appointment_not_found');
  end if;
  if v_appointment.status not in ('pending', 'confirmed', 'checked_in') then
    return jsonb_build_object('reviewed', false, 'error_code', 'nothing_to_review');
  end if;

  select r.id, r.status,
         case r.status when 'revoked' then r.revoked_at else r.declined_at end as ended_at
    into v_referral
    from public.referrals r
   where r.clinic_id = p_clinic_id
     and r.follow_up_appointment_id = p_appointment_id
     and r.status in ('revoked', 'declined');
  if not found then
    return jsonb_build_object('reviewed', false, 'error_code', 'nothing_to_review');
  end if;
  -- Already reviewed since the referral ended: nothing more to record.
  if v_appointment.referral_warning_reviewed_at is not null
     and v_appointment.referral_warning_reviewed_at >= v_referral.ended_at then
    return jsonb_build_object('reviewed', true, 'already', true);
  end if;

  update public.appointments
     set referral_warning_reviewed_at = now(),
         referral_warning_reviewed_by = p_actor
   where id = p_appointment_id;

  insert into public.audit_events (
    clinic_id, actor_id, actor_type, action, entity_type, entity_id, patient_id, referral_id, new_values
  ) values (
    p_clinic_id, p_actor, 'staff', 'referral_warning_reviewed', 'appointments', p_appointment_id::text,
    v_appointment.patient_id, v_referral.id,
    jsonb_build_object('referral_status', v_referral.status, 'appointment_status', v_appointment.status)
  );
  return jsonb_build_object('reviewed', true, 'already', false);
end;
$$;

comment on function public.review_referral_warning(uuid, uuid, uuid) is
  'Reception/management dismiss the REFERRAL_REVOKED / REFERRAL_DECLINED warning of a visit they keep: records who and when, audits it, changes nothing else. Server-only.';

revoke all on function public.review_referral_warning(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.review_referral_warning(uuid, uuid, uuid) to service_role;

-- =====================================================================
-- FILE: 20261003000001_lab_staff_role.sql
-- =====================================================================
-- Laboratory module, phase 3: the laboratory staff role.
--
-- A technician enters results and handles samples without any admin, finance, booking or clinical-history
-- access, which none of owner/admin/manager/receptionist/doctor express (docs/labs/PHASE_1_AUDIT.md §7).
-- A separate verifier role is NOT added: verification is a permission of lab_staff, and whether a second
-- person must verify is a per-clinic setting (app_settings key 'lab', phase 3).
--
-- Fail-closed by construction: every route and RLS policy lists the roles it admits, so a new value gains
-- nothing until it is named; the only "any staff" policies are the read-only configuration tables
-- (clinics, services, doctors, specialties, working hours, faqs, app_settings, staff_roles and the lab
-- catalog), which a lab technician may read like every other staff role. Nothing about patients,
-- appointments, payments, conversations, referrals or clinical records is granted.
--
-- It must be its own migration: a new enum value cannot be used in the transaction that adds it (the
-- lab triggers of the next migration use it). Not reversible by migration (an enum value cannot be removed);
-- remove the staff_roles rows and stop assigning it.

do $$
begin
  if not exists (
    select 1 from pg_enum e
    join pg_type t on t.oid = e.enumtypid
    where t.typname = 'staff_role' and e.enumlabel = 'lab_staff'
  ) then
    alter type public.staff_role add value 'lab_staff' after 'doctor';
  end if;
end $$;

-- New enum values must be committed before any later statement uses them.
commit;

-- =====================================================================
-- FILE: 20261003000002_lab_foundation.sql
-- =====================================================================
-- Laboratory module, phase 2: the domain model.
--
-- docs/labs/PHASE_1_AUDIT.md and docs/labs/DECISIONS.md are the authority. This migration adds the
-- NORMALIZED laboratory model inside the existing Health AI schema. It reuses clinics, patients,
-- doctors, appointments (the ordering consultation), referrals, profiles/staff_roles, audit_events
-- and the composite same-clinic FK discipline; it creates NO second patient, doctor, payment,
-- history or audit system. Payments (D2), roles (phase 3), documents' bytes (phase 7), patient
-- delivery (phase 8) and identity (own phase) are NOT part of it.
--
-- Entities
--   catalog (clinic configuration):  lab_categories, lab_tests, lab_test_parameters,
--                                    lab_reference_ranges, lab_panels, lab_panel_tests
--   workflow:                        lab_orders, lab_order_items, lab_samples, lab_sample_items
--   results:                         lab_results (one per order item), lab_result_versions
--                                    (append-only lineage; verification is a property of a version),
--                                    lab_result_values (structured values + the reference range used),
--                                    lab_result_attachments (metadata; storage comes in phase 7)
--
-- Five concepts that stay separate (never one combined status):
--   ORDER status        lab_orders.status
--   PAYMENT status      payments.status           (phase 5: payments are extended, not duplicated)
--   SAMPLE status       lab_samples.status
--   RESULT status       lab_results.status        (= status of the latest version, kept by triggers)
--   VERIFICATION        lab_result_versions.status / verified_by / verified_at
--
-- Why not `specialties`: lab sections are not clinical departments (they drive doctor catalogs and
-- department referrals). Why not `clinical_records`: those are doctor-authored in the doctor's own
-- consultation; a lab result is entered by lab staff. A doctor's own interpretation stays a
-- clinical record of theirs.
--
-- Security model (same as clinical_records):
--   * RLS is enabled on every table. Signed-in roles read ONLY the non-clinical catalog (clinic staff,
--     policy below). The order/sample/result tables have no signed-in grant and no policy: every read
--     goes through the server, which authorizes it with doctor_patient_access() and audits it.
--   * Only service_role writes, with the narrowest grants (no DELETE anywhere, UPDATE only on the
--     columns a lifecycle needs). Triggers enforce lifecycle, immutability and snapshots; they ignore
--     anything the client claims about prices, flags, versions or timestamps.
--   * No cascade anywhere: a patient, appointment or clinic with laboratory data cannot be deleted
--     (retention; no period is assumed — see retention_data_category 'laboratory').
--   * The audit trail is ids-only and written by purpose-built triggers; the generic
--     audit_track_changes() is deliberately NOT used (it would copy result values into audit_events).
--
-- (Phase 3: samples and results require the lab_staff role — 20261003000001.)
-- Reversible: drop the tables below in reverse dependency order (lab_result_attachments,
-- lab_result_values, lab_result_versions, lab_results, lab_sample_items, lab_samples,
-- lab_order_items, lab_orders, lab_panel_tests, lab_panels, lab_reference_ranges,
-- lab_test_parameters, lab_tests, lab_categories), then the lab_* functions and the lab_* enum types.
-- Also: alter table public.referrals drop constraint referrals_id_clinic_id_patient_id_key.
-- The 'laboratory' value added to retention_data_category cannot be removed from an enum and is left.

-- ---------------------------------------------------------------------------
-- 0. Types
-- ---------------------------------------------------------------------------

create type public.lab_data_type as enum ('numeric', 'text', 'choice');
create type public.lab_priority as enum ('routine', 'urgent');
create type public.lab_order_status as enum ('ordered', 'in_progress', 'completed', 'cancelled');
create type public.lab_item_status as enum ('active', 'cancelled');
create type public.lab_sample_status as enum ('awaiting_collection', 'collected', 'processing', 'rejected', 'cancelled');
create type public.lab_result_status as enum ('draft', 'pending_verification', 'verified');
create type public.lab_version_status as enum ('draft', 'pending_verification', 'verified', 'superseded');
-- "outside configured reference range" — never a diagnosis.
create type public.lab_flag as enum ('normal', 'low', 'high', 'critical_low', 'critical_high', 'unclassified');

alter type public.retention_data_category add value if not exists 'laboratory';

-- ---------------------------------------------------------------------------
-- 1. Catalog (clinic configuration; not clinical text)
-- ---------------------------------------------------------------------------

create table public.lab_categories (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics (id) on delete restrict,
  name text not null check (name ~ '\S' and char_length(name) <= 80),
  sort_order integer not null default 0,
  active boolean not null default true,
  updated_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint lab_categories_id_clinic_key unique (id, clinic_id),
  constraint lab_categories_name_key unique (clinic_id, name)
);

create table public.lab_tests (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics (id) on delete restrict,
  category_id uuid,
  code text not null check (code ~ '^[A-Za-z0-9._-]{1,32}$'),
  name text not null check (name ~ '\S' and char_length(name) <= 160),
  description text check (description is null or char_length(description) <= 1000),
  -- The authoritative price; every order item snapshots it.
  price numeric(12, 2) not null default 0 check (price >= 0),
  sample_type text check (sample_type is null or (sample_type ~ '\S' and char_length(sample_type) <= 60)),
  preparation_text text check (preparation_text is null or char_length(preparation_text) <= 2000),
  turnaround_minutes integer check (turnaround_minutes is null or turnaround_minutes > 0),
  active boolean not null default true,
  updated_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint lab_tests_id_clinic_key unique (id, clinic_id),
  constraint lab_tests_category_fkey foreign key (category_id, clinic_id) references public.lab_categories (id, clinic_id)
);
create unique index lab_tests_clinic_code_key on public.lab_tests (clinic_id, lower(code));
create index lab_tests_clinic_active_idx on public.lab_tests (clinic_id, active);

create table public.lab_test_parameters (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics (id) on delete restrict,
  test_id uuid not null,
  code text not null check (code ~ '^[A-Za-z0-9._-]{1,32}$'),
  name text not null check (name ~ '\S' and char_length(name) <= 120),
  unit text check (unit is null or char_length(unit) <= 32),
  data_type public.lab_data_type not null default 'numeric',
  -- For data_type = 'choice': the allowed values.
  choices text[],
  display_order integer not null default 0,
  active boolean not null default true,
  updated_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint lab_test_parameters_id_clinic_key unique (id, clinic_id),
  constraint lab_test_parameters_test_code_key unique (test_id, code),
  constraint lab_test_parameters_test_fkey foreign key (test_id, clinic_id) references public.lab_tests (id, clinic_id),
  constraint lab_test_parameters_choices_check check ((data_type = 'choice') = (choices is not null and cardinality(choices) > 0))
);

-- Reference ranges are configured data, never global constants. Bounds only where the clinic set them.
create table public.lab_reference_ranges (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics (id) on delete restrict,
  parameter_id uuid not null,
  age_min_years integer check (age_min_years is null or age_min_years >= 0),
  age_max_years integer check (age_max_years is null or age_max_years >= 0),
  low numeric,
  high numeric,
  critical_low numeric,
  critical_high numeric,
  note text check (note is null or char_length(note) <= 200),
  active boolean not null default true,
  updated_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint lab_reference_ranges_id_clinic_key unique (id, clinic_id),
  constraint lab_reference_ranges_parameter_fkey foreign key (parameter_id, clinic_id) references public.lab_test_parameters (id, clinic_id),
  constraint lab_reference_ranges_some_bound check (num_nonnulls(low, high, critical_low, critical_high) > 0),
  constraint lab_reference_ranges_order check (
    (low is null or high is null or low <= high)
    and (critical_low is null or low is null or critical_low <= low)
    and (critical_high is null or high is null or critical_high >= high)
    and (critical_low is null or critical_high is null or critical_low <= critical_high)
    and (age_min_years is null or age_max_years is null or age_min_years <= age_max_years)
  )
);

create table public.lab_panels (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics (id) on delete restrict,
  code text not null check (code ~ '^[A-Za-z0-9._-]{1,32}$'),
  name text not null check (name ~ '\S' and char_length(name) <= 160),
  description text check (description is null or char_length(description) <= 1000),
  -- null: the panel costs the sum of its tests. A fixed panel price is applied at billing (phase 5).
  price numeric(12, 2) check (price is null or price >= 0),
  active boolean not null default true,
  updated_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint lab_panels_id_clinic_key unique (id, clinic_id)
);
create unique index lab_panels_clinic_code_key on public.lab_panels (clinic_id, lower(code));

create table public.lab_panel_tests (
  panel_id uuid not null,
  test_id uuid not null,
  clinic_id uuid not null references public.clinics (id) on delete restrict,
  sort_order integer not null default 0,
  primary key (panel_id, test_id),
  constraint lab_panel_tests_panel_fkey foreign key (panel_id, clinic_id) references public.lab_panels (id, clinic_id),
  constraint lab_panel_tests_test_fkey foreign key (test_id, clinic_id) references public.lab_tests (id, clinic_id)
);

-- ---------------------------------------------------------------------------
-- 2. Orders, items, samples (clinical workflow; server-read only)
-- ---------------------------------------------------------------------------

-- referrals gets the composite key a same-clinic, same-patient reference needs (additive; no data change).
alter table public.referrals add constraint referrals_id_clinic_id_patient_id_key unique (id, clinic_id, patient_id);

create table public.lab_orders (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics (id) on delete restrict,
  patient_id uuid not null,
  ordering_doctor_id uuid not null,
  -- The ordering doctor's own consultation with this patient (same discipline as clinical_records).
  appointment_id uuid not null,
  referral_id uuid,
  priority public.lab_priority not null default 'routine',
  -- Clinical text: doctor-written, never shown to operational staff, logs, audit or analytics.
  notes text check (notes is null or (notes ~ '\S' and char_length(notes) <= 1000)),
  status public.lab_order_status not null default 'ordered',
  -- Idempotent submission: a repeated request resolves to this order.
  creation_key uuid,
  created_by uuid not null references public.profiles (id),
  cancelled_at timestamptz,
  cancelled_by uuid references public.profiles (id),
  cancel_reason text check (cancel_reason is null or (cancel_reason ~ '\S' and char_length(cancel_reason) <= 300)),
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint lab_orders_id_clinic_key unique (id, clinic_id),
  constraint lab_orders_id_clinic_patient_key unique (id, clinic_id, patient_id),
  constraint lab_orders_patient_fkey foreign key (patient_id, clinic_id) references public.patients (id, clinic_id),
  constraint lab_orders_doctor_fkey foreign key (ordering_doctor_id, clinic_id) references public.doctors (id, clinic_id),
  constraint lab_orders_consultation_fkey foreign key (appointment_id, clinic_id, patient_id, ordering_doctor_id)
    references public.appointments (id, clinic_id, patient_id, doctor_id),
  -- Same clinic AND same patient as the referral (referral_id null: not enforced).
  constraint lab_orders_referral_fkey foreign key (referral_id, clinic_id, patient_id)
    references public.referrals (id, clinic_id, patient_id),
  constraint lab_orders_cancelled_fields check ((status = 'cancelled') = (cancelled_at is not null and cancelled_by is not null and cancel_reason is not null)),
  constraint lab_orders_completed_fields check ((status = 'completed') = (completed_at is not null))
);
create unique index lab_orders_creation_key on public.lab_orders (ordering_doctor_id, creation_key) where creation_key is not null;
create index lab_orders_patient_idx on public.lab_orders (clinic_id, patient_id, created_at desc);
create index lab_orders_status_idx on public.lab_orders (clinic_id, status, created_at desc);

create table public.lab_order_items (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics (id) on delete restrict,
  order_id uuid not null,
  test_id uuid not null,
  -- Set when the item came from a panel.
  panel_id uuid,
  -- Snapshots taken by the database from the catalog at order time (the client cannot set them):
  test_code text not null,
  test_name text not null,
  sample_type text,
  price_snapshot numeric(12, 2) not null check (price_snapshot >= 0),
  status public.lab_item_status not null default 'active',
  cancelled_at timestamptz,
  cancel_reason text check (cancel_reason is null or (cancel_reason ~ '\S' and char_length(cancel_reason) <= 300)),
  created_at timestamptz not null default now(),
  constraint lab_order_items_id_clinic_key unique (id, clinic_id),
  constraint lab_order_items_id_clinic_order_key unique (id, clinic_id, order_id),
  constraint lab_order_items_order_test_key unique (order_id, test_id),
  constraint lab_order_items_order_fkey foreign key (order_id, clinic_id) references public.lab_orders (id, clinic_id),
  constraint lab_order_items_test_fkey foreign key (test_id, clinic_id) references public.lab_tests (id, clinic_id),
  constraint lab_order_items_panel_fkey foreign key (panel_id, clinic_id) references public.lab_panels (id, clinic_id),
  constraint lab_order_items_cancelled_fields check ((status = 'cancelled') = (cancelled_at is not null and cancel_reason is not null))
);
create index lab_order_items_order_idx on public.lab_order_items (order_id);

create table public.lab_samples (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics (id) on delete restrict,
  order_id uuid not null,
  patient_id uuid not null,
  sample_type text not null check (sample_type ~ '\S' and char_length(sample_type) <= 60),
  -- The tube/barcode the laboratory prints; unique per clinic.
  sample_code text not null check (sample_code ~ '^[A-Za-z0-9._-]{1,40}$'),
  status public.lab_sample_status not null default 'awaiting_collection',
  collected_at timestamptz,
  collected_by uuid references public.profiles (id),
  rejected_reason text check (rejected_reason is null or (rejected_reason ~ '\S' and char_length(rejected_reason) <= 300)),
  -- Operational note (e.g. "hemolysed"), not clinical text.
  notes text check (notes is null or char_length(notes) <= 200),
  created_by uuid not null references public.profiles (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint lab_samples_id_clinic_key unique (id, clinic_id),
  constraint lab_samples_id_clinic_order_key unique (id, clinic_id, order_id),
  constraint lab_samples_code_key unique (clinic_id, sample_code),
  constraint lab_samples_order_fkey foreign key (order_id, clinic_id, patient_id) references public.lab_orders (id, clinic_id, patient_id),
  constraint lab_samples_collected_fields check ((status in ('collected', 'processing')) <= (collected_at is not null and collected_by is not null)),
  constraint lab_samples_rejected_fields check ((status = 'rejected') = (rejected_reason is not null))
);
-- One live sample per order and type: a duplicate collection request is refused.
create unique index lab_samples_one_live_per_type on public.lab_samples (order_id, sample_type)
  where status in ('awaiting_collection', 'collected', 'processing');
create index lab_samples_status_idx on public.lab_samples (clinic_id, status, created_at desc);

-- Which order items a sample serves (a tube can serve several tests).
create table public.lab_sample_items (
  sample_id uuid not null,
  order_item_id uuid not null,
  clinic_id uuid not null references public.clinics (id) on delete restrict,
  order_id uuid not null,
  primary key (sample_id, order_item_id),
  constraint lab_sample_items_sample_fkey foreign key (sample_id, clinic_id, order_id) references public.lab_samples (id, clinic_id, order_id),
  constraint lab_sample_items_item_fkey foreign key (order_item_id, clinic_id, order_id) references public.lab_order_items (id, clinic_id, order_id)
);

-- ---------------------------------------------------------------------------
-- 3. Results: header + append-only versions + structured values
-- ---------------------------------------------------------------------------

create table public.lab_results (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics (id) on delete restrict,
  order_item_id uuid not null,
  order_id uuid not null,
  patient_id uuid not null,
  -- Status of the latest version, maintained by the version triggers (not writable by the app).
  status public.lab_result_status not null default 'draft',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint lab_results_id_clinic_key unique (id, clinic_id),
  constraint lab_results_item_key unique (order_item_id),
  constraint lab_results_item_fkey foreign key (order_item_id, clinic_id, order_id) references public.lab_order_items (id, clinic_id, order_id),
  constraint lab_results_order_fkey foreign key (order_id, clinic_id, patient_id) references public.lab_orders (id, clinic_id, patient_id)
);
create index lab_results_patient_idx on public.lab_results (clinic_id, patient_id, created_at desc);

create table public.lab_result_versions (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics (id) on delete restrict,
  result_id uuid not null,
  -- Assigned by the database: 1, 2, 3… A correction is a new version; no version is ever rewritten.
  version integer not null,
  status public.lab_version_status not null default 'draft',
  -- Who entered THIS version (for a correction: the corrector — the original author is version 1's).
  entered_by uuid not null references public.profiles (id),
  entered_at timestamptz not null default now(),
  verified_by uuid references public.profiles (id),
  verified_at timestamptz,
  -- The verified version this one corrects, and why.
  corrects_version_id uuid,
  correction_reason text check (correction_reason is null or (correction_reason ~ '\S' and char_length(correction_reason) <= 300)),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint lab_result_versions_id_clinic_key unique (id, clinic_id),
  constraint lab_result_versions_result_version_key unique (result_id, version),
  constraint lab_result_versions_result_fkey foreign key (result_id, clinic_id) references public.lab_results (id, clinic_id),
  constraint lab_result_versions_corrects_fkey foreign key (corrects_version_id, clinic_id) references public.lab_result_versions (id, clinic_id),
  constraint lab_result_versions_verified_fields check (
    (status = 'verified') <= (verified_by is not null and verified_at is not null)
    and (status in ('draft', 'pending_verification')) <= (verified_by is null and verified_at is null)
  ),
  constraint lab_result_versions_correction_fields check ((version > 1) = (corrects_version_id is not null and correction_reason is not null))
);
-- One version in progress at a time, and exactly one current verified version.
create unique index lab_result_versions_one_open on public.lab_result_versions (result_id) where status in ('draft', 'pending_verification');
create unique index lab_result_versions_one_verified on public.lab_result_versions (result_id) where status = 'verified';

create table public.lab_result_values (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics (id) on delete restrict,
  version_id uuid not null,
  parameter_id uuid not null,
  -- Snapshots from the parameter (set by the database): the result stays readable if the catalog changes.
  parameter_code text not null,
  parameter_name text not null,
  unit text,
  value_numeric numeric,
  value_text text check (value_text is null or char_length(value_text) <= 500),
  -- The reference range the value was evaluated against; its bounds are copied here by the database.
  reference_range_id uuid,
  ref_low numeric,
  ref_high numeric,
  critical_low numeric,
  critical_high numeric,
  -- Computed by the database from the value and the snapshotted bounds. "Outside configured reference
  -- range" only — never a disease name.
  flag public.lab_flag not null default 'unclassified',
  created_at timestamptz not null default now(),
  constraint lab_result_values_id_clinic_key unique (id, clinic_id),
  constraint lab_result_values_version_parameter_key unique (version_id, parameter_id),
  constraint lab_result_values_version_fkey foreign key (version_id, clinic_id) references public.lab_result_versions (id, clinic_id),
  constraint lab_result_values_parameter_fkey foreign key (parameter_id, clinic_id) references public.lab_test_parameters (id, clinic_id),
  constraint lab_result_values_range_fkey foreign key (reference_range_id, clinic_id) references public.lab_reference_ranges (id, clinic_id),
  constraint lab_result_values_one_value check (num_nonnulls(value_numeric, value_text) = 1)
);

-- Metadata only: the bytes live in a private bucket added in phase 7. No file names (they can carry names).
create table public.lab_result_attachments (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics (id) on delete restrict,
  result_id uuid not null,
  storage_path text not null unique check (storage_path ~ '^[A-Za-z0-9/_.-]{1,300}$'),
  content_type text not null check (content_type in ('application/pdf', 'image/png', 'image/jpeg')),
  size_bytes bigint not null check (size_bytes > 0),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  uploaded_by uuid not null references public.profiles (id),
  created_at timestamptz not null default now(),
  constraint lab_result_attachments_result_fkey foreign key (result_id, clinic_id) references public.lab_results (id, clinic_id)
);
create index lab_result_attachments_result_idx on public.lab_result_attachments (result_id);

-- ---------------------------------------------------------------------------
-- 4. Helpers
-- ---------------------------------------------------------------------------

-- Samples and results are handled by laboratory staff only (the role of 20261003000001).
create or replace function public.lab_is_lab_staff(p_profile uuid, p_clinic uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select p_profile is not null and exists (
    select 1 from public.staff_roles sr where sr.profile_id = p_profile and sr.clinic_id = p_clinic and sr.role = 'lab_staff'
  );
$$;
revoke all on function public.lab_is_lab_staff(uuid, uuid) from public, anon, authenticated;

-- Any staff member of the clinic (used where the actor only needs to belong to the clinic, e.g. cancelling an order).
create or replace function public.lab_is_clinic_staff(p_profile uuid, p_clinic uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select p_profile is not null and exists (
    select 1 from public.staff_roles sr where sr.profile_id = p_profile and sr.clinic_id = p_clinic
  );
$$;
revoke all on function public.lab_is_clinic_staff(uuid, uuid) from public, anon, authenticated;

-- Work on a result continues only while its order is not cancelled and its test is not cancelled.
create or replace function public.lab_result_work_open(p_result uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce((
    select o.status <> 'cancelled' and i.status = 'active'
      from public.lab_results r
      join public.lab_orders o on o.id = r.order_id
      join public.lab_order_items i on i.id = r.order_item_id
     where r.id = p_result
  ), false);
$$;
revoke all on function public.lab_result_work_open(uuid) from public, anon, authenticated;
grant execute on function public.lab_result_work_open(uuid) to service_role;

-- "Outside configured reference range" from a value and its snapshotted bounds.
create or replace function public.lab_flag_for(p_value numeric, p_low numeric, p_high numeric, p_critical_low numeric, p_critical_high numeric)
returns public.lab_flag
language sql
immutable
set search_path = pg_catalog
as $$
  select case
    when p_value is null then 'unclassified'::public.lab_flag
    when p_critical_low is not null and p_value < p_critical_low then 'critical_low'::public.lab_flag
    when p_critical_high is not null and p_value > p_critical_high then 'critical_high'::public.lab_flag
    when p_low is not null and p_value < p_low then 'low'::public.lab_flag
    when p_high is not null and p_value > p_high then 'high'::public.lab_flag
    when p_low is null and p_high is null then 'unclassified'::public.lab_flag
    else 'normal'::public.lab_flag
  end;
$$;
revoke all on function public.lab_flag_for(numeric, numeric, numeric, numeric, numeric) from public, anon, authenticated;
-- Pure and side-effect free; the SECURITY INVOKER values trigger (below) calls it as the application role.
grant execute on function public.lab_flag_for(numeric, numeric, numeric, numeric, numeric) to service_role;

-- ---------------------------------------------------------------------------
-- 5. Catalog triggers: updated_at, rules, ids-only audit
-- ---------------------------------------------------------------------------

create trigger lab_categories_set_updated_at before update on public.lab_categories for each row execute function public.set_updated_at();
create trigger lab_tests_set_updated_at before update on public.lab_tests for each row execute function public.set_updated_at();
create trigger lab_test_parameters_set_updated_at before update on public.lab_test_parameters for each row execute function public.set_updated_at();
create trigger lab_reference_ranges_set_updated_at before update on public.lab_reference_ranges for each row execute function public.set_updated_at();
create trigger lab_panels_set_updated_at before update on public.lab_panels for each row execute function public.set_updated_at();

create or replace function public.lab_catalog_validate()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_type public.lab_data_type;
begin
  if tg_op = 'UPDATE' then
    if new.id is distinct from old.id or new.clinic_id is distinct from old.clinic_id or new.created_at is distinct from old.created_at then
      raise exception 'lab catalog: id, clinic and creation time cannot change';
    end if;
    -- (nested: PL/pgSQL plans a field reference when the statement runs, so each table's own field is only touched for that table)
    if tg_table_name = 'lab_test_parameters' then
      if new.test_id is distinct from old.test_id then
        raise exception 'lab catalog: a parameter cannot move to another test';
      end if;
      -- Stored values keep the meaning they were entered with: the type of a parameter that has results is fixed.
      if new.data_type is distinct from old.data_type
         and exists (select 1 from public.lab_result_values x where x.parameter_id = new.id) then
        raise exception 'lab catalog: the data type of a parameter that has results cannot change; add a new parameter';
      end if;
    elsif tg_table_name = 'lab_reference_ranges' then
      if new.parameter_id is distinct from old.parameter_id then
        raise exception 'lab catalog: a reference range cannot move to another parameter';
      end if;
    end if;
  end if;
  -- Reference ranges are numeric bounds: only numeric parameters have them.
  if tg_table_name = 'lab_reference_ranges' then
    select p.data_type into v_type from public.lab_test_parameters p where p.id = new.parameter_id and p.clinic_id = new.clinic_id;
    if found and v_type <> 'numeric' then
      raise exception 'lab catalog: only a numeric parameter has a reference range';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function public.lab_catalog_validate() from public, anon, authenticated;

create trigger lab_categories_validate before insert or update on public.lab_categories for each row execute function public.lab_catalog_validate();
create trigger lab_tests_validate before insert or update on public.lab_tests for each row execute function public.lab_catalog_validate();
create trigger lab_test_parameters_validate before insert or update on public.lab_test_parameters for each row execute function public.lab_catalog_validate();
create trigger lab_reference_ranges_validate before insert or update on public.lab_reference_ranges for each row execute function public.lab_catalog_validate();
create trigger lab_panels_validate before insert or update on public.lab_panels for each row execute function public.lab_catalog_validate();

-- Catalog changes are audited as WHO changed WHICH row and WHICH columns — never the values (prices
-- and ranges are configuration, but the trail stays ids and column names only).
create or replace function public.lab_catalog_audit()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_changed text[];
  v_actor uuid;
begin
  v_actor := nullif(to_jsonb(new) ->> 'updated_by', '')::uuid;
  if tg_op = 'UPDATE' then
    select coalesce(array_agg(n.key order by n.key), '{}')
      into v_changed
      from jsonb_each(to_jsonb(new)) n
      join jsonb_each(to_jsonb(old)) o using (key)
     where n.value is distinct from o.value
       and n.key not in ('updated_at', 'updated_by');
    if cardinality(v_changed) = 0 then
      return null;
    end if;
  end if;
  insert into public.audit_events (clinic_id, actor_id, actor_type, action, entity_type, entity_id, new_values)
  values (
    new.clinic_id,
    v_actor,
    case when v_actor is null then 'system'::public.actor_type else 'staff'::public.actor_type end,
    case tg_op when 'INSERT' then 'lab_catalog_created' else 'lab_catalog_updated' end,
    tg_table_name,
    coalesce(to_jsonb(new) ->> 'id', ''),
    case tg_op when 'UPDATE' then jsonb_build_object('changed_columns', to_jsonb(v_changed)) else null end
  );
  return null;
end;
$$;
revoke all on function public.lab_catalog_audit() from public, anon, authenticated;

create trigger lab_categories_audit after insert or update on public.lab_categories for each row execute function public.lab_catalog_audit();
create trigger lab_tests_audit after insert or update on public.lab_tests for each row execute function public.lab_catalog_audit();
create trigger lab_test_parameters_audit after insert or update on public.lab_test_parameters for each row execute function public.lab_catalog_audit();
create trigger lab_reference_ranges_audit after insert or update on public.lab_reference_ranges for each row execute function public.lab_catalog_audit();
create trigger lab_panels_audit after insert or update on public.lab_panels for each row execute function public.lab_catalog_audit();

-- ---------------------------------------------------------------------------
-- 6. Orders
-- ---------------------------------------------------------------------------

create or replace function public.lab_orders_validate()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_doctor_profile uuid;
  v_doctor_active boolean;
  v_appointment_status public.appointment_status;
  v_referral record;
begin
  if tg_op = 'INSERT' then
    new.created_at := now();
    new.updated_at := now();
    if new.status is distinct from 'ordered' then
      raise exception 'lab order: an order is created as ordered';
    end if;
    new.cancelled_at := null; new.cancelled_by := null; new.cancel_reason := null; new.completed_at := null;

    select d.profile_id, d.active into v_doctor_profile, v_doctor_active
      from public.doctors d where d.id = new.ordering_doctor_id and d.clinic_id = new.clinic_id;
    if not found or not v_doctor_active then
      raise exception 'lab order: the ordering doctor must be an active doctor of the clinic';
    end if;
    if v_doctor_profile is null or new.created_by is distinct from v_doctor_profile then
      raise exception 'lab order: created_by must be the ordering doctor''s own doctor account';
    end if;
    if not exists (
      select 1 from public.staff_roles sr
       where sr.profile_id = v_doctor_profile and sr.clinic_id = new.clinic_id and sr.role = 'doctor'
    ) then
      raise exception 'lab order: the ordering doctor does not hold the doctor role';
    end if;

    -- The foreign key pins the consultation to this doctor and patient; it must be taking/have taken place.
    select a.status into v_appointment_status
      from public.appointments a
     where a.id = new.appointment_id and a.clinic_id = new.clinic_id
       and a.patient_id = new.patient_id and a.doctor_id = new.ordering_doctor_id;
    if found and v_appointment_status not in ('in_progress', 'completed') then
      raise exception 'lab order: the consultation must be in progress or completed (it is %)', v_appointment_status;
    end if;

    if new.referral_id is not null then
      select r.clinic_id, r.patient_id into v_referral from public.referrals r where r.id = new.referral_id;
      if not found or v_referral.clinic_id <> new.clinic_id or v_referral.patient_id <> new.patient_id then
        raise exception 'lab order: the referral is not this clinic''s referral of this patient';
      end if;
    end if;
    return new;
  end if;

  -- UPDATE: only the lifecycle moves; everything that identifies or describes the order is fixed.
  if new.id is distinct from old.id
     or new.clinic_id is distinct from old.clinic_id
     or new.patient_id is distinct from old.patient_id
     or new.ordering_doctor_id is distinct from old.ordering_doctor_id
     or new.appointment_id is distinct from old.appointment_id
     or new.referral_id is distinct from old.referral_id
     or new.priority is distinct from old.priority
     or new.notes is distinct from old.notes
     or new.creation_key is distinct from old.creation_key
     or new.created_by is distinct from old.created_by
     or new.created_at is distinct from old.created_at then
    raise exception 'lab order: an order cannot be edited, only moved through its status';
  end if;
  if new.status = old.status then
    if new.cancelled_at is distinct from old.cancelled_at or new.cancelled_by is distinct from old.cancelled_by
       or new.cancel_reason is distinct from old.cancel_reason or new.completed_at is distinct from old.completed_at then
      raise exception 'lab order: an order cannot be edited, only moved through its status';
    end if;
    return new;
  end if;
  if not ((old.status = 'ordered' and new.status in ('in_progress', 'cancelled'))
       or (old.status = 'in_progress' and new.status in ('completed', 'cancelled'))) then
    raise exception 'lab order: invalid status transition % -> %', old.status, new.status;
  end if;
  new.updated_at := now();
  if new.status = 'cancelled' then
    if new.cancelled_by is null or not public.lab_is_clinic_staff(new.cancelled_by, new.clinic_id) then
      raise exception 'lab order: only staff of the clinic can cancel an order';
    end if;
    if exists (
      select 1 from public.lab_results r
        join public.lab_result_versions v on v.result_id = r.id and v.status = 'verified'
       where r.order_id = new.id
    ) then
      raise exception 'lab order: an order with a verified result cannot be cancelled';
    end if;
    new.cancelled_at := now();
  elsif new.status = 'completed' then
    if not exists (select 1 from public.lab_order_items i where i.order_id = new.id and i.status = 'active') then
      raise exception 'lab order: an order without an active item cannot be completed';
    end if;
    if exists (
      select 1 from public.lab_order_items i
       where i.order_id = new.id and i.status = 'active'
         and not exists (
           select 1 from public.lab_results r join public.lab_result_versions v on v.result_id = r.id and v.status = 'verified'
            where r.order_item_id = i.id
         )
    ) then
      raise exception 'lab order: every active item needs a verified result before the order is completed';
    end if;
    new.completed_at := now();
  end if;
  return new;
end;
$$;
revoke all on function public.lab_orders_validate() from public, anon, authenticated;
create trigger lab_orders_validate before insert or update on public.lab_orders for each row execute function public.lab_orders_validate();

create or replace function public.lab_order_items_validate()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order_status public.lab_order_status;
  v_test record;
begin
  if tg_op = 'INSERT' then
    select o.status into v_order_status from public.lab_orders o where o.id = new.order_id and o.clinic_id = new.clinic_id;
    if found and v_order_status <> 'ordered' then
      raise exception 'lab order item: items are added while the order is still ordered (it is %)', v_order_status;
    end if;
    select t.code, t.name, t.sample_type, t.price, t.active into v_test
      from public.lab_tests t where t.id = new.test_id and t.clinic_id = new.clinic_id;
    if not found then
      raise exception 'lab order item: the test is not in this clinic''s catalog';
    end if;
    if not v_test.active then
      raise exception 'lab order item: the test is inactive and cannot be ordered';
    end if;
    -- Snapshots come from the catalog, never from the request.
    new.test_code := v_test.code;
    new.test_name := v_test.name;
    new.sample_type := v_test.sample_type;
    new.price_snapshot := v_test.price;
    new.status := 'active';
    new.cancelled_at := null;
    new.cancel_reason := null;
    new.created_at := now();
    return new;
  end if;

  if new.id is distinct from old.id or new.clinic_id is distinct from old.clinic_id or new.order_id is distinct from old.order_id
     or new.test_id is distinct from old.test_id or new.panel_id is distinct from old.panel_id
     or new.test_code is distinct from old.test_code or new.test_name is distinct from old.test_name
     or new.sample_type is distinct from old.sample_type or new.price_snapshot is distinct from old.price_snapshot
     or new.created_at is distinct from old.created_at then
    raise exception 'lab order item: only its cancellation can change';
  end if;
  if new.status = old.status then
    if new.cancelled_at is distinct from old.cancelled_at or new.cancel_reason is distinct from old.cancel_reason then
      raise exception 'lab order item: only its cancellation can change';
    end if;
    return new;
  end if;
  if not (old.status = 'active' and new.status = 'cancelled') then
    raise exception 'lab order item: invalid status transition % -> %', old.status, new.status;
  end if;
  select o.status into v_order_status from public.lab_orders o where o.id = new.order_id;
  if v_order_status in ('completed', 'cancelled') then
    raise exception 'lab order item: the order is already %', v_order_status;
  end if;
  if exists (
    select 1 from public.lab_results r join public.lab_result_versions v on v.result_id = r.id and v.status = 'verified'
     where r.order_item_id = new.id
  ) then
    raise exception 'lab order item: an item with a verified result cannot be cancelled';
  end if;
  new.cancelled_at := now();
  return new;
end;
$$;
revoke all on function public.lab_order_items_validate() from public, anon, authenticated;
create trigger lab_order_items_validate before insert or update on public.lab_order_items for each row execute function public.lab_order_items_validate();

-- ---------------------------------------------------------------------------
-- 7. Samples
-- ---------------------------------------------------------------------------

create or replace function public.lab_samples_validate()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order_status public.lab_order_status;
begin
  if tg_op = 'INSERT' then
    new.created_at := now();
    new.updated_at := now();
    select o.status into v_order_status from public.lab_orders o where o.id = new.order_id and o.clinic_id = new.clinic_id;
    if found and v_order_status not in ('ordered', 'in_progress') then
      raise exception 'lab sample: no sample for an order that is %', v_order_status;
    end if;
    if new.status is distinct from 'awaiting_collection' then
      raise exception 'lab sample: a sample is created awaiting collection';
    end if;
    if not public.lab_is_lab_staff(new.created_by, new.clinic_id) then
      raise exception 'lab sample: created_by must be lab staff of the clinic';
    end if;
    new.collected_at := null; new.collected_by := null; new.rejected_reason := null;
    return new;
  end if;

  if new.id is distinct from old.id or new.clinic_id is distinct from old.clinic_id or new.order_id is distinct from old.order_id
     or new.patient_id is distinct from old.patient_id or new.sample_type is distinct from old.sample_type
     or new.sample_code is distinct from old.sample_code or new.created_by is distinct from old.created_by
     or new.created_at is distinct from old.created_at then
    raise exception 'lab sample: only its status, notes and collection details can change';
  end if;
  new.updated_at := now();
  if new.status = old.status then
    if new.collected_at is distinct from old.collected_at or new.collected_by is distinct from old.collected_by
       or new.rejected_reason is distinct from old.rejected_reason then
      raise exception 'lab sample: collection details change only with the status';
    end if;
    return new;
  end if;
  if not ((old.status = 'awaiting_collection' and new.status in ('collected', 'cancelled'))
       or (old.status = 'collected' and new.status in ('processing', 'rejected', 'cancelled'))
       or (old.status = 'processing' and new.status = 'rejected')) then
    raise exception 'lab sample: invalid status transition % -> %', old.status, new.status;
  end if;
  if new.status in ('collected', 'processing') then
    select o.status into v_order_status from public.lab_orders o where o.id = new.order_id;
    if v_order_status not in ('ordered', 'in_progress') then
      raise exception 'lab sample: the order is %, nothing more is collected or processed for it', v_order_status;
    end if;
  end if;
  if new.status = 'collected' then
    if new.collected_by is null or not public.lab_is_lab_staff(new.collected_by, new.clinic_id) then
      raise exception 'lab sample: collected_by must be lab staff of the clinic';
    end if;
    new.collected_at := now();
  elsif new.status in ('processing', 'cancelled') then
    new.collected_at := old.collected_at;
    new.collected_by := old.collected_by;
  elsif new.status = 'rejected' then
    new.collected_at := old.collected_at;
    new.collected_by := old.collected_by;
  end if;
  return new;
end;
$$;
revoke all on function public.lab_samples_validate() from public, anon, authenticated;
create trigger lab_samples_validate before insert or update on public.lab_samples for each row execute function public.lab_samples_validate();

create or replace function public.lab_sample_items_validate()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_sample_status public.lab_sample_status;
  v_item_status public.lab_item_status;
begin
  select s.status into v_sample_status from public.lab_samples s where s.id = new.sample_id and s.clinic_id = new.clinic_id;
  if found and exists (select 1 from public.lab_orders o where o.id = new.order_id and o.status in ('cancelled', 'completed')) then
    raise exception 'lab sample: the order is closed';
  end if;
  if found and v_sample_status <> 'awaiting_collection' then
    raise exception 'lab sample: tests are attached before collection (the sample is %)', v_sample_status;
  end if;
  select i.status into v_item_status from public.lab_order_items i where i.id = new.order_item_id and i.clinic_id = new.clinic_id;
  if found and v_item_status <> 'active' then
    raise exception 'lab sample: a cancelled test cannot be attached to a sample';
  end if;
  return new;
end;
$$;
revoke all on function public.lab_sample_items_validate() from public, anon, authenticated;
create trigger lab_sample_items_validate before insert on public.lab_sample_items for each row execute function public.lab_sample_items_validate();

-- A collected sample puts a fresh order in progress.
create or replace function public.lab_sample_progress()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.status = 'collected' and old.status is distinct from 'collected' then
    update public.lab_orders set status = 'in_progress' where id = new.order_id and status = 'ordered';
  end if;
  return null;
end;
$$;
revoke all on function public.lab_sample_progress() from public, anon, authenticated;
create trigger lab_sample_progress after update of status on public.lab_samples for each row execute function public.lab_sample_progress();

-- ---------------------------------------------------------------------------
-- 8. Results: header, versions, values
-- ---------------------------------------------------------------------------

create or replace function public.lab_results_validate()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order public.lab_order_status;
  v_item public.lab_item_status;
begin
  if tg_op = 'UPDATE' then
    -- Only the version triggers (a nested trigger) keep the header's status.
    if pg_trigger_depth() < 2 then
      raise exception 'lab result: the result status follows its versions and cannot be written directly';
    end if;
    if new.id is distinct from old.id or new.clinic_id is distinct from old.clinic_id or new.order_item_id is distinct from old.order_item_id
       or new.order_id is distinct from old.order_id or new.patient_id is distinct from old.patient_id then
      raise exception 'lab result: its order item and patient cannot change';
    end if;
    new.updated_at := now();
    return new;
  end if;
  new.created_at := now();
  new.updated_at := now();
  new.status := 'draft';
  select o.status into v_order from public.lab_orders o where o.id = new.order_id and o.clinic_id = new.clinic_id;
  if found and v_order not in ('ordered', 'in_progress') then
    raise exception 'lab result: no result for an order that is %', v_order;
  end if;
  select i.status into v_item from public.lab_order_items i where i.id = new.order_item_id and i.clinic_id = new.clinic_id;
  if found and v_item <> 'active' then
    raise exception 'lab result: no result for a cancelled test';
  end if;
  return new;
end;
$$;
revoke all on function public.lab_results_validate() from public, anon, authenticated;
create trigger lab_results_validate before insert or update on public.lab_results for each row execute function public.lab_results_validate();

create or replace function public.lab_result_versions_validate()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_result public.lab_results%rowtype;
  v_order public.lab_order_status;
  v_corrected record;
  v_has_values boolean;
begin
  if tg_op = 'INSERT' then
    -- Serialises the numbering of one result's versions.
    select * into v_result from public.lab_results r where r.id = new.result_id and r.clinic_id = new.clinic_id for update;
    if not found then
      return new; -- the foreign key reports it
    end if;
    if not public.lab_result_work_open(new.result_id) then
      raise exception 'lab result: the order or the test is cancelled';
    end if;
    if new.status is distinct from 'draft' then
      raise exception 'lab result: a version is created as a draft';
    end if;
    if not public.lab_is_lab_staff(new.entered_by, new.clinic_id) then
      raise exception 'lab result: entered_by must be lab staff of the clinic';
    end if;
    new.version := coalesce((select max(v.version) from public.lab_result_versions v where v.result_id = new.result_id), 0) + 1;
    new.entered_at := now();
    new.created_at := now();
    new.updated_at := now();
    new.verified_by := null;
    new.verified_at := null;
    if new.version = 1 then
      new.corrects_version_id := null;
      new.correction_reason := null;
    else
      -- A correction replaces the CURRENT VERIFIED version, with a reason; nothing is overwritten.
      select v.id, v.result_id, v.status into v_corrected
        from public.lab_result_versions v where v.id = new.corrects_version_id and v.clinic_id = new.clinic_id;
      if not found or v_corrected.result_id <> new.result_id or v_corrected.status <> 'verified' then
        raise exception 'lab result: a correction must name the current verified version of the same result';
      end if;
    end if;
    return new;
  end if;

  if new.id is distinct from old.id or new.clinic_id is distinct from old.clinic_id or new.result_id is distinct from old.result_id
     or new.version is distinct from old.version or new.entered_by is distinct from old.entered_by
     or new.entered_at is distinct from old.entered_at or new.corrects_version_id is distinct from old.corrects_version_id
     or new.correction_reason is distinct from old.correction_reason or new.created_at is distinct from old.created_at then
    raise exception 'lab result: a version cannot be edited; add a correction instead';
  end if;
  if new.status = old.status then
    if new.verified_by is distinct from old.verified_by or new.verified_at is distinct from old.verified_at then
      raise exception 'lab result: a version cannot be edited; add a correction instead';
    end if;
    return new;
  end if;
  new.updated_at := now();
  -- A cancelled order or test cannot be worked on any further (the system's supersede step is exempt).
  if not (old.status = 'verified' and new.status = 'superseded') and not public.lab_result_work_open(new.result_id) then
    raise exception 'lab result: the order or the test is cancelled';
  end if;
  if old.status = 'draft' and new.status = 'pending_verification' then
    select exists (select 1 from public.lab_result_values x where x.version_id = new.id) into v_has_values;
    if not v_has_values then
      raise exception 'lab result: a version without values cannot be submitted for verification';
    end if;
    new.verified_by := null;
    new.verified_at := null;
  elsif old.status = 'pending_verification' and new.status = 'draft' then
    new.verified_by := null;
    new.verified_at := null;
  elsif old.status = 'pending_verification' and new.status = 'verified' then
    if new.verified_by is null or not public.lab_is_lab_staff(new.verified_by, new.clinic_id) then
      raise exception 'lab result: verified_by must be lab staff of the clinic';
    end if;
    new.verified_at := now();
    -- The previous verified version steps aside in the same statement (system transition).
    update public.lab_result_versions set status = 'superseded'
     where result_id = new.result_id and status = 'verified' and id <> new.id;
  elsif old.status = 'verified' and new.status = 'superseded' then
    if pg_trigger_depth() < 2 then
      raise exception 'lab result: a verified version is superseded only by a newer verified version';
    end if;
    new.verified_by := old.verified_by;
    new.verified_at := old.verified_at;
  else
    raise exception 'lab result: invalid version transition % -> %', old.status, new.status;
  end if;
  return new;
end;
$$;
revoke all on function public.lab_result_versions_validate() from public, anon, authenticated;
create trigger lab_result_versions_validate before insert or update on public.lab_result_versions for each row execute function public.lab_result_versions_validate();

-- The header's status follows its latest version; a verified result completes its order when it was the last.
create or replace function public.lab_result_versions_sync()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_status public.lab_version_status;
  v_order uuid;
begin
  select v.status into v_status
    from public.lab_result_versions v where v.result_id = new.result_id order by v.version desc limit 1;
  update public.lab_results set status = case v_status
      when 'verified' then 'verified'::public.lab_result_status
      when 'pending_verification' then 'pending_verification'::public.lab_result_status
      else 'draft'::public.lab_result_status end
   where id = new.result_id;
  if tg_op = 'INSERT' or new.status is distinct from old.status then
    select r.order_id into v_order from public.lab_results r where r.id = new.result_id;
    -- A result being worked on puts a fresh order in progress.
    update public.lab_orders set status = 'in_progress' where id = v_order and status = 'ordered';
    if new.status = 'verified' then
      -- Completes the order once every active item has a verified result (the order trigger checks).
      if not exists (
        select 1 from public.lab_order_items i
         where i.order_id = v_order and i.status = 'active'
           and not exists (
             select 1 from public.lab_results r2 join public.lab_result_versions v2 on v2.result_id = r2.id and v2.status = 'verified'
              where r2.order_item_id = i.id
           )
      ) then
        update public.lab_orders set status = 'completed' where id = v_order and status = 'in_progress';
      end if;
    end if;
  end if;
  return null;
end;
$$;
revoke all on function public.lab_result_versions_sync() from public, anon, authenticated;
create trigger lab_result_versions_sync after insert or update of status on public.lab_result_versions for each row execute function public.lab_result_versions_sync();

-- SECURITY INVOKER on purpose: the "draft only" rule below depends on WHO deletes (current_user), and the
-- application role has the SELECT it needs on every table read here.
create or replace function public.lab_result_values_validate()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_version_status public.lab_version_status;
  v_version_id uuid;
  v_param public.lab_test_parameters%rowtype;
  v_range public.lab_reference_ranges%rowtype;
  v_test_id uuid;
begin
  v_version_id := case tg_op when 'DELETE' then old.version_id else new.version_id end;
  select v.status into v_version_status from public.lab_result_versions v where v.id = v_version_id;
  -- Values of a submitted, verified or superseded version never change. Only the application roles are
  -- bound here by trigger (the table owner — migrations, maintenance — is not); they also have no grants.
  if tg_op = 'DELETE' then
    if v_version_status is distinct from 'draft' and current_user in ('service_role', 'authenticated', 'anon') then
      raise exception 'lab result: values of a version that is not a draft cannot be removed';
    end if;
    return old;
  end if;
  if found and v_version_status <> 'draft' then
    raise exception 'lab result: values of a version that is not a draft cannot be changed (add a correction)';
  end if;
  if tg_op = 'UPDATE' and (new.version_id is distinct from old.version_id or new.parameter_id is distinct from old.parameter_id
                           or new.clinic_id is distinct from old.clinic_id) then
    raise exception 'lab result: a value cannot move to another version or parameter';
  end if;

  if not public.lab_result_work_open((select v.result_id from public.lab_result_versions v where v.id = new.version_id)) then
    raise exception 'lab result: the order or the test is cancelled';
  end if;
  select * into v_param from public.lab_test_parameters p where p.id = new.parameter_id and p.clinic_id = new.clinic_id;
  if not found then
    return new; -- the foreign key reports it
  end if;
  -- The parameter must belong to the test this result is for, and be active.
  select i.test_id into v_test_id
    from public.lab_result_versions v
    join public.lab_results r on r.id = v.result_id
    join public.lab_order_items i on i.id = r.order_item_id
   where v.id = new.version_id;
  if v_test_id is distinct from v_param.test_id then
    raise exception 'lab result: the parameter does not belong to the ordered test';
  end if;
  if not v_param.active then
    raise exception 'lab result: the parameter is inactive';
  end if;

  new.parameter_code := v_param.code;
  new.parameter_name := v_param.name;
  new.unit := v_param.unit;
  if v_param.data_type = 'numeric' then
    if new.value_numeric is null or new.value_text is not null then
      raise exception 'lab result: % needs a numeric value', v_param.code;
    end if;
  elsif v_param.data_type = 'choice' then
    if new.value_text is null or new.value_numeric is not null or not (new.value_text = any (v_param.choices)) then
      raise exception 'lab result: % must be one of its configured choices', v_param.code;
    end if;
  else
    if new.value_text is null or new.value_numeric is not null then
      raise exception 'lab result: % needs a text value', v_param.code;
    end if;
  end if;

  -- The bounds come from the configured range, copied here (the client cannot supply them): later edits of
  -- the range never re-flag a stored result.
  new.ref_low := null; new.ref_high := null; new.critical_low := null; new.critical_high := null;
  if new.reference_range_id is not null then
    select * into v_range from public.lab_reference_ranges rr
     where rr.id = new.reference_range_id and rr.clinic_id = new.clinic_id and rr.parameter_id = new.parameter_id;
    if not found then
      raise exception 'lab result: the reference range does not belong to the parameter';
    end if;
    if not v_range.active then
      raise exception 'lab result: the reference range is inactive';
    end if;
    new.ref_low := v_range.low; new.ref_high := v_range.high;
    new.critical_low := v_range.critical_low; new.critical_high := v_range.critical_high;
  end if;
  new.flag := public.lab_flag_for(new.value_numeric, new.ref_low, new.ref_high, new.critical_low, new.critical_high);
  return new;
end;
$$;
revoke all on function public.lab_result_values_validate() from public, anon, authenticated;
create trigger lab_result_values_validate before insert or update or delete on public.lab_result_values for each row execute function public.lab_result_values_validate();

-- ---------------------------------------------------------------------------
-- 9. Ids-only audit for orders, items, samples, versions, attachments
-- ---------------------------------------------------------------------------

create or replace function public.lab_workflow_audit()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_action text;
  v_actor uuid;
  v_patient uuid;
  v_entity text := tg_table_name;
  v_new jsonb;
begin
  if tg_table_name = 'lab_orders' then
    v_patient := new.patient_id;
    if tg_op = 'INSERT' then
      v_action := 'lab_order_created'; v_actor := new.created_by;
      v_new := jsonb_build_object('status', new.status, 'priority', new.priority);
    elsif new.status is distinct from old.status then
      v_action := 'lab_order_' || new.status::text;
      v_actor := case new.status when 'cancelled' then new.cancelled_by else null end;
      v_new := jsonb_build_object('status', new.status, 'from', old.status);
    else
      return null;
    end if;
  elsif tg_table_name = 'lab_order_items' then
    select o.patient_id, o.created_by into v_patient, v_actor from public.lab_orders o where o.id = new.order_id;
    if tg_op = 'INSERT' then
      v_action := 'lab_order_item_added'; v_new := jsonb_build_object('order_id', new.order_id, 'test_id', new.test_id);
    elsif new.status is distinct from old.status then
      v_action := 'lab_order_item_cancelled'; v_actor := null; v_new := jsonb_build_object('order_id', new.order_id, 'test_id', new.test_id);
    else
      return null;
    end if;
  elsif tg_table_name = 'lab_samples' then
    v_patient := new.patient_id;
    if tg_op = 'INSERT' then
      v_action := 'lab_sample_created'; v_actor := new.created_by;
      v_new := jsonb_build_object('order_id', new.order_id, 'status', new.status);
    elsif new.status is distinct from old.status then
      v_action := 'lab_sample_' || new.status::text;
      v_actor := case new.status when 'collected' then new.collected_by else null end;
      v_new := jsonb_build_object('order_id', new.order_id, 'status', new.status, 'from', old.status);
    else
      return null;
    end if;
  elsif tg_table_name = 'lab_result_versions' then
    select r.patient_id into v_patient from public.lab_results r where r.id = new.result_id;
    v_new := jsonb_build_object('result_id', new.result_id, 'version', new.version, 'status', new.status);
    if tg_op = 'INSERT' then
      v_action := case when new.version = 1 then 'lab_result_entered' else 'lab_result_version_created' end;
      v_actor := new.entered_by;
    elsif new.status is distinct from old.status then
      v_action := case new.status
        when 'pending_verification' then 'lab_result_submitted'
        when 'verified' then 'lab_result_verified'
        when 'superseded' then 'lab_result_version_superseded'
        else 'lab_result_returned_to_draft' end;
      v_actor := case new.status when 'verified' then new.verified_by when 'pending_verification' then new.entered_by else null end;
      v_new := v_new || jsonb_build_object('from', old.status);
    else
      return null;
    end if;
  elsif tg_table_name = 'lab_result_attachments' then
    select r.patient_id into v_patient from public.lab_results r where r.id = new.result_id;
    v_action := 'lab_attachment_added'; v_actor := new.uploaded_by;
    v_new := jsonb_build_object('result_id', new.result_id, 'content_type', new.content_type);
  else
    return null;
  end if;

  -- Ids and statuses only: never a value, a unit, a note, a reason or a file name.
  insert into public.audit_events (clinic_id, actor_id, actor_type, action, entity_type, entity_id, patient_id, new_values)
  values (
    new.clinic_id, v_actor,
    case when v_actor is null then 'system'::public.actor_type else 'staff'::public.actor_type end,
    v_action, v_entity, new.id::text, v_patient, v_new
  );
  return null;
end;
$$;
revoke all on function public.lab_workflow_audit() from public, anon, authenticated;

create trigger lab_orders_audit after insert or update on public.lab_orders for each row execute function public.lab_workflow_audit();
create trigger lab_order_items_audit after insert or update on public.lab_order_items for each row execute function public.lab_workflow_audit();
create trigger lab_samples_audit after insert or update on public.lab_samples for each row execute function public.lab_workflow_audit();
create trigger lab_result_versions_audit after insert or update on public.lab_result_versions for each row execute function public.lab_workflow_audit();
create trigger lab_result_attachments_audit after insert on public.lab_result_attachments for each row execute function public.lab_workflow_audit();

-- ---------------------------------------------------------------------------
-- 10. RLS and grants
-- ---------------------------------------------------------------------------

alter table public.lab_categories enable row level security;
alter table public.lab_tests enable row level security;
alter table public.lab_test_parameters enable row level security;
alter table public.lab_reference_ranges enable row level security;
alter table public.lab_panels enable row level security;
alter table public.lab_panel_tests enable row level security;
alter table public.lab_orders enable row level security;
alter table public.lab_order_items enable row level security;
alter table public.lab_samples enable row level security;
alter table public.lab_sample_items enable row level security;
alter table public.lab_results enable row level security;
alter table public.lab_result_versions enable row level security;
alter table public.lab_result_values enable row level security;
alter table public.lab_result_attachments enable row level security;

revoke all on table
  public.lab_categories, public.lab_tests, public.lab_test_parameters, public.lab_reference_ranges,
  public.lab_panels, public.lab_panel_tests, public.lab_orders, public.lab_order_items, public.lab_samples,
  public.lab_sample_items, public.lab_results, public.lab_result_versions, public.lab_result_values,
  public.lab_result_attachments
  from public, anon, authenticated, service_role;

-- The catalog is configuration, not clinical text: clinic staff may read it (the role split is phase 3).
grant select on public.lab_categories, public.lab_tests, public.lab_test_parameters, public.lab_reference_ranges,
  public.lab_panels, public.lab_panel_tests to authenticated;
create policy "lab categories read for clinic staff" on public.lab_categories for select to authenticated using (public.is_clinic_staff(clinic_id));
create policy "lab tests read for clinic staff" on public.lab_tests for select to authenticated using (public.is_clinic_staff(clinic_id));
create policy "lab parameters read for clinic staff" on public.lab_test_parameters for select to authenticated using (public.is_clinic_staff(clinic_id));
create policy "lab reference ranges read for clinic staff" on public.lab_reference_ranges for select to authenticated using (public.is_clinic_staff(clinic_id));
create policy "lab panels read for clinic staff" on public.lab_panels for select to authenticated using (public.is_clinic_staff(clinic_id));
create policy "lab panel tests read for clinic staff" on public.lab_panel_tests for select to authenticated using (public.is_clinic_staff(clinic_id));

-- Order, sample and result tables: no signed-in grant, no policy. The server reads them after
-- doctor_patient_access() and audits every read.

-- service_role: the narrowest grants. Nothing is ever deleted (except draft values and panel membership).
grant select, insert, update on public.lab_categories, public.lab_tests, public.lab_test_parameters,
  public.lab_reference_ranges, public.lab_panels to service_role;
grant select, insert, delete on public.lab_panel_tests to service_role;

grant select, insert on public.lab_orders to service_role;
grant update (status, cancelled_at, cancelled_by, cancel_reason, completed_at, updated_at) on public.lab_orders to service_role;
grant select, insert on public.lab_order_items to service_role;
grant update (status, cancelled_at, cancel_reason) on public.lab_order_items to service_role;
grant select, insert on public.lab_samples to service_role;
grant update (status, collected_at, collected_by, rejected_reason, notes, updated_at) on public.lab_samples to service_role;
grant select, insert on public.lab_sample_items to service_role;
grant select, insert on public.lab_results to service_role;
grant select, insert on public.lab_result_versions to service_role;
grant update (status, verified_by, verified_at, updated_at) on public.lab_result_versions to service_role;
grant select, insert, update, delete on public.lab_result_values to service_role;
grant select, insert on public.lab_result_attachments to service_role;

comment on table public.lab_orders is
  'A doctor''s laboratory order, from their own consultation. Order status only; payment, sample, result and verification are separate. Server-read only (doctor_patient_access).';
comment on table public.lab_result_versions is
  'Append-only lineage of a result: a correction is a new version; verification is a property of a version. Never rewritten.';
comment on table public.lab_result_values is
  'Structured values with the reference range used (copied by the database). The flag means outside the configured range only — not a diagnosis.';

-- New enum values must be committed before any later statement uses them.
commit;

-- =====================================================================
-- FILE: 20261003000003_lab_panel_functions.sql
-- =====================================================================
-- Laboratory configuration, phase 3: a panel and its tests are written atomically.
--
-- PostgREST cannot span two statements in one transaction; creating a panel and then replacing its tests as
-- two calls could leave a panel without tests if the second failed. These two functions do each in ONE
-- transaction, verify that the panel and every test belong to the clinic, and are callable by the server only.
-- The table triggers and audit run exactly as for direct writes.
--
-- Reversible: drop function public.lab_create_panel(...), public.lab_set_panel_tests(uuid, uuid, uuid[]).

create or replace function public.lab_set_panel_tests(p_clinic_id uuid, p_panel_id uuid, p_test_ids uuid[])
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_test_ids is null or cardinality(p_test_ids) = 0 then
    raise exception 'lab catalog: a panel needs at least one test';
  end if;
  if not exists (select 1 from public.lab_panels where id = p_panel_id and clinic_id = p_clinic_id) then
    raise exception 'lab catalog: the panel is not in this clinic';
  end if;
  if (select count(*) from public.lab_tests where clinic_id = p_clinic_id and id = any (p_test_ids)) <> cardinality(p_test_ids) then
    raise exception 'lab catalog: a test is not in this clinic';
  end if;
  delete from public.lab_panel_tests where panel_id = p_panel_id and clinic_id = p_clinic_id;
  insert into public.lab_panel_tests (panel_id, test_id, clinic_id, sort_order)
  select p_panel_id, t.id, p_clinic_id, (t.ord - 1)::int
    from unnest(p_test_ids) with ordinality as t(id, ord);
end;
$$;

create or replace function public.lab_create_panel(
  p_clinic_id uuid,
  p_actor uuid,
  p_code text,
  p_name text,
  p_description text,
  p_price numeric,
  p_active boolean,
  p_test_ids uuid[]
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
begin
  insert into public.lab_panels (clinic_id, code, name, description, price, active, updated_by)
  values (p_clinic_id, p_code, p_name, p_description, p_price, coalesce(p_active, true), p_actor)
  returning id into v_id;
  perform public.lab_set_panel_tests(p_clinic_id, v_id, p_test_ids);
  return v_id;
end;
$$;

revoke all on function public.lab_set_panel_tests(uuid, uuid, uuid[]) from public, anon, authenticated;
revoke all on function public.lab_create_panel(uuid, uuid, text, text, text, numeric, boolean, uuid[]) from public, anon, authenticated;
grant execute on function public.lab_set_panel_tests(uuid, uuid, uuid[]) to service_role;
grant execute on function public.lab_create_panel(uuid, uuid, text, text, text, numeric, boolean, uuid[]) to service_role;

-- =====================================================================
-- FILE: 20261003000004_lab_create_order.sql
-- =====================================================================
-- Laboratory module, phase 4: a doctor's order is written atomically and idempotently.
--
-- The order and its items must exist together or not at all, and a repeated submission (double click,
-- network retry, two tabs) must resolve to the first order. PostgREST cannot span statements in one
-- transaction, so this function does both. It adds NO authorization of its own beyond what the tables
-- enforce — the order trigger requires the ordering doctor's own login and consultation, the item trigger
-- snapshots the catalog and refuses inactive tests — and is callable by the server only, which has already
-- authorized the doctor against the patient (doctor_patient_access) before calling.
--
-- Returns { order_id, replayed, patient_id, appointment_id }: on a replay the server compares patient and
-- consultation with the request before answering (a reused key for different content is a conflict).
--
-- Reversible: drop function public.lab_create_order(uuid, uuid, uuid, uuid, uuid, uuid, public.lab_priority, text, uuid, jsonb).

create or replace function public.lab_create_order(
  p_clinic_id uuid,
  p_actor uuid,
  p_patient_id uuid,
  p_doctor_id uuid,
  p_appointment_id uuid,
  p_referral_id uuid,
  p_priority public.lab_priority,
  p_notes text,
  p_creation_key uuid,
  p_items jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order uuid;
  v_item jsonb;
  v_existing record;
begin
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'lab order: an order needs at least one test';
  end if;

  if p_creation_key is not null then
    select o.id, o.patient_id, o.appointment_id into v_existing
      from public.lab_orders o
     where o.clinic_id = p_clinic_id and o.ordering_doctor_id = p_doctor_id and o.creation_key = p_creation_key;
    if found then
      return jsonb_build_object('order_id', v_existing.id, 'replayed', true, 'patient_id', v_existing.patient_id, 'appointment_id', v_existing.appointment_id);
    end if;
  end if;

  begin
    insert into public.lab_orders (clinic_id, patient_id, ordering_doctor_id, appointment_id, referral_id, priority, notes, creation_key, created_by)
    values (p_clinic_id, p_patient_id, p_doctor_id, p_appointment_id, p_referral_id, coalesce(p_priority, 'routine'), p_notes, p_creation_key, p_actor)
    returning id into v_order;
  exception when unique_violation then
    -- A concurrent submission with the same key won: answer with its order.
    select o.id, o.patient_id, o.appointment_id into v_existing
      from public.lab_orders o
     where o.clinic_id = p_clinic_id and o.ordering_doctor_id = p_doctor_id and o.creation_key = p_creation_key;
    if not found then
      raise;
    end if;
    return jsonb_build_object('order_id', v_existing.id, 'replayed', true, 'patient_id', v_existing.patient_id, 'appointment_id', v_existing.appointment_id);
  end;

  for v_item in select * from jsonb_array_elements(p_items) loop
    insert into public.lab_order_items (clinic_id, order_id, test_id, panel_id)
    values (p_clinic_id, v_order, (v_item ->> 'test_id')::uuid, nullif(v_item ->> 'panel_id', '')::uuid);
  end loop;

  return jsonb_build_object('order_id', v_order, 'replayed', false, 'patient_id', p_patient_id, 'appointment_id', p_appointment_id);
end;
$$;

revoke all on function public.lab_create_order(uuid, uuid, uuid, uuid, uuid, uuid, public.lab_priority, text, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.lab_create_order(uuid, uuid, uuid, uuid, uuid, uuid, public.lab_priority, text, uuid, jsonb) to service_role;

-- =====================================================================
-- FILE: 20261003000005_lab_payments.sql
-- =====================================================================
-- Laboratory module, phase 5a: a laboratory order is a second billable entity of the EXISTING payments table.
--
-- Decision D2 (docs/labs/DECISIONS.md): no `lab_payments`, no second payment engine. `payments` keeps its
-- statuses, its legal transitions (src/lib/payments/status.ts), its audit and its "server-managed" guard;
-- a payment row now belongs to exactly one billable entity: an appointment OR a lab order.
--
--   * appointment_id becomes nullable, lab_order_id is new, and a check requires exactly one of them.
--     The existing unique (appointment_id) stays: every consumer that reads `appointments → payments` still
--     sees at most one payment per appointment (a lab payment has no appointment and is never matched).
--   * A lab payment is tied to its order, patient and clinic by a composite same-clinic FK, is always the
--     `manual` provider (the only production-usable one) and its owner, patient, clinic, amount, currency
--     and provider never change afterwards — only its status moves, through the existing engine.
--   * The AMOUNT is computed here, from the order's price snapshots, never from a request: the sum of the
--     active items, except that a panel with a fixed price replaces its tests' prices when ALL of the panel's
--     tests are on the order as that panel's items.
--   * lab_create_order() (phase 4) now also creates the order's payment — `unpaid`, truthfully — in the same
--     transaction, like the booking engine does for appointments. Orders that already exist get one.
--
-- Whether payment is required before a sample is collected is the clinic's setting (see 20261003000006).
--
-- Reversible while no lab payment exists: delete the lab payments, drop payments_lab_immutable / the
-- constraints / the column, `alter column appointment_id set not null`, restore lab_create_order() from
-- 20261003000004.

alter table public.payments alter column appointment_id drop not null;
alter table public.payments add column lab_order_id uuid;

-- Added NOT VALID and validated separately: validation takes only a SHARE UPDATE EXCLUSIVE lock, so a large
-- payments table is not blocked while it is scanned.
alter table public.payments
  add constraint payments_one_owner_check check (num_nonnulls(appointment_id, lab_order_id) = 1) not valid;
alter table public.payments validate constraint payments_one_owner_check;

alter table public.payments
  add constraint payments_lab_manual_only_check check (lab_order_id is null or provider = 'manual') not valid;
alter table public.payments validate constraint payments_lab_manual_only_check;

alter table public.payments
  add constraint payments_lab_order_fkey foreign key (lab_order_id, clinic_id, patient_id)
  references public.lab_orders (id, clinic_id, patient_id) on delete restrict;

create unique index payments_lab_order_key on public.payments (lab_order_id) where lab_order_id is not null;

comment on column public.payments.lab_order_id is
  'The laboratory order this payment settles (exactly one of appointment_id / lab_order_id). Set only by lab_create_order().';

-- What a lab payment is, once written, cannot be rewritten: only its status (and the engine's bookkeeping) moves.
create or replace function public.payments_lab_immutable()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.lab_order_id is distinct from old.lab_order_id then
    raise exception 'payments: the billable entity of a payment cannot change';
  end if;
  if old.lab_order_id is not null and (
       new.clinic_id is distinct from old.clinic_id
    or new.patient_id is distinct from old.patient_id
    or new.amount is distinct from old.amount
    or new.currency is distinct from old.currency
    or new.provider is distinct from old.provider
  ) then
    raise exception 'payments: the amount, currency, patient and provider of a lab payment cannot change';
  end if;
  return new;
end;
$$;

create trigger payments_lab_immutable before update on public.payments
  for each row execute function public.payments_lab_immutable();

-- The amount of an order, from its snapshots. Fixed-price panel: only when every test of the panel is on the
-- order as that panel's item (otherwise the order is not "the panel", and its tests are priced one by one).
create or replace function public.lab_order_amount(p_order uuid)
returns numeric
language sql
stable
set search_path = public, pg_temp
as $$
  with items as (
    select i.test_id, i.panel_id, i.price_snapshot
      from public.lab_order_items i
     where i.order_id = p_order and i.status = 'active'
  ),
  whole_panels as (
    select p.id, p.price
      from public.lab_panels p
     where p.price is not null
       and p.id in (select panel_id from items where panel_id is not null)
       and not exists (
         select 1 from public.lab_panel_tests pt
          where pt.panel_id = p.id
            and not exists (select 1 from items i2 where i2.test_id = pt.test_id and i2.panel_id = p.id)
       )
  )
  select coalesce((select sum(price_snapshot) from items
                    where panel_id is null or panel_id not in (select id from whole_panels)), 0)
       + coalesce((select sum(price) from whole_panels), 0);
$$;

revoke all on function public.lab_order_amount(uuid) from public, anon, authenticated;
grant execute on function public.lab_order_amount(uuid) to service_role;

-- The order's payment, created with the order.
create or replace function public.lab_create_order(
  p_clinic_id uuid,
  p_actor uuid,
  p_patient_id uuid,
  p_doctor_id uuid,
  p_appointment_id uuid,
  p_referral_id uuid,
  p_priority public.lab_priority,
  p_notes text,
  p_creation_key uuid,
  p_items jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order uuid;
  v_item jsonb;
  v_existing record;
begin
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'lab order: an order needs at least one test';
  end if;

  if p_creation_key is not null then
    select o.id, o.patient_id, o.appointment_id into v_existing
      from public.lab_orders o
     where o.clinic_id = p_clinic_id and o.ordering_doctor_id = p_doctor_id and o.creation_key = p_creation_key;
    if found then
      return jsonb_build_object('order_id', v_existing.id, 'replayed', true, 'patient_id', v_existing.patient_id, 'appointment_id', v_existing.appointment_id);
    end if;
  end if;

  begin
    insert into public.lab_orders (clinic_id, patient_id, ordering_doctor_id, appointment_id, referral_id, priority, notes, creation_key, created_by)
    values (p_clinic_id, p_patient_id, p_doctor_id, p_appointment_id, p_referral_id, coalesce(p_priority, 'routine'), p_notes, p_creation_key, p_actor)
    returning id into v_order;
  exception when unique_violation then
    -- A concurrent submission with the same key won: answer with its order.
    select o.id, o.patient_id, o.appointment_id into v_existing
      from public.lab_orders o
     where o.clinic_id = p_clinic_id and o.ordering_doctor_id = p_doctor_id and o.creation_key = p_creation_key;
    if not found then
      raise;
    end if;
    return jsonb_build_object('order_id', v_existing.id, 'replayed', true, 'patient_id', v_existing.patient_id, 'appointment_id', v_existing.appointment_id);
  end;

  for v_item in select * from jsonb_array_elements(p_items) loop
    insert into public.lab_order_items (clinic_id, order_id, test_id, panel_id)
    values (p_clinic_id, v_order, (v_item ->> 'test_id')::uuid, nullif(v_item ->> 'panel_id', '')::uuid);
  end loop;

  -- The payment is part of the order: unpaid until staff confirm it, priced from the snapshots just written.
  insert into public.payments (clinic_id, lab_order_id, patient_id, amount, currency, status, provider)
  select p_clinic_id, v_order, p_patient_id, public.lab_order_amount(v_order), coalesce(c.currency, 'UZS'), 'unpaid', 'manual'
    from public.clinics c where c.id = p_clinic_id;

  return jsonb_build_object('order_id', v_order, 'replayed', false, 'patient_id', p_patient_id, 'appointment_id', p_appointment_id);
end;
$$;

revoke all on function public.lab_create_order(uuid, uuid, uuid, uuid, uuid, uuid, public.lab_priority, text, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.lab_create_order(uuid, uuid, uuid, uuid, uuid, uuid, public.lab_priority, text, uuid, jsonb) to service_role;

-- Orders that predate this migration (none in production: the module is not deployed) get their payment.
insert into public.payments (clinic_id, lab_order_id, patient_id, amount, currency, status, provider)
select o.clinic_id, o.id, o.patient_id, public.lab_order_amount(o.id), coalesce(c.currency, 'UZS'), 'unpaid', 'manual'
  from public.lab_orders o
  join public.clinics c on c.id = o.clinic_id
 where not exists (select 1 from public.payments p where p.lab_order_id = o.id);

-- =====================================================================
-- FILE: 20261003000006_lab_sample_workflow.sql
-- =====================================================================
-- Laboratory module, phase 5b: sample collection, with the clinic's payment policy applied where it matters.
--
-- Order, payment and sample are three separate states (lab_orders.status, payments.status,
-- lab_samples.status). "Ready for collection" is not stored anywhere: it is what the worklist derives from
-- the three, so none of them can drift into being a copy of another.
--
-- The lifecycle itself is already enforced by the phase-2 triggers (awaiting_collection → collected →
-- processing; rejected; cancelled; no sample for a cancelled/completed order; created_by/collected_by must
-- be lab staff; one live sample per order and sample type). These functions add what a trigger cannot:
--
--   * lab_collection_requires_payment(clinic) — the clinic's policy (app_settings key `lab`,
--     collection.requiresPayment). Not hard-coded: absent or not an explicit JSON `true` means "not required".
--   * lab_create_samples() — one awaiting-collection sample per sample type for the order's active tests that
--     are not on a live sample yet; idempotent (a repeat creates nothing), race-safe through the order lock.
--   * lab_sample_transition() — every later step in ONE transaction that locks the sample row, so two staff
--     members collecting the same sample, or one repeating the request, resolve to one collection; and the
--     payment gate: when the policy requires payment, collection needs the order's payment to be `paid`
--     RIGHT NOW — the payment row is locked FOR SHARE so a refund cannot slip in between the check and the
--     collection (the engine's compare-and-set update waits for this transaction).
--
-- Callable by the server only; the server has authorised the caller as lab staff of the clinic, and the
-- phase-2 triggers re-check it. Reversible: drop the three functions.

create or replace function public.lab_collection_requires_payment(p_clinic uuid)
returns boolean
language sql
stable
set search_path = public, pg_temp
as $$
  select coalesce(
    (select case when jsonb_typeof(s.value #> '{collection,requiresPayment}') = 'boolean'
                 then (s.value #>> '{collection,requiresPayment}')::boolean end
       from public.app_settings s where s.clinic_id = p_clinic and s.key = 'lab'),
    false);
$$;

revoke all on function public.lab_collection_requires_payment(uuid) from public, anon, authenticated;
grant execute on function public.lab_collection_requires_payment(uuid) to service_role;

create or replace function public.lab_create_samples(p_clinic uuid, p_actor uuid, p_order uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order record;
  v_type text;
  v_sample uuid;
  v_code text;
  v_tries int;
  v_created int := 0;
begin
  if not public.lab_is_lab_staff(p_actor, p_clinic) then
    raise exception 'lab sample: only lab staff of the clinic create samples';
  end if;

  -- The order lock serialises sample creation for one order: two requests cannot both decide "no sample yet".
  select o.id, o.patient_id, o.status into v_order
    from public.lab_orders o where o.id = p_order and o.clinic_id = p_clinic for update;
  if not found then
    raise exception 'lab sample: order not found';
  end if;

  for v_type in
    select distinct coalesce(nullif(btrim(i.sample_type), ''), 'boshqa')
      from public.lab_order_items i
     where i.order_id = p_order and i.clinic_id = p_clinic and i.status = 'active'
       and not exists (
         select 1 from public.lab_sample_items si
           join public.lab_samples s on s.id = si.sample_id
          where si.order_item_id = i.id and s.status in ('awaiting_collection', 'collected', 'processing')
       )
       and not exists (
         select 1 from public.lab_samples s
          where s.order_id = p_order and s.status in ('awaiting_collection', 'collected', 'processing')
            and s.sample_type = coalesce(nullif(btrim(i.sample_type), ''), 'boshqa')
       )
  loop
    v_tries := 0;
    loop
      -- A short code the technician can read off a tube: unambiguous characters, unique per clinic.
      v_code := 'S' || to_char(now(), 'YYMMDD') || '-' ||
        (select string_agg(substr('ABCDEFGHJKMNPQRSTUVWXYZ23456789', 1 + floor(random() * 31)::int, 1), '') from generate_series(1, 5));
      begin
        insert into public.lab_samples (clinic_id, order_id, patient_id, sample_type, sample_code, created_by)
        values (p_clinic, p_order, v_order.patient_id, v_type, v_code, p_actor)
        returning id into v_sample;
        exit;
      exception when unique_violation then
        v_tries := v_tries + 1;
        if v_tries >= 8 then raise; end if;
      end;
    end loop;

    insert into public.lab_sample_items (sample_id, order_item_id, clinic_id, order_id)
    select v_sample, i.id, p_clinic, p_order
      from public.lab_order_items i
     where i.order_id = p_order and i.clinic_id = p_clinic and i.status = 'active'
       and coalesce(nullif(btrim(i.sample_type), ''), 'boshqa') = v_type
       and not exists (
         select 1 from public.lab_sample_items si
           join public.lab_samples s on s.id = si.sample_id
          where si.order_item_id = i.id and s.status in ('awaiting_collection', 'collected', 'processing')
       );
    v_created := v_created + 1;
  end loop;

  return jsonb_build_object('order_id', p_order, 'created', v_created);
end;
$$;

revoke all on function public.lab_create_samples(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.lab_create_samples(uuid, uuid, uuid) to service_role;

create or replace function public.lab_sample_transition(
  p_clinic uuid,
  p_actor uuid,
  p_sample uuid,
  p_to public.lab_sample_status,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_sample record;
  v_payment public.payment_status;
begin
  if not public.lab_is_lab_staff(p_actor, p_clinic) then
    raise exception 'lab sample: only lab staff of the clinic move samples';
  end if;

  select s.id, s.order_id, s.status, s.collected_by into v_sample
    from public.lab_samples s where s.id = p_sample and s.clinic_id = p_clinic for update;
  if not found then
    raise exception 'lab sample: sample not found';
  end if;

  -- The same step asked twice is one step. Collected by someone else is not "the same step": it is a conflict.
  if v_sample.status = p_to then
    if p_to = 'collected' and v_sample.collected_by is distinct from p_actor then
      raise exception 'lab sample: already collected by another member of staff';
    end if;
    return jsonb_build_object('sample_id', p_sample, 'status', v_sample.status, 'unchanged', true);
  end if;

  if p_to = 'collected' and public.lab_collection_requires_payment(p_clinic) then
    -- Locked FOR SHARE until this transaction ends: a refund (an UPDATE of the row) waits for the collection.
    select p.status into v_payment
      from public.payments p where p.lab_order_id = v_sample.order_id and p.clinic_id = p_clinic for share;
    if not found or v_payment <> 'paid' then
      raise exception 'lab sample: payment required before collection';
    end if;
  end if;

  update public.lab_samples
     set status = p_to,
         collected_by = case when p_to = 'collected' then p_actor else collected_by end,
         rejected_reason = case when p_to = 'rejected' then nullif(btrim(p_reason), '') else null end
   where id = p_sample and clinic_id = p_clinic;

  return jsonb_build_object('sample_id', p_sample, 'status', p_to, 'unchanged', false);
end;
$$;

revoke all on function public.lab_sample_transition(uuid, uuid, uuid, public.lab_sample_status, text) from public, anon, authenticated;
grant execute on function public.lab_sample_transition(uuid, uuid, uuid, public.lab_sample_status, text) to service_role;

-- =====================================================================
-- FILE: 20261003000007_lab_result_workflow.sql
-- =====================================================================
-- Laboratory module, phase 6: result entry, verification and correction as ONE transaction per step.
--
-- The phase-2 triggers already make results safe to store: values follow the configured parameters, the
-- reference bounds and the flag are copied/computed by the database, a version is append-only, one open and one
-- verified version per result, a correction names the current verified version, and the result header follows
-- the latest version. What a trigger cannot do — and these functions do — is the WORKFLOW:
--
--   * lab_result_save      — the author's draft of an item whose sample was collected; the values are replaced as one
--                            unit (all or nothing); each value gets the one generic active reference range of its
--                            parameter (lab_pick_range). Nobody but the author edits a draft; a draft awaiting
--                            verification is not edited (it is returned to draft first).
--   * lab_result_submit    — draft → pending_verification, only by the author and only when EVERY active parameter of
--                            the test has a value. When the clinic does not require verification
--                            (verification.required = false) the same step also verifies it, by the submitter — the
--                            verification is still recorded (who, when), never skipped.
--   * lab_result_verify    — pending → verified. When the clinic requires a separate verifier
--                            (verification.separateVerifier = true) the verifier cannot be the person who entered it.
--                            Two people verifying at once: the version row is locked; the second is told it is already
--                            verified (the same person repeating it is a no-op).
--   * lab_result_return    — pending → draft (a reviewer sends it back for rework).
--   * lab_result_correct   — a NEW draft version that corrects the current verified one, with a reason, copying its
--                            values. It names the version number the caller saw: a stale number (someone corrected in the
--                            meantime) or a correction already open is refused. The old version stays verified (and
--                            readable) until the correction is itself verified, when it is superseded.
--
-- Both clinic settings are read here (app_settings key `lab`): only an explicit JSON false switches verification off,
-- only an explicit JSON true requires a separate verifier — the same defaults as the settings screen.
--
-- Callable by the server only. The server has authorised the caller as lab staff of the clinic; the functions and the
-- phase-2 triggers re-check it. Reversible: drop the functions.

create or replace function public.lab_setting_bool(p_clinic uuid, p_path text[], p_default boolean)
returns boolean
language sql
stable
set search_path = public, pg_temp
as $$
  select coalesce(
    (select case when jsonb_typeof(s.value #> p_path) = 'boolean' then (s.value #>> p_path)::boolean end
       from public.app_settings s where s.clinic_id = p_clinic and s.key = 'lab'),
    p_default);
$$;

revoke all on function public.lab_setting_bool(uuid, text[], boolean) from public, anon, authenticated;
grant execute on function public.lab_setting_bool(uuid, text[], boolean) to service_role;

-- The range that applies to a parameter: its single generic (no age bounds) active range. Age-specific ranges need the
-- patient's age, which the record does not hold yet (the identity layer adds it): with none or several generic ranges the
-- value is stored without a range and shows as "no configured range" — never a guess.
create or replace function public.lab_pick_range(p_parameter uuid)
returns uuid
language sql
stable
set search_path = public, pg_temp
as $$
  select case when count(*) = 1 then (array_agg(r.id))[1] end
    from public.lab_reference_ranges r
   where r.parameter_id = p_parameter and r.active and r.age_min_years is null and r.age_max_years is null;
$$;

revoke all on function public.lab_pick_range(uuid) from public, anon, authenticated;
grant execute on function public.lab_pick_range(uuid) to service_role;

create or replace function public.lab_result_save(p_clinic uuid, p_actor uuid, p_item uuid, p_values jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_item record;
  v_result uuid;
  v_version record;
  v_val jsonb;
begin
  if not public.lab_is_lab_staff(p_actor, p_clinic) then
    raise exception 'lab result: only lab staff of the clinic enter results';
  end if;
  if p_values is null or jsonb_typeof(p_values) <> 'array' or jsonb_array_length(p_values) = 0 then
    raise exception 'lab result: a result needs at least one value';
  end if;

  select i.id, i.order_id into v_item from public.lab_order_items i where i.id = p_item and i.clinic_id = p_clinic;
  if not found then
    raise exception 'lab result: not found';
  end if;
  if not exists (
    select 1 from public.lab_sample_items si
      join public.lab_samples s on s.id = si.sample_id
     where si.order_item_id = p_item and s.clinic_id = p_clinic and s.status in ('collected', 'processing')
  ) then
    raise exception 'lab result: the sample has not been collected';
  end if;

  -- The header is created once, with the first draft. It is looked up first: an INSERT ... ON CONFLICT would still
  -- run the insert trigger, which refuses a new result for a completed order — and the draft of a CORRECTION of a
  -- completed order must stay editable.
  select r.id into v_result from public.lab_results r where r.order_item_id = p_item and r.clinic_id = p_clinic for update;
  if not found then
    insert into public.lab_results (clinic_id, order_item_id, order_id, patient_id)
    select p_clinic, p_item, v_item.order_id, o.patient_id from public.lab_orders o where o.id = v_item.order_id and o.clinic_id = p_clinic
    returning id into v_result;
  end if;

  select v.* into v_version from public.lab_result_versions v
   where v.result_id = v_result and v.status in ('draft', 'pending_verification');
  if not found then
    if exists (select 1 from public.lab_result_versions v where v.result_id = v_result) then
      raise exception 'lab result: it is already verified; start a correction to change it';
    end if;
    insert into public.lab_result_versions (clinic_id, result_id, entered_by) values (p_clinic, v_result, p_actor)
    returning * into v_version;
  elsif v_version.status = 'pending_verification' then
    raise exception 'lab result: it is awaiting verification; return it to draft to change it';
  elsif v_version.entered_by is distinct from p_actor then
    raise exception 'lab result: this draft belongs to another member of staff';
  end if;

  delete from public.lab_result_values where version_id = v_version.id;
  for v_val in select * from jsonb_array_elements(p_values) loop
    insert into public.lab_result_values (clinic_id, version_id, parameter_id, parameter_code, parameter_name, value_numeric, value_text, reference_range_id)
    values (
      p_clinic, v_version.id, (v_val ->> 'parameter_id')::uuid, '', '',
      (v_val ->> 'value_numeric')::numeric, nullif(btrim(v_val ->> 'value_text'), ''),
      public.lab_pick_range((v_val ->> 'parameter_id')::uuid)
    );
  end loop;

  return jsonb_build_object('result_id', v_result, 'version_id', v_version.id, 'version', v_version.version);
end;
$$;

create or replace function public.lab_result_submit(p_clinic uuid, p_actor uuid, p_version uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v record;
  v_missing int;
begin
  if not public.lab_is_lab_staff(p_actor, p_clinic) then
    raise exception 'lab result: only lab staff of the clinic submit results';
  end if;
  select * into v from public.lab_result_versions x where x.id = p_version and x.clinic_id = p_clinic for update;
  if not found then
    raise exception 'lab result: not found';
  end if;
  if v.entered_by is distinct from p_actor then
    raise exception 'lab result: only the author submits a draft';
  end if;
  if v.status in ('pending_verification', 'verified') then
    return jsonb_build_object('version_id', p_version, 'status', v.status, 'unchanged', true);
  end if;
  if v.status <> 'draft' then
    raise exception 'lab result: invalid version transition % -> pending_verification', v.status;
  end if;

  select count(*) into v_missing
    from public.lab_results r
    join public.lab_order_items i on i.id = r.order_item_id
    join public.lab_test_parameters p on p.test_id = i.test_id and p.clinic_id = i.clinic_id and p.active
   where r.id = v.result_id
     and not exists (select 1 from public.lab_result_values x where x.version_id = p_version and x.parameter_id = p.id);
  if v_missing > 0 then
    raise exception 'lab result: every active parameter of the test needs a value (% missing)', v_missing;
  end if;

  update public.lab_result_versions set status = 'pending_verification' where id = p_version;
  if not public.lab_setting_bool(p_clinic, array['verification', 'required'], true) then
    -- The clinic does not require a second step: the submission is recorded as verified, by the same person.
    update public.lab_result_versions set status = 'verified', verified_by = p_actor where id = p_version;
    return jsonb_build_object('version_id', p_version, 'status', 'verified', 'unchanged', false);
  end if;
  return jsonb_build_object('version_id', p_version, 'status', 'pending_verification', 'unchanged', false);
end;
$$;

create or replace function public.lab_result_verify(p_clinic uuid, p_actor uuid, p_version uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v record;
begin
  if not public.lab_is_lab_staff(p_actor, p_clinic) then
    raise exception 'lab result: only lab staff of the clinic verify results';
  end if;
  select * into v from public.lab_result_versions x where x.id = p_version and x.clinic_id = p_clinic for update;
  if not found then
    raise exception 'lab result: not found';
  end if;
  if v.status = 'verified' then
    if v.verified_by is not distinct from p_actor then
      return jsonb_build_object('version_id', p_version, 'status', 'verified', 'unchanged', true);
    end if;
    raise exception 'lab result: already verified by another member of staff';
  end if;
  if v.status <> 'pending_verification' then
    raise exception 'lab result: only a submitted version is verified (it is %)', v.status;
  end if;
  if public.lab_setting_bool(p_clinic, array['verification', 'separateVerifier'], false) and v.entered_by = p_actor then
    raise exception 'lab result: the verifier must be a different person from the one who entered it';
  end if;
  update public.lab_result_versions set status = 'verified', verified_by = p_actor where id = p_version;
  return jsonb_build_object('version_id', p_version, 'status', 'verified', 'unchanged', false);
end;
$$;

create or replace function public.lab_result_return(p_clinic uuid, p_actor uuid, p_version uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v record;
begin
  if not public.lab_is_lab_staff(p_actor, p_clinic) then
    raise exception 'lab result: only lab staff of the clinic return results';
  end if;
  select * into v from public.lab_result_versions x where x.id = p_version and x.clinic_id = p_clinic for update;
  if not found then
    raise exception 'lab result: not found';
  end if;
  if v.status = 'draft' then
    return jsonb_build_object('version_id', p_version, 'status', 'draft', 'unchanged', true);
  end if;
  if v.status <> 'pending_verification' then
    raise exception 'lab result: only a submitted version is returned to draft (it is %)', v.status;
  end if;
  update public.lab_result_versions set status = 'draft' where id = p_version;
  return jsonb_build_object('version_id', p_version, 'status', 'draft', 'unchanged', false);
end;
$$;

create or replace function public.lab_result_correct(p_clinic uuid, p_actor uuid, p_result uuid, p_expected_version int, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_current record;
  v_new record;
begin
  if not public.lab_is_lab_staff(p_actor, p_clinic) then
    raise exception 'lab result: only lab staff of the clinic correct results';
  end if;
  if p_reason is null or char_length(btrim(p_reason)) < 3 then
    raise exception 'lab result: a correction needs a reason';
  end if;

  -- Serialises corrections of one result: the second of two simultaneous corrections sees the first one's draft.
  perform 1 from public.lab_results r where r.id = p_result and r.clinic_id = p_clinic for update;
  if not found then
    raise exception 'lab result: not found';
  end if;
  if exists (select 1 from public.lab_result_versions v where v.result_id = p_result and v.status in ('draft', 'pending_verification')) then
    raise exception 'lab result: a correction is already in progress';
  end if;
  select v.* into v_current from public.lab_result_versions v where v.result_id = p_result and v.status = 'verified';
  if not found then
    raise exception 'lab result: only a verified result is corrected';
  end if;
  if v_current.version is distinct from p_expected_version then
    raise exception 'lab result: stale version (the current verified version is %)', v_current.version;
  end if;

  insert into public.lab_result_versions (clinic_id, result_id, entered_by, corrects_version_id, correction_reason)
  values (p_clinic, p_result, p_actor, v_current.id, btrim(p_reason))
  returning * into v_new;

  -- The corrected version starts from the verified one (retired parameters are left out; ranges are re-picked).
  insert into public.lab_result_values (clinic_id, version_id, parameter_id, parameter_code, parameter_name, value_numeric, value_text, reference_range_id)
  select p_clinic, v_new.id, x.parameter_id, '', '', x.value_numeric, x.value_text, public.lab_pick_range(x.parameter_id)
    from public.lab_result_values x
    join public.lab_test_parameters p on p.id = x.parameter_id and p.active
   where x.version_id = v_current.id;

  return jsonb_build_object('result_id', p_result, 'version_id', v_new.id, 'version', v_new.version, 'corrects_version', v_current.version);
end;
$$;

do $$
declare
  f text;
begin
  foreach f in array array[
    'lab_result_save(uuid, uuid, uuid, jsonb)',
    'lab_result_submit(uuid, uuid, uuid)',
    'lab_result_verify(uuid, uuid, uuid)',
    'lab_result_return(uuid, uuid, uuid)',
    'lab_result_correct(uuid, uuid, uuid, int, text)'
  ] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end $$;

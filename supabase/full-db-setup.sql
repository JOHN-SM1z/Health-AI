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

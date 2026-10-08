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
-- FILE: 20261005000001_patient_lab_identity.sql
-- =====================================================================
-- Laboratory (Phase 2, 1 of 4): patient identity for lab work.
--
-- docs/labs/PHASE_1_DOMAIN_MODEL.md §2.1, owner decisions 2026-10-05:
--   * date_of_birth and sex select configured reference ranges. sex is a
--     clinical attribute and may stay NULL (unknown) — staff are never forced
--     to guess. Lab orders require a date of birth (enforced when an order is
--     created, 20261005000003); existing patients simply have none yet.
--   * document_number (passport / ID card) and pinfl are unique WITHIN A
--     CLINIC (O1) — the same passport in two clinics is two valid patients.
--     Values are normalised before they are stored or compared: trimmed,
--     spaces and dashes removed, upper-cased.
--
-- O1 rollout order: add the columns, normalise any existing values, list
-- duplicates per clinic (the migration refuses to continue and names them
-- rather than guessing which record wins), then create the unique indexes.
-- The columns are new, so the duplicate check is expected to find nothing;
-- it stays as the guard the decision asked for.
--
-- Nothing here is readable by more roles than before: patients keeps its
-- existing policies and grants (signed-in roles cannot write it).

create type public.patient_sex as enum ('female', 'male');

comment on type public.patient_sex is
  'Clinical sex used only to select configured lab reference ranges. NULL on patients.sex means unknown / not recorded.';

alter table public.patients
  add column date_of_birth date,
  add column sex public.patient_sex,
  add column document_number text,
  add column pinfl text;

alter table public.patients
  add constraint patients_date_of_birth_check
    check (date_of_birth is null or (date_of_birth >= date '1900-01-01' and date_of_birth <= current_date)),
  add constraint patients_document_number_check
    check (document_number is null or document_number ~ '^[A-Z0-9]{5,20}$'),
  add constraint patients_pinfl_check
    check (pinfl is null or pinfl ~ '^[0-9]{14}$');

comment on column public.patients.date_of_birth is 'Required before a lab order is created; selects age-dependent reference ranges.';
comment on column public.patients.sex is 'NULL = unknown. Never defaulted or guessed.';
comment on column public.patients.document_number is 'Passport / ID card number, normalised (no spaces or dashes, upper-case). Unique per clinic.';
comment on column public.patients.pinfl is 'Personal identification number (14 digits), normalised. Unique per clinic.';

-- ---------- Normalisation ----------

create or replace function public.normalize_identity_document(p_value text)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select nullif(upper(regexp_replace(btrim(p_value), '[[:space:]-]+', '', 'g')), '');
$$;

comment on function public.normalize_identity_document(text) is
  'Canonical form of a passport / ID / PINFL value: trimmed, spaces and dashes removed, upper-case; empty becomes NULL.';

create or replace function public.patients_normalize_identity()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  new.document_number := public.normalize_identity_document(new.document_number);
  new.pinfl := public.normalize_identity_document(new.pinfl);
  return new;
end;
$$;

create trigger patients_normalize_identity
  before insert or update of document_number, pinfl on public.patients
  for each row execute function public.patients_normalize_identity();

revoke all on function public.patients_normalize_identity() from public, anon, authenticated;

-- ---------- O1: normalise, refuse on duplicates, then enforce ----------

update public.patients
set document_number = public.normalize_identity_document(document_number),
    pinfl = public.normalize_identity_document(pinfl)
where document_number is not null or pinfl is not null;

do $$
declare
  v_report text;
begin
  select string_agg(format('%s %s in clinic %s: patients %s', kind, value, clinic_id, ids), '; ')
    into v_report
  from (
    select 'document_number' as kind, document_number as value, clinic_id, string_agg(id::text, ', ') as ids
    from public.patients
    where document_number is not null
    group by clinic_id, document_number
    having count(*) > 1
    union all
    select 'pinfl', pinfl, clinic_id, string_agg(id::text, ', ')
    from public.patients
    where pinfl is not null
    group by clinic_id, pinfl
    having count(*) > 1
  ) duplicates;
  if v_report is not null then
    raise exception 'patients: duplicate identity documents must be resolved before uniqueness is enforced — %', v_report;
  end if;
end;
$$;

create unique index patients_clinic_document_number_key
  on public.patients (clinic_id, document_number)
  where document_number is not null;

create unique index patients_clinic_pinfl_key
  on public.patients (clinic_id, pinfl)
  where pinfl is not null;

-- =====================================================================
-- FILE: 20261005000002_lab_catalog.sql
-- =====================================================================
-- Laboratory (Phase 2, 2 of 4): the clinic-configured lab catalog.
--
-- docs/labs/PHASE_1_DOMAIN_MODEL.md §3.1. Configuration is data: each clinic
-- defines its own categories, tests, measured parameters, units, reference
-- ranges, panels and prices. Nothing here interprets a value clinically; a
-- reference range is a configured bound, and critical bounds are only
-- configured and displayed (critical-result alerts are deferred).
--
--   lab_test_categories  grouping of tests (not a department, not specialties —
--                        specialties feed the public catalog and AI navigation)
--   lab_tests            one orderable test, with its price
--   lab_test_parameters  the measured fields of a test (CBC → Hemoglobin, WBC …)
--   lab_reference_ranges configured bounds per parameter, optionally per sex
--                        and age band; overlapping active ranges are refused
--   lab_panels           a named set of tests ordered together, with its price
--   lab_panel_tests      panel membership
--
-- Every table is clinic-owned; every reference is a composite foreign key
-- (x_id, clinic_id) so a row can never point into another clinic. Rows that
-- history references cannot be deleted (no cascade from a test to its
-- parameters or ranges); clinics deactivate them instead.
--
-- Access: clinic staff may read the catalog (it holds no patient data);
-- nobody signed in may write it — configuration goes through the server
-- (Phase 4), like services and specialties.

create type public.lab_value_type as enum ('numeric', 'text', 'boolean', 'choice');

comment on type public.lab_value_type is
  'How a lab parameter is recorded: numeric (with unit), free text, yes/no, or one of configured choices.';

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table public.lab_test_categories (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete cascade,
  name text not null,
  sort_order integer not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint lab_test_categories_id_clinic_id_key unique (id, clinic_id),
  constraint lab_test_categories_clinic_name_key unique (clinic_id, name),
  constraint lab_test_categories_name_check check (name ~ '\S' and char_length(name) <= 120)
);

create table public.lab_tests (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete cascade,
  category_id uuid,
  code text not null,
  name text not null,
  sample_type text not null,
  preparation_text text,
  turnaround_hours integer,
  price numeric(12, 2) not null default 0,
  sort_order integer not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint lab_tests_id_clinic_id_key unique (id, clinic_id),
  constraint lab_tests_clinic_code_key unique (clinic_id, code),
  constraint lab_tests_clinic_name_key unique (clinic_id, name),
  constraint lab_tests_category_fkey
    foreign key (category_id, clinic_id) references public.lab_test_categories (id, clinic_id)
    on delete set null (category_id),
  constraint lab_tests_code_check check (code ~ '^[A-Za-z0-9._-]{1,32}$'),
  constraint lab_tests_name_check check (name ~ '\S' and char_length(name) <= 200),
  constraint lab_tests_sample_type_check check (sample_type ~ '\S' and char_length(sample_type) <= 80),
  constraint lab_tests_preparation_check check (preparation_text is null or char_length(preparation_text) <= 2000),
  constraint lab_tests_turnaround_check check (turnaround_hours is null or turnaround_hours between 1 and 8760),
  constraint lab_tests_price_check check (price >= 0)
);

create table public.lab_test_parameters (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete cascade,
  test_id uuid not null,
  code text not null,
  name text not null,
  value_type public.lab_value_type not null,
  unit text,
  decimals smallint,
  choices text[],
  sort_order integer not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint lab_test_parameters_id_clinic_id_key unique (id, clinic_id),
  constraint lab_test_parameters_test_code_key unique (test_id, code),
  constraint lab_test_parameters_test_fkey
    foreign key (test_id, clinic_id) references public.lab_tests (id, clinic_id),
  constraint lab_test_parameters_code_check check (code ~ '^[A-Za-z0-9._-]{1,32}$'),
  constraint lab_test_parameters_name_check check (name ~ '\S' and char_length(name) <= 200),
  constraint lab_test_parameters_unit_check
    check (unit is null or (value_type = 'numeric' and unit ~ '\S' and char_length(unit) <= 40)),
  constraint lab_test_parameters_decimals_check
    check (decimals is null or (value_type = 'numeric' and decimals between 0 and 6)),
  constraint lab_test_parameters_choices_check
    check ((value_type = 'choice') = (choices is not null)
           and (choices is null or (cardinality(choices) between 2 and 50 and array_position(choices, null) is null)))
);

create table public.lab_reference_ranges (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete cascade,
  parameter_id uuid not null,
  -- NULL = applies to any sex.
  sex public.patient_sex,
  -- Age band in days, inclusive; NULL bound = open.
  age_min_days integer,
  age_max_days integer,
  low numeric,
  high numeric,
  critical_low numeric,
  critical_high numeric,
  -- Expected value for text / boolean / choice parameters.
  normal_text text,
  -- Free label for the laboratory, method or equipment the range belongs to.
  method_label text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint lab_reference_ranges_id_clinic_id_key unique (id, clinic_id),
  constraint lab_reference_ranges_parameter_fkey
    foreign key (parameter_id, clinic_id) references public.lab_test_parameters (id, clinic_id),
  constraint lab_reference_ranges_age_check
    check ((age_min_days is null or age_min_days >= 0)
           and (age_max_days is null or age_max_days >= 0)
           and (age_min_days is null or age_max_days is null or age_min_days <= age_max_days)),
  constraint lab_reference_ranges_bounds_check
    check ((low is null or high is null or low <= high)
           and (critical_low is null or low is null or critical_low <= low)
           and (critical_high is null or high is null or critical_high >= high)
           and (critical_low is null or critical_high is null or critical_low < critical_high)),
  constraint lab_reference_ranges_something_check
    check (num_nonnulls(low, high, normal_text) > 0),
  constraint lab_reference_ranges_normal_text_check
    check (normal_text is null or (normal_text ~ '\S' and char_length(normal_text) <= 200)),
  constraint lab_reference_ranges_method_check
    check (method_label is null or (method_label ~ '\S' and char_length(method_label) <= 120))
);

create table public.lab_panels (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete cascade,
  code text not null,
  name text not null,
  price numeric(12, 2) not null default 0,
  sort_order integer not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint lab_panels_id_clinic_id_key unique (id, clinic_id),
  constraint lab_panels_clinic_code_key unique (clinic_id, code),
  constraint lab_panels_clinic_name_key unique (clinic_id, name),
  constraint lab_panels_code_check check (code ~ '^[A-Za-z0-9._-]{1,32}$'),
  constraint lab_panels_name_check check (name ~ '\S' and char_length(name) <= 200),
  constraint lab_panels_price_check check (price >= 0)
);

create table public.lab_panel_tests (
  panel_id uuid not null,
  test_id uuid not null,
  clinic_id uuid not null references public.clinics(id) on delete cascade,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  primary key (panel_id, test_id),
  constraint lab_panel_tests_panel_fkey
    foreign key (panel_id, clinic_id) references public.lab_panels (id, clinic_id) on delete cascade,
  constraint lab_panel_tests_test_fkey
    foreign key (test_id, clinic_id) references public.lab_tests (id, clinic_id)
);

comment on table public.lab_test_categories is 'Clinic-defined grouping of lab tests (configuration; not a department, not specialties).';
comment on table public.lab_tests is 'Clinic-configured orderable lab test. Deactivate instead of deleting once ordered.';
comment on table public.lab_test_parameters is 'A measured field of a lab test with its value type and unit.';
comment on table public.lab_reference_ranges is 'Configured reference (and optional critical) bounds per parameter, optionally per sex and age band. Configuration only — no clinical interpretation.';
comment on table public.lab_panels is 'A named set of lab tests ordered together at the panel price.';
comment on table public.lab_panel_tests is 'Membership of lab tests in a panel.';

create index lab_tests_clinic_active_idx on public.lab_tests (clinic_id, active, sort_order);
create index lab_tests_category_idx on public.lab_tests (category_id) where category_id is not null;
create index lab_test_parameters_test_idx on public.lab_test_parameters (test_id, sort_order);
create index lab_reference_ranges_parameter_idx on public.lab_reference_ranges (parameter_id) where active;
create index lab_panel_tests_test_idx on public.lab_panel_tests (test_id);

-- ---------------------------------------------------------------------------
-- Validation
-- ---------------------------------------------------------------------------

-- Server-stamped timestamps, as everywhere else.
create or replace function public.lab_touch_timestamps()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'INSERT' then
    new.created_at := now();
  else
    new.created_at := old.created_at;
  end if;
  new.updated_at := now();
  return new;
end;
$$;

revoke all on function public.lab_touch_timestamps() from public, anon, authenticated;

create trigger lab_test_categories_touch before insert or update on public.lab_test_categories
  for each row execute function public.lab_touch_timestamps();
create trigger lab_tests_touch before insert or update on public.lab_tests
  for each row execute function public.lab_touch_timestamps();
create trigger lab_test_parameters_touch before insert or update on public.lab_test_parameters
  for each row execute function public.lab_touch_timestamps();
create trigger lab_reference_ranges_touch before insert or update on public.lab_reference_ranges
  for each row execute function public.lab_touch_timestamps();
create trigger lab_panels_touch before insert or update on public.lab_panels
  for each row execute function public.lab_touch_timestamps();

-- A parameter's identity (test, code, value type) is fixed once created:
-- stored results are interpreted through it. Name, unit display, choices
-- (append-only would be a Phase 4 rule), order and active may change.
create or replace function public.lab_test_parameters_validate()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'UPDATE' and (
       new.test_id is distinct from old.test_id
       or new.code is distinct from old.code
       or new.value_type is distinct from old.value_type
       or new.clinic_id is distinct from old.clinic_id
     ) then
    raise exception 'lab parameter: test, code and value type cannot change; add a new parameter instead';
  end if;
  return new;
end;
$$;

revoke all on function public.lab_test_parameters_validate() from public, anon, authenticated;

create trigger lab_test_parameters_validate
  before update on public.lab_test_parameters
  for each row execute function public.lab_test_parameters_validate();

-- Ranges: numeric bounds only for numeric parameters, normal_text only for
-- the others; and no two ACTIVE ranges of a parameter may both apply to the
-- same patient (same sex value — NULL counts as its own value — and
-- overlapping age bands), so range selection is never ambiguous.
create or replace function public.lab_reference_ranges_validate()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_type public.lab_value_type;
  v_choices text[];
  v_clash uuid;
begin
  if tg_op = 'UPDATE' and (new.parameter_id is distinct from old.parameter_id or new.clinic_id is distinct from old.clinic_id) then
    raise exception 'lab reference range: the parameter cannot change; add a new range instead';
  end if;

  -- Serialise range changes per parameter so the overlap check cannot race.
  select p.value_type, p.choices into v_type, v_choices
  from public.lab_test_parameters p
  where p.id = new.parameter_id and p.clinic_id = new.clinic_id
  for update;

  if v_type = 'boolean' and new.normal_text is not null and new.normal_text not in ('true', 'false') then
    raise exception 'lab reference range: the expected value of a yes/no parameter is true or false';
  end if;
  if v_type = 'choice' and new.normal_text is not null and not (new.normal_text = any (v_choices)) then
    raise exception 'lab reference range: the expected value must be one of the parameter''s choices';
  end if;

  if v_type = 'numeric' then
    if new.normal_text is not null then
      raise exception 'lab reference range: numeric parameters use low/high bounds, not normal_text';
    end if;
  else
    if num_nonnulls(new.low, new.high, new.critical_low, new.critical_high) > 0 or new.normal_text is null then
      raise exception 'lab reference range: % parameters use normal_text only', v_type;
    end if;
  end if;

  if new.active then
    select r.id into v_clash
    from public.lab_reference_ranges r
    where r.parameter_id = new.parameter_id
      and r.active
      and r.id <> new.id
      and r.sex is not distinct from new.sex
      and coalesce(r.age_min_days, 0) <= coalesce(new.age_max_days, 2147483647)
      and coalesce(new.age_min_days, 0) <= coalesce(r.age_max_days, 2147483647)
    limit 1;
    if found then
      raise exception 'lab reference range: overlaps active range % for the same sex and age band', v_clash;
    end if;
  end if;
  return new;
end;
$$;

revoke all on function public.lab_reference_ranges_validate() from public, anon, authenticated;

create trigger lab_reference_ranges_validate
  before insert or update on public.lab_reference_ranges
  for each row execute function public.lab_reference_ranges_validate();

-- ---------------------------------------------------------------------------
-- Audit: configuration changes (no patient data in these tables)
-- ---------------------------------------------------------------------------

create trigger lab_tests_audit after insert or update or delete on public.lab_tests
  for each row execute function public.audit_track_changes();
create trigger lab_test_parameters_audit after insert or update or delete on public.lab_test_parameters
  for each row execute function public.audit_track_changes();
create trigger lab_reference_ranges_audit after insert or update or delete on public.lab_reference_ranges
  for each row execute function public.audit_track_changes();
create trigger lab_panels_audit after insert or update or delete on public.lab_panels
  for each row execute function public.audit_track_changes();

-- ---------------------------------------------------------------------------
-- Access: staff read, server writes
-- ---------------------------------------------------------------------------

alter table public.lab_test_categories enable row level security;
alter table public.lab_tests enable row level security;
alter table public.lab_test_parameters enable row level security;
alter table public.lab_reference_ranges enable row level security;
alter table public.lab_panels enable row level security;
alter table public.lab_panel_tests enable row level security;

create policy "lab test categories read for clinic staff" on public.lab_test_categories
  for select to authenticated using (public.is_clinic_staff(clinic_id));
create policy "lab tests read for clinic staff" on public.lab_tests
  for select to authenticated using (public.is_clinic_staff(clinic_id));
create policy "lab test parameters read for clinic staff" on public.lab_test_parameters
  for select to authenticated using (public.is_clinic_staff(clinic_id));
create policy "lab reference ranges read for clinic staff" on public.lab_reference_ranges
  for select to authenticated using (public.is_clinic_staff(clinic_id));
create policy "lab panels read for clinic staff" on public.lab_panels
  for select to authenticated using (public.is_clinic_staff(clinic_id));
create policy "lab panel tests read for clinic staff" on public.lab_panel_tests
  for select to authenticated using (public.is_clinic_staff(clinic_id));

do $$
declare
  t text;
begin
  foreach t in array array['lab_test_categories', 'lab_tests', 'lab_test_parameters',
                           'lab_reference_ranges', 'lab_panels', 'lab_panel_tests'] loop
    execute format('revoke all on table public.%I from public, anon, authenticated, service_role', t);
    execute format('grant select on table public.%I to authenticated', t);
    execute format('grant select, insert, update, delete on table public.%I to service_role', t);
  end loop;
end;
$$;

-- =====================================================================
-- FILE: 20261005000003_lab_orders_samples.sql
-- =====================================================================
-- Laboratory (Phase 2, 3 of 4): lab orders, order items and samples.
--
-- docs/labs/PHASE_1_DOMAIN_MODEL.md §3.2–3.3 and §4, owner decisions
-- 2026-10-05.
--
--   lab_orders        one request for one patient. Any staff member of the
--                     clinic may order (no per-role or per-test restriction);
--                     the database records who did. Three sources: a doctor's
--                     consultation, a walk-in (reception / lab), an external
--                     import.
--   lab_order_items   one test in an order — the unit of lab work. It freezes
--                     the test's code, name and standalone price when ordered,
--                     plus the price actually charged (a panel's price is
--                     allocated across its tests by the ordering function,
--                     Phase 5 — O2). Catalog edits never rewrite history.
--   lab_samples       a physical specimen of the order's patient.
--   lab_sample_items  which items a specimen serves (one tube, several tests);
--                     an item has at most one sample that is not rejected.
--
-- Lifecycles are separate columns, each guarded by a trigger:
--   order   active → completed | cancelled
--   item    ordered → ready_for_collection → collected → processing → resulted → verified
--           (ordered | ready_for_collection) → cancelled
--           collected | processing → ready_for_collection   (sample rejected)
--           resulted → processing                            (result returned)
--   sample  collected → received → rejected, collected → rejected
-- Payment is NOT part of any of these (O6): it stays on payments.
--
-- Deletion: nothing here cascades from a patient. Deleting a patient who has
-- lab history fails (NO ACTION) instead of erasing that history; retention is
-- an open legal question and this migration does not decide it. Deleting a
-- clinic still removes everything (its rows cascade from clinics).
--
-- Access: no signed-in role may read or write these tables directly in this
-- phase — the server authorizes every read and write (Phase 3 decides any
-- direct read). RLS policies are still defined as the backstop, matching the
-- AGENTS.md access model: operational staff see their clinic's work status,
-- a doctor only patients doctor_can_read_patient() admits.

create type public.lab_order_source as enum ('consultation', 'walk_in', 'external_import');
create type public.lab_order_status as enum ('active', 'completed', 'cancelled');
create type public.lab_item_status as enum (
  'ordered',
  'ready_for_collection',
  'collected',
  'processing',
  'resulted',
  'verified',
  'cancelled'
);
create type public.lab_sample_status as enum ('collected', 'received', 'rejected');

-- appointments (id, clinic_id, patient_id, doctor_id) is already unique
-- (appointments_id_clinic_id_patient_id_doctor_id_key).

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table public.lab_orders (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete cascade,
  patient_id uuid not null,
  source public.lab_order_source not null,
  -- The staff member who placed the order (any role of the clinic).
  ordered_by uuid not null references public.profiles(id),
  -- Set when the orderer is a linked doctor; required for a consultation.
  ordering_doctor_id uuid,
  -- The consultation the order came from (source = consultation only).
  appointment_id uuid,
  status public.lab_order_status not null default 'active',
  cancelled_at timestamptz,
  cancelled_by uuid references public.profiles(id),
  cancel_reason text,
  -- Provider / import identifier (source = external_import).
  external_reference text,
  -- Client idempotency key: a repeated submission resolves to this order.
  creation_key uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint lab_orders_id_clinic_id_key unique (id, clinic_id),
  constraint lab_orders_id_clinic_id_patient_id_key unique (id, clinic_id, patient_id),
  constraint lab_orders_patient_fkey
    foreign key (patient_id, clinic_id) references public.patients (id, clinic_id),
  constraint lab_orders_ordering_doctor_fkey
    foreign key (ordering_doctor_id, clinic_id) references public.doctors (id, clinic_id),
  -- The ordering doctor's own consultation with this patient in this clinic.
  constraint lab_orders_consultation_fkey
    foreign key (appointment_id, clinic_id, patient_id, ordering_doctor_id)
    references public.appointments (id, clinic_id, patient_id, doctor_id),
  constraint lab_orders_consultation_source_check
    check ((source = 'consultation') = (appointment_id is not null)),
  -- MATCH SIMPLE skips the FK when ordering_doctor_id is NULL: forbid that.
  constraint lab_orders_consultation_doctor_check
    check (appointment_id is null or ordering_doctor_id is not null),
  constraint lab_orders_external_reference_check
    check ((source = 'external_import') = (external_reference is not null)
           and (external_reference is null or (external_reference ~ '\S' and char_length(external_reference) <= 120))),
  constraint lab_orders_cancel_check
    check ((status = 'cancelled') = (cancelled_at is not null)
           and (status = 'cancelled') = (cancelled_by is not null)
           and (cancel_reason is null or (cancel_reason ~ '\S' and char_length(cancel_reason) <= 300)))
);

create table public.lab_order_items (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete cascade,
  order_id uuid not null,
  patient_id uuid not null,
  test_id uuid not null,
  -- The panel this item was ordered through, if any.
  panel_id uuid,
  test_code_snapshot text not null,
  test_name_snapshot text not null,
  -- The test's standalone catalog price when ordered.
  list_price_snapshot numeric(12, 2) not null,
  -- The price actually charged for this item (= list price for a single test,
  -- the allocated share of the panel price for a panel item — O2).
  price_snapshot numeric(12, 2) not null,
  status public.lab_item_status not null default 'ordered',
  status_changed_at timestamptz not null default now(),
  status_changed_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint lab_order_items_id_clinic_id_key unique (id, clinic_id),
  constraint lab_order_items_id_clinic_id_patient_id_key unique (id, clinic_id, patient_id),
  constraint lab_order_items_order_test_key unique (order_id, test_id),
  constraint lab_order_items_order_fkey
    foreign key (order_id, clinic_id, patient_id) references public.lab_orders (id, clinic_id, patient_id),
  constraint lab_order_items_test_fkey
    foreign key (test_id, clinic_id) references public.lab_tests (id, clinic_id),
  constraint lab_order_items_panel_fkey
    foreign key (panel_id, clinic_id) references public.lab_panels (id, clinic_id),
  constraint lab_order_items_prices_check
    check (list_price_snapshot >= 0 and price_snapshot >= 0
           and (panel_id is not null or price_snapshot = list_price_snapshot))
);

create table public.lab_samples (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete cascade,
  patient_id uuid not null,
  order_id uuid not null,
  -- Human / barcode identifier, unique in the clinic.
  sample_code text not null,
  sample_type text not null,
  status public.lab_sample_status not null default 'collected',
  collected_at timestamptz not null default now(),
  collected_by uuid not null references public.profiles(id),
  received_at timestamptz,
  received_by uuid references public.profiles(id),
  rejected_at timestamptz,
  rejected_by uuid references public.profiles(id),
  reject_reason text,
  -- Operational notes only (e.g. "haemolysed", "second attempt").
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint lab_samples_id_clinic_id_key unique (id, clinic_id),
  constraint lab_samples_clinic_code_key unique (clinic_id, sample_code),
  constraint lab_samples_order_fkey
    foreign key (order_id, clinic_id, patient_id) references public.lab_orders (id, clinic_id, patient_id),
  constraint lab_samples_code_check check (sample_code ~ '^[A-Za-z0-9-]{3,40}$'),
  constraint lab_samples_type_check check (sample_type ~ '\S' and char_length(sample_type) <= 80),
  constraint lab_samples_received_check
    check ((received_at is null) = (received_by is null)),
  constraint lab_samples_rejected_check
    check ((status = 'rejected') = (rejected_at is not null)
           and (status = 'rejected') = (rejected_by is not null)
           and (status = 'rejected') = (reject_reason is not null)
           and (reject_reason is null or (reject_reason ~ '\S' and char_length(reject_reason) <= 300))),
  constraint lab_samples_notes_check check (notes is null or char_length(notes) <= 500)
);

create table public.lab_sample_items (
  sample_id uuid not null,
  order_item_id uuid not null,
  clinic_id uuid not null references public.clinics(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (sample_id, order_item_id),
  constraint lab_sample_items_sample_fkey
    foreign key (sample_id, clinic_id) references public.lab_samples (id, clinic_id),
  constraint lab_sample_items_item_fkey
    foreign key (order_item_id, clinic_id) references public.lab_order_items (id, clinic_id)
);

comment on table public.lab_orders is 'A lab request for one patient. Any clinic staff member may order; ordered_by records who. Server-only.';
comment on table public.lab_order_items is 'One test of a lab order with code, name, list price and charged price frozen at order time. Its status is the lab work position.';
comment on table public.lab_samples is 'A physical specimen of the order''s patient.';
comment on table public.lab_sample_items is 'Which order items a specimen serves; an item has at most one non-rejected sample.';

create unique index lab_orders_creation_key_key on public.lab_orders (clinic_id, ordered_by, creation_key)
  where creation_key is not null;
create unique index lab_orders_external_reference_key on public.lab_orders (clinic_id, external_reference)
  where external_reference is not null;
create index lab_orders_patient_idx on public.lab_orders (clinic_id, patient_id, created_at desc);
create index lab_orders_status_idx on public.lab_orders (clinic_id, status, created_at);
create index lab_orders_appointment_idx on public.lab_orders (appointment_id) where appointment_id is not null;
create index lab_order_items_status_idx on public.lab_order_items (clinic_id, status, created_at);
create index lab_order_items_patient_test_idx on public.lab_order_items (clinic_id, patient_id, test_id, created_at desc);
create index lab_order_items_order_idx on public.lab_order_items (order_id);
create index lab_samples_status_idx on public.lab_samples (clinic_id, status, collected_at);
create index lab_samples_order_idx on public.lab_samples (order_id);
create index lab_sample_items_item_idx on public.lab_sample_items (order_item_id);

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

-- Any staff role of the clinic (lab ordering has no role restriction).
create or replace function public.lab_is_clinic_member(p_clinic_id uuid, p_profile_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.staff_roles sr
    where sr.clinic_id = p_clinic_id and sr.profile_id = p_profile_id
  );
$$;

revoke all on function public.lab_is_clinic_member(uuid, uuid) from public, anon, authenticated;
grant execute on function public.lab_is_clinic_member(uuid, uuid) to service_role;

-- True while this transaction deletes the clinic (clinics_mark_erasure,
-- 20260930000006): its lab rows go with it, and only then may append-only
-- lab rows be deleted.
create or replace function public.lab_clinic_is_being_erased(p_clinic_id uuid)
returns boolean
language sql
stable
set search_path = public, pg_temp
as $$
  select strpos(coalesce(current_setting('app.erasing_clinics', true), ''), p_clinic_id::text || ',') > 0;
$$;

revoke all on function public.lab_clinic_is_being_erased(uuid) from public, anon, authenticated;

-- Fails unless only the listed columns differ between OLD and NEW.
create or replace function public.lab_assert_only_changed(p_old jsonb, p_new jsonb, p_mutable text[], p_what text)
returns void
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  v_key text;
begin
  for v_key in select jsonb_object_keys(p_new) loop
    if not (v_key = any (p_mutable)) and (p_old -> v_key) is distinct from (p_new -> v_key) then
      raise exception '%: % cannot be changed', p_what, v_key;
    end if;
  end loop;
end;
$$;

revoke all on function public.lab_assert_only_changed(jsonb, jsonb, text[], text) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- lab_orders: provenance, lifecycle, immutability
-- ---------------------------------------------------------------------------

create or replace function public.lab_orders_validate()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_dob date;
  v_doctor_profile uuid;
  v_doctor_active boolean;
  v_appointment_status public.appointment_status;
begin
  if tg_op = 'INSERT' then
    new.created_at := now();
    new.updated_at := now();
    if new.status <> 'active' then
      raise exception 'lab order: a new order must be active';
    end if;
    if not public.lab_is_clinic_member(new.clinic_id, new.ordered_by) then
      raise exception 'lab order: ordered_by must be a staff member of the clinic';
    end if;

    select p.date_of_birth into v_dob
    from public.patients p
    where p.id = new.patient_id and p.clinic_id = new.clinic_id;
    if found and v_dob is null and new.source <> 'external_import' then
      raise exception 'lab order: the patient''s date of birth is required before ordering lab tests';
    end if;

    if new.ordering_doctor_id is not null then
      select d.profile_id, d.active into v_doctor_profile, v_doctor_active
      from public.doctors d
      where d.id = new.ordering_doctor_id and d.clinic_id = new.clinic_id;
      if not found or not v_doctor_active or v_doctor_profile is distinct from new.ordered_by then
        raise exception 'lab order: ordering_doctor_id must be the orderer''s own active doctor account';
      end if;
    end if;

    if new.appointment_id is not null then
      select a.status into v_appointment_status
      from public.appointments a
      where a.id = new.appointment_id and a.clinic_id = new.clinic_id;
      if found and v_appointment_status not in ('in_progress', 'completed') then
        raise exception 'lab order: the consultation must be in progress or completed (it is %)', v_appointment_status;
      end if;
    end if;
    return new;
  end if;

  -- UPDATE: only the lifecycle moves.
  perform public.lab_assert_only_changed(
    to_jsonb(old), to_jsonb(new),
    array['status', 'cancelled_at', 'cancelled_by', 'cancel_reason', 'updated_at'],
    'lab order');
  new.updated_at := now();

  if new.status is distinct from old.status then
    if old.status <> 'active' then
      raise exception 'lab order: a % order cannot change status', old.status;
    end if;
    if new.status = 'cancelled' then
      new.cancelled_at := now();
      if new.cancelled_by is null or not public.lab_is_clinic_member(new.clinic_id, new.cancelled_by) then
        raise exception 'lab order: cancelled_by must be a staff member of the clinic';
      end if;
      if exists (
        select 1 from public.lab_order_items i
        where i.order_id = new.id
          and i.status not in ('ordered', 'ready_for_collection', 'cancelled')
      ) then
        raise exception 'lab order: an order with collected samples cannot be cancelled';
      end if;
    elsif new.status = 'completed' then
      if exists (
        select 1 from public.lab_order_items i
        where i.order_id = new.id and i.status not in ('verified', 'cancelled')
      ) or not exists (
        select 1 from public.lab_order_items i
        where i.order_id = new.id and i.status = 'verified'
      ) then
        raise exception 'lab order: completed requires every item verified or cancelled, and at least one verified';
      end if;
    end if;
  elsif new.cancelled_at is distinct from old.cancelled_at
     or new.cancelled_by is distinct from old.cancelled_by
     or new.cancel_reason is distinct from old.cancel_reason then
    raise exception 'lab order: cancellation details change only when the order is cancelled';
  end if;
  return new;
end;
$$;

revoke all on function public.lab_orders_validate() from public, anon, authenticated;

create trigger lab_orders_validate
  before insert or update on public.lab_orders
  for each row execute function public.lab_orders_validate();

-- Cancelling an order cancels its open items.
create or replace function public.lab_orders_cancel_items()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.lab_order_items
  set status = 'cancelled', status_changed_by = new.cancelled_by
  where order_id = new.id and status in ('ordered', 'ready_for_collection');
  return null;
end;
$$;

revoke all on function public.lab_orders_cancel_items() from public, anon, authenticated;

create trigger lab_orders_cancel_items
  after update of status on public.lab_orders
  for each row when (new.status = 'cancelled' and old.status is distinct from new.status)
  execute function public.lab_orders_cancel_items();

-- ---------------------------------------------------------------------------
-- lab_order_items: snapshots from the catalog, lifecycle
-- ---------------------------------------------------------------------------

create or replace function public.lab_item_transition_allowed(
  p_from public.lab_item_status,
  p_to public.lab_item_status,
  p_source public.lab_order_source
)
returns boolean
language sql
immutable
set search_path = public, pg_temp
as $$
  select case
    -- Historical / external results arrive already performed.
    when p_source = 'external_import' then
      (p_from, p_to) in (('ordered', 'resulted'), ('ordered', 'verified'), ('resulted', 'verified'),
                         ('resulted', 'processing'), ('processing', 'resulted'), ('ordered', 'cancelled'))
    else
      (p_from, p_to) in (
        ('ordered', 'ready_for_collection'),
        ('ordered', 'cancelled'),
        ('ready_for_collection', 'collected'),
        ('ready_for_collection', 'cancelled'),
        ('collected', 'processing'),
        ('collected', 'ready_for_collection'),
        ('processing', 'resulted'),
        ('processing', 'ready_for_collection'),
        ('resulted', 'verified'),
        ('resulted', 'processing'))
  end;
$$;

revoke all on function public.lab_item_transition_allowed(public.lab_item_status, public.lab_item_status, public.lab_order_source)
  from public, anon, authenticated;

create or replace function public.lab_order_items_validate()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order public.lab_orders;
  v_test public.lab_tests;
begin
  select * into v_order from public.lab_orders o where o.id = new.order_id and o.clinic_id = new.clinic_id;

  if tg_op = 'INSERT' then
    new.created_at := now();
    new.updated_at := now();
    new.status_changed_at := now();
    if v_order.status is distinct from 'active' then
      raise exception 'lab order item: items can only be added to an active order';
    end if;
    if new.status <> 'ordered' then
      raise exception 'lab order item: a new item starts as ordered';
    end if;

    select * into v_test from public.lab_tests t where t.id = new.test_id and t.clinic_id = new.clinic_id;
    if not found then
      raise exception 'lab order item: unknown test';
    end if;
    if not v_test.active and v_order.source <> 'external_import' then
      raise exception 'lab order item: test % is inactive and cannot be ordered', v_test.code;
    end if;
    if new.panel_id is not null then
      if not exists (
        select 1 from public.lab_panel_tests pt
        where pt.panel_id = new.panel_id and pt.test_id = new.test_id and pt.clinic_id = new.clinic_id
      ) then
        raise exception 'lab order item: test % is not part of the panel', v_test.code;
      end if;
      if v_order.source <> 'external_import' and not exists (
        select 1 from public.lab_panels p where p.id = new.panel_id and p.active
      ) then
        raise exception 'lab order item: the panel is inactive and cannot be ordered';
      end if;
    end if;

    -- The catalog, never the caller, decides what the item is and costs.
    new.test_code_snapshot := v_test.code;
    new.test_name_snapshot := v_test.name;
    new.list_price_snapshot := v_test.price;
    if new.panel_id is null then
      new.price_snapshot := v_test.price;
    end if;
    return new;
  end if;

  -- UPDATE: only the work position moves.
  perform public.lab_assert_only_changed(
    to_jsonb(old), to_jsonb(new),
    array['status', 'status_changed_at', 'status_changed_by', 'updated_at'],
    'lab order item');
  new.updated_at := now();
  if new.status is distinct from old.status then
    if not public.lab_item_transition_allowed(old.status, new.status, v_order.source) then
      raise exception 'lab order item: % → % is not allowed', old.status, new.status;
    end if;
    if new.status = 'ready_for_collection' and v_order.status <> 'active' then
      raise exception 'lab order item: the order is %', v_order.status;
    end if;
    new.status_changed_at := now();
    if new.status_changed_by is not null and not public.lab_is_clinic_member(new.clinic_id, new.status_changed_by) then
      raise exception 'lab order item: status_changed_by must be a staff member of the clinic';
    end if;
  else
    new.status_changed_at := old.status_changed_at;
    new.status_changed_by := old.status_changed_by;
  end if;
  return new;
end;
$$;

revoke all on function public.lab_order_items_validate() from public, anon, authenticated;

create trigger lab_order_items_validate
  before insert or update on public.lab_order_items
  for each row execute function public.lab_order_items_validate();

-- ---------------------------------------------------------------------------
-- lab_samples and lab_sample_items
-- ---------------------------------------------------------------------------

create or replace function public.lab_samples_validate()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'INSERT' then
    new.created_at := now();
    new.updated_at := now();
    new.collected_at := now();
    if new.status <> 'collected' or new.received_at is not null or new.rejected_at is not null then
      raise exception 'lab sample: a new sample starts as collected';
    end if;
    if not exists (
      select 1 from public.lab_orders o
      where o.id = new.order_id and o.clinic_id = new.clinic_id and o.status = 'active'
    ) then
      raise exception 'lab sample: samples can only be collected for an active order';
    end if;
    if not public.lab_is_clinic_member(new.clinic_id, new.collected_by) then
      raise exception 'lab sample: collected_by must be a staff member of the clinic';
    end if;
    return new;
  end if;

  perform public.lab_assert_only_changed(
    to_jsonb(old), to_jsonb(new),
    array['status', 'received_at', 'received_by', 'rejected_at', 'rejected_by', 'reject_reason', 'notes', 'updated_at'],
    'lab sample');
  new.updated_at := now();

  if new.status is distinct from old.status then
    if not ((old.status, new.status) in (('collected', 'received'), ('collected', 'rejected'), ('received', 'rejected'))) then
      raise exception 'lab sample: % → % is not allowed', old.status, new.status;
    end if;
    if new.status = 'received' then
      new.received_at := now();
      if new.received_by is null or not public.lab_is_clinic_member(new.clinic_id, new.received_by) then
        raise exception 'lab sample: received_by must be a staff member of the clinic';
      end if;
    else
      new.rejected_at := now();
      if new.rejected_by is null or not public.lab_is_clinic_member(new.clinic_id, new.rejected_by) then
        raise exception 'lab sample: rejected_by must be a staff member of the clinic';
      end if;
    end if;
  elsif new.received_at is distinct from old.received_at or new.received_by is distinct from old.received_by
     or new.rejected_at is distinct from old.rejected_at or new.rejected_by is distinct from old.rejected_by
     or new.reject_reason is distinct from old.reject_reason then
    raise exception 'lab sample: receipt and rejection details change only with the status';
  end if;
  return new;
end;
$$;

revoke all on function public.lab_samples_validate() from public, anon, authenticated;

create trigger lab_samples_validate
  before insert or update on public.lab_samples
  for each row execute function public.lab_samples_validate();

-- A link is fixed once made; it may only be created for an item of the same
-- order that is not cancelled and has no other live (non-rejected) sample.
-- The item row is locked, so two collectors cannot both attach a sample.
create or replace function public.lab_sample_items_validate()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_item public.lab_order_items;
  v_sample public.lab_samples;
begin
  if tg_op = 'DELETE' and public.lab_clinic_is_being_erased(old.clinic_id) then
    return old;
  end if;
  if tg_op <> 'INSERT' then
    raise exception 'lab sample item: links cannot be changed or removed';
  end if;
  new.created_at := now();

  select * into v_item from public.lab_order_items i
  where i.id = new.order_item_id and i.clinic_id = new.clinic_id
  for update;
  select * into v_sample from public.lab_samples s
  where s.id = new.sample_id and s.clinic_id = new.clinic_id;

  if v_item.id is null or v_sample.id is null then
    raise exception 'lab sample item: unknown sample or order item';
  end if;
  if v_item.order_id <> v_sample.order_id or v_item.patient_id <> v_sample.patient_id then
    raise exception 'lab sample item: the sample and the order item belong to different orders';
  end if;
  if v_sample.status = 'rejected' then
    raise exception 'lab sample item: the sample was rejected';
  end if;
  if v_item.status in ('cancelled', 'verified') then
    raise exception 'lab sample item: the order item is %', v_item.status;
  end if;
  if exists (
    select 1
    from public.lab_sample_items si
    join public.lab_samples s on s.id = si.sample_id
    where si.order_item_id = new.order_item_id and s.status <> 'rejected'
  ) then
    raise exception 'lab sample item: the order item already has a sample';
  end if;
  return new;
end;
$$;

revoke all on function public.lab_sample_items_validate() from public, anon, authenticated;

create trigger lab_sample_items_validate
  before insert or update or delete on public.lab_sample_items
  for each row execute function public.lab_sample_items_validate();

-- ---------------------------------------------------------------------------
-- Audit: ids and states only — never values or free text
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
  v_values jsonb;
begin
  if tg_table_name = 'lab_orders' then
    if tg_op = 'INSERT' then
      v_action := 'lab_order_created';
      v_actor := new.ordered_by;
    elsif new.status is distinct from old.status then
      v_action := 'lab_order_' || new.status::text;
      v_actor := coalesce(new.cancelled_by, auth.uid());
    else
      return null;
    end if;
    v_values := jsonb_build_object('status', new.status, 'source', new.source,
                                   'ordering_doctor_id', new.ordering_doctor_id, 'appointment_id', new.appointment_id);
  elsif tg_table_name = 'lab_order_items' then
    if tg_op = 'INSERT' then
      v_action := 'lab_order_item_created';
    elsif new.status is distinct from old.status then
      v_action := 'lab_order_item_status_changed';
    else
      return null;
    end if;
    v_actor := coalesce(new.status_changed_by, auth.uid());
    v_values := jsonb_build_object('order_id', new.order_id, 'test_id', new.test_id, 'status', new.status,
                                   'previous_status', case when tg_op = 'UPDATE' then old.status end);
  elsif tg_table_name = 'lab_samples' then
    if tg_op = 'INSERT' then
      v_action := 'lab_sample_collected';
      v_actor := new.collected_by;
    elsif new.status is distinct from old.status then
      v_action := 'lab_sample_' || new.status::text;
      v_actor := coalesce(new.rejected_by, new.received_by, auth.uid());
    else
      return null;
    end if;
    v_values := jsonb_build_object('order_id', new.order_id, 'status', new.status);
  else
    return null;
  end if;

  insert into public.audit_events (clinic_id, actor_id, actor_type, action, entity_type, entity_id, patient_id, new_values)
  values (
    new.clinic_id,
    v_actor,
    case when v_actor is null then 'system'::public.actor_type else 'staff'::public.actor_type end,
    v_action,
    tg_table_name,
    new.id::text,
    new.patient_id,
    v_values
  );
  return null;
end;
$$;

revoke all on function public.lab_workflow_audit() from public, anon, authenticated;

create trigger lab_orders_audit after insert or update on public.lab_orders
  for each row execute function public.lab_workflow_audit();
create trigger lab_order_items_audit after insert or update on public.lab_order_items
  for each row execute function public.lab_workflow_audit();
create trigger lab_samples_audit after insert or update on public.lab_samples
  for each row execute function public.lab_workflow_audit();

-- ---------------------------------------------------------------------------
-- Access: server only; RLS as the backstop
-- ---------------------------------------------------------------------------

alter table public.lab_orders enable row level security;
alter table public.lab_order_items enable row level security;
alter table public.lab_samples enable row level security;
alter table public.lab_sample_items enable row level security;

create policy "lab orders read for operational staff" on public.lab_orders
  for select to authenticated
  using (public.is_clinic_staff(clinic_id, array['owner', 'admin', 'manager', 'receptionist']::public.staff_role[]));
create policy "lab orders read for authorized doctors" on public.lab_orders
  for select to authenticated
  using (public.doctor_can_read_patient(clinic_id, patient_id));

create policy "lab order items read for operational staff" on public.lab_order_items
  for select to authenticated
  using (public.is_clinic_staff(clinic_id, array['owner', 'admin', 'manager', 'receptionist']::public.staff_role[]));
create policy "lab order items read for authorized doctors" on public.lab_order_items
  for select to authenticated
  using (public.doctor_can_read_patient(clinic_id, patient_id));

create policy "lab samples read for operational staff" on public.lab_samples
  for select to authenticated
  using (public.is_clinic_staff(clinic_id, array['owner', 'admin', 'manager', 'receptionist']::public.staff_role[]));
create policy "lab samples read for authorized doctors" on public.lab_samples
  for select to authenticated
  using (public.doctor_can_read_patient(clinic_id, patient_id));

create policy "lab sample items read for operational staff" on public.lab_sample_items
  for select to authenticated
  using (public.is_clinic_staff(clinic_id, array['owner', 'admin', 'manager', 'receptionist']::public.staff_role[]));

do $$
declare
  t text;
begin
  foreach t in array array['lab_orders', 'lab_order_items', 'lab_samples', 'lab_sample_items'] loop
    execute format('revoke all on table public.%I from public, anon, authenticated, service_role', t);
    execute format('grant select, insert, update on table public.%I to service_role', t);
  end loop;
end;
$$;

-- =====================================================================
-- FILE: 20261005000004_lab_results_documents.sql
-- =====================================================================
-- Laboratory (Phase 2, 4 of 4): results, versions, verification, documents.
--
-- docs/labs/PHASE_1_DOMAIN_MODEL.md §3.4–3.5, §4–§7, owner decisions
-- 2026-10-05.
--
--   lab_results        one VERSION of the result of one order item.
--                      draft → submitted → verified → superseded
--                      A verified result is never changed. A correction is a
--                      new version (supersedes_result_id + reason); when the
--                      correction is verified, the previous version becomes
--                      superseded in the same statement. One verified version
--                      and at most one version in progress per item.
--   lab_result_values  one parameter value of a version. Only drafts accept
--                      values. The unit, the reference range used and the flag
--                      are set by the database from the clinic's configuration
--                      and the patient's sex and age — never by the caller —
--                      and frozen with the value. The flag only places the
--                      value against the configured range; nothing here
--                      interprets it clinically.
--   lab_documents      report / scan / image metadata; the bytes live in the
--                      private bucket lab-documents at <clinic_id>/<id>.
--                      Documents are withdrawn, never deleted.
--
-- O4: every result needs a second person. Whoever entered or submitted a
-- version can never verify it (CHECK constraint + trigger). Doctors may verify.
--
-- Access: result data is server-only (AGENTS.md). No signed-in role has any
-- privilege on these tables and RLS is enabled without policies, so even a
-- stray grant exposes nothing. The server authorizes and audits every read.

create type public.lab_result_status as enum ('draft', 'submitted', 'verified', 'superseded');
create type public.lab_result_source as enum ('manual', 'import', 'external');
create type public.lab_value_flag as enum (
  'normal',
  'low',
  'high',
  'critical_low',
  'critical_high',
  'abnormal',
  'not_evaluated'
);
create type public.lab_document_kind as enum ('report', 'scan', 'image', 'import_source');

comment on type public.lab_value_flag is
  'Position of a value against the CONFIGURED reference range (low/high/critical bounds or expected text). not_evaluated when no configured range applies. Not a clinical interpretation.';

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table public.lab_results (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete cascade,
  patient_id uuid not null,
  order_item_id uuid not null,
  version integer not null default 1,
  supersedes_result_id uuid,
  status public.lab_result_status not null default 'draft',
  source public.lab_result_source not null default 'manual',
  entered_by uuid not null references public.profiles(id),
  entered_at timestamptz not null default now(),
  submitted_by uuid references public.profiles(id),
  submitted_at timestamptz,
  verified_by uuid references public.profiles(id),
  verified_at timestamptz,
  -- Why a verified result is being corrected (version > 1).
  correction_reason text,
  -- Laboratory-technical remark (lab data, not a doctor's note).
  lab_comment text,
  -- When the test was performed; for imports, the historical date.
  performed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint lab_results_id_clinic_id_key unique (id, clinic_id),
  constraint lab_results_item_version_key unique (order_item_id, version),
  constraint lab_results_item_fkey
    foreign key (order_item_id, clinic_id, patient_id) references public.lab_order_items (id, clinic_id, patient_id),
  constraint lab_results_supersedes_fkey
    foreign key (supersedes_result_id, clinic_id) references public.lab_results (id, clinic_id),
  constraint lab_results_version_check
    check (version >= 1 and (version = 1) = (supersedes_result_id is null)),
  constraint lab_results_correction_reason_check
    check ((version > 1) = (correction_reason is not null)
           and (correction_reason is null or (correction_reason ~ '\S' and char_length(correction_reason) <= 300))),
  constraint lab_results_comment_check
    check (lab_comment is null or (lab_comment ~ '\S' and char_length(lab_comment) <= 1000)),
  constraint lab_results_submitted_check
    check ((submitted_by is null) = (submitted_at is null)
           and (status = 'draft' or submitted_by is not null)),
  constraint lab_results_verified_check
    check ((verified_by is null) = (verified_at is null)
           and (status in ('verified', 'superseded')) = (verified_by is not null)),
  -- O4: a second person verifies.
  constraint lab_results_second_person_check
    check (verified_by is null or (verified_by <> entered_by and verified_by <> submitted_by))
);

create table public.lab_result_values (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete cascade,
  result_id uuid not null,
  parameter_id uuid not null,
  value_numeric numeric,
  value_text text,
  value_boolean boolean,
  -- Frozen from configuration when the value was recorded.
  unit_snapshot text,
  reference_range_id uuid,
  range_low numeric,
  range_high numeric,
  range_text text,
  critical_low numeric,
  critical_high numeric,
  flag public.lab_value_flag not null default 'not_evaluated',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint lab_result_values_id_clinic_id_key unique (id, clinic_id),
  constraint lab_result_values_result_parameter_key unique (result_id, parameter_id),
  constraint lab_result_values_result_fkey
    foreign key (result_id, clinic_id) references public.lab_results (id, clinic_id) on delete cascade,
  constraint lab_result_values_parameter_fkey
    foreign key (parameter_id, clinic_id) references public.lab_test_parameters (id, clinic_id),
  constraint lab_result_values_range_fkey
    foreign key (reference_range_id, clinic_id) references public.lab_reference_ranges (id, clinic_id),
  constraint lab_result_values_one_value_check
    check (num_nonnulls(value_numeric, value_text, value_boolean) = 1),
  constraint lab_result_values_text_check
    check (value_text is null or (value_text ~ '\S' and char_length(value_text) <= 500))
);

create table public.lab_documents (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete cascade,
  patient_id uuid not null,
  order_id uuid not null,
  result_id uuid,
  kind public.lab_document_kind not null,
  storage_path text not null,
  mime_type text not null,
  size_bytes bigint not null,
  sha256 text not null,
  uploaded_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now(),
  withdrawn_at timestamptz,
  withdrawn_by uuid references public.profiles(id),
  withdraw_reason text,

  constraint lab_documents_id_clinic_id_key unique (id, clinic_id),
  constraint lab_documents_storage_path_key unique (storage_path),
  constraint lab_documents_order_fkey
    foreign key (order_id, clinic_id, patient_id) references public.lab_orders (id, clinic_id, patient_id),
  constraint lab_documents_result_fkey
    foreign key (result_id, clinic_id) references public.lab_results (id, clinic_id),
  constraint lab_documents_path_check
    check (storage_path = clinic_id::text || '/' || id::text),
  constraint lab_documents_mime_check
    check (mime_type in ('application/pdf', 'image/jpeg', 'image/png', 'image/webp')),
  constraint lab_documents_size_check
    check (size_bytes > 0 and size_bytes <= 20971520),
  constraint lab_documents_sha256_check
    check (sha256 ~ '^[0-9a-f]{64}$'),
  constraint lab_documents_withdrawn_check
    check ((withdrawn_at is null) = (withdrawn_by is null)
           and (withdrawn_at is null) = (withdraw_reason is null)
           and (withdraw_reason is null or (withdraw_reason ~ '\S' and char_length(withdraw_reason) <= 300)))
);

comment on table public.lab_results is 'Versioned result of one lab order item. Verified versions are immutable; corrections are new versions. Second-person verification. Server-only.';
comment on table public.lab_result_values is 'Parameter values of a lab result version with the unit, reference range and flag frozen by the database. Server-only.';
comment on table public.lab_documents is 'Lab report / scan / image metadata; bytes in private bucket lab-documents. Withdrawn, never deleted. Server-only.';

create unique index lab_results_one_verified_key on public.lab_results (order_item_id) where status = 'verified';
create unique index lab_results_one_in_progress_key on public.lab_results (order_item_id) where status in ('draft', 'submitted');
create unique index lab_results_one_correction_key on public.lab_results (supersedes_result_id) where supersedes_result_id is not null;
create index lab_results_patient_idx on public.lab_results (clinic_id, patient_id, created_at desc);
create index lab_results_queue_idx on public.lab_results (clinic_id, status, updated_at) where status in ('draft', 'submitted');
create index lab_result_values_parameter_idx on public.lab_result_values (parameter_id);
create index lab_documents_order_idx on public.lab_documents (clinic_id, order_id);
create index lab_documents_result_idx on public.lab_documents (result_id) where result_id is not null;

-- ---------------------------------------------------------------------------
-- lab_results: versions, second-person verification, immutability
-- ---------------------------------------------------------------------------

create or replace function public.lab_results_validate()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_item public.lab_order_items;
  v_source public.lab_order_source;
  v_target public.lab_results;
begin
  if tg_op = 'DELETE' then
    if old.status = 'draft' or public.lab_clinic_is_being_erased(old.clinic_id) then
      return old;
    end if;
    raise exception 'lab result: only a draft can be discarded';
  end if;

  if tg_op = 'INSERT' then
    new.created_at := now();
    new.updated_at := now();
    new.entered_at := now();
    if new.status <> 'draft' or new.submitted_by is not null or new.verified_by is not null then
      raise exception 'lab result: a new result starts as a draft';
    end if;
    if not public.lab_is_clinic_member(new.clinic_id, new.entered_by) then
      raise exception 'lab result: entered_by must be a staff member of the clinic';
    end if;
    if new.performed_at is not null and new.performed_at > now() + interval '5 minutes' then
      raise exception 'lab result: performed_at cannot be in the future';
    end if;

    -- One writer per item at a time.
    select * into v_item from public.lab_order_items i
    where i.id = new.order_item_id and i.clinic_id = new.clinic_id
    for update;
    if not found then
      raise exception 'lab result: unknown order item';
    end if;
    select o.source into v_source from public.lab_orders o where o.id = v_item.order_id;

    if new.supersedes_result_id is null then
      if exists (select 1 from public.lab_results r where r.order_item_id = new.order_item_id) then
        raise exception 'lab result: the item already has a result; a change to a verified result is a correction';
      end if;
      if new.source = 'manual' and v_source = 'external_import' then
        raise exception 'lab result: results of an imported order are recorded with source import or external';
      end if;
      if v_source = 'external_import' then
        if v_item.status not in ('ordered', 'processing') then
          raise exception 'lab result: the imported item is %', v_item.status;
        end if;
      elsif v_item.status not in ('collected', 'processing') then
        raise exception 'lab result: results are entered after the sample is collected (the item is %)', v_item.status;
      end if;
    else
      select * into v_target from public.lab_results r
      where r.id = new.supersedes_result_id and r.clinic_id = new.clinic_id;
      if v_target.order_item_id is distinct from new.order_item_id or v_target.status <> 'verified' then
        raise exception 'lab result: a correction supersedes the current verified result of the same item';
      end if;
      if new.version <> v_target.version + 1 then
        raise exception 'lab result: a correction of version % is version %', v_target.version, v_target.version + 1;
      end if;
    end if;
    return new;
  end if;

  -- UPDATE
  perform public.lab_assert_only_changed(
    to_jsonb(old), to_jsonb(new),
    array['status', 'submitted_by', 'submitted_at', 'verified_by', 'verified_at', 'lab_comment', 'performed_at', 'updated_at'],
    'lab result');
  new.updated_at := now();

  if old.status = new.status then
    if old.status <> 'draft' then
      raise exception 'lab result: a % result cannot be edited', old.status;
    end if;
    if new.submitted_by is distinct from old.submitted_by or new.verified_by is distinct from old.verified_by
       or new.submitted_at is distinct from old.submitted_at or new.verified_at is distinct from old.verified_at then
      raise exception 'lab result: submission and verification details change only with the status';
    end if;
    if new.performed_at is not null and new.performed_at > now() + interval '5 minutes' then
      raise exception 'lab result: performed_at cannot be in the future';
    end if;
    return new;
  end if;

  if (old.status, new.status) = ('draft', 'submitted') then
    if new.submitted_by is null or not public.lab_is_clinic_member(new.clinic_id, new.submitted_by) then
      raise exception 'lab result: submitted_by must be a staff member of the clinic';
    end if;
    if not exists (select 1 from public.lab_result_values v where v.result_id = new.id) then
      raise exception 'lab result: a result without values cannot be submitted';
    end if;
    new.submitted_at := now();
    if new.lab_comment is distinct from old.lab_comment or new.performed_at is distinct from old.performed_at then
      raise exception 'lab result: save the draft before submitting it';
    end if;
  elsif (old.status, new.status) = ('submitted', 'draft') then
    -- Returned for correction by the reviewer.
    new.submitted_by := null;
    new.submitted_at := null;
  elsif (old.status, new.status) = ('submitted', 'verified') then
    if new.verified_by is null or not public.lab_is_clinic_member(new.clinic_id, new.verified_by) then
      raise exception 'lab result: verified_by must be a staff member of the clinic';
    end if;
    if new.verified_by = new.entered_by or new.verified_by = new.submitted_by then
      raise exception 'lab result: a second person must verify the result';
    end if;
    new.verified_at := now();
    -- A verified correction retires the version it corrects, first, so the
    -- one-verified-version index holds.
    if new.supersedes_result_id is not null then
      perform set_config('app.lab_superseding_result', new.supersedes_result_id::text, true);
      update public.lab_results set status = 'superseded' where id = new.supersedes_result_id;
      perform set_config('app.lab_superseding_result', '', true);
    end if;
  elsif (old.status, new.status) = ('verified', 'superseded') then
    if coalesce(current_setting('app.lab_superseding_result', true), '') <> old.id::text then
      raise exception 'lab result: a verified result is superseded only by verifying its correction';
    end if;
  else
    raise exception 'lab result: % → % is not allowed', old.status, new.status;
  end if;

  if new.status <> 'draft' and (new.lab_comment is distinct from old.lab_comment or new.performed_at is distinct from old.performed_at) then
    raise exception 'lab result: only a draft can be edited';
  end if;
  return new;
end;
$$;

revoke all on function public.lab_results_validate() from public, anon, authenticated;

create trigger lab_results_validate
  before insert or update or delete on public.lab_results
  for each row execute function public.lab_results_validate();

-- The order item follows its first result version: collected → processing on
-- entry, → resulted on submission, back to processing when returned, →
-- verified on verification. Corrections leave a verified item verified.
create or replace function public.lab_results_sync_item()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_item public.lab_order_items;
  v_target public.lab_item_status;
  v_actor uuid;
begin
  if new.supersedes_result_id is not null then
    return null;
  end if;
  select * into v_item from public.lab_order_items where id = new.order_item_id;

  if tg_op = 'INSERT' then
    v_target := case when v_item.status = 'collected' then 'processing'::public.lab_item_status end;
    v_actor := new.entered_by;
  elsif new.status = 'submitted' and old.status = 'draft' then
    v_target := 'resulted';
    v_actor := new.submitted_by;
  elsif new.status = 'draft' and old.status = 'submitted' then
    v_target := 'processing';
    v_actor := auth.uid();
  elsif new.status = 'verified' and old.status = 'submitted' then
    v_target := 'verified';
    v_actor := new.verified_by;
  end if;

  if v_target is not null and v_target is distinct from v_item.status then
    update public.lab_order_items
    set status = v_target, status_changed_by = v_actor
    where id = new.order_item_id;
  end if;
  return null;
end;
$$;

revoke all on function public.lab_results_sync_item() from public, anon, authenticated;

create trigger lab_results_sync_item
  after insert or update of status on public.lab_results
  for each row execute function public.lab_results_sync_item();

-- An item is resulted / verified only when its result says so.
create or replace function public.lab_order_items_result_consistency()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.status = 'resulted' and not exists (
    select 1 from public.lab_results r
    where r.order_item_id = new.id and r.status = 'submitted' and r.supersedes_result_id is null
  ) then
    raise exception 'lab order item: resulted requires a submitted result';
  end if;
  if new.status = 'verified' and not exists (
    select 1 from public.lab_results r where r.order_item_id = new.id and r.status = 'verified'
  ) then
    raise exception 'lab order item: verified requires a verified result';
  end if;
  return new;
end;
$$;

revoke all on function public.lab_order_items_result_consistency() from public, anon, authenticated;

create trigger lab_order_items_result_consistency
  before update of status on public.lab_order_items
  for each row when (new.status is distinct from old.status and new.status in ('resulted', 'verified'))
  execute function public.lab_order_items_result_consistency();

-- ---------------------------------------------------------------------------
-- lab_result_values: drafts only; unit, range and flag from configuration
-- ---------------------------------------------------------------------------

create or replace function public.lab_result_values_validate()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_result public.lab_results;
  v_param public.lab_test_parameters;
  v_test_id uuid;
  v_sex public.patient_sex;
  v_dob date;
  v_age integer;
  v_range public.lab_reference_ranges;
  v_actual text;
begin
  if tg_op = 'DELETE' then
    select * into v_result from public.lab_results r where r.id = old.result_id;
    -- Gone (a discarded draft cascading), still a draft, or the clinic is
    -- being erased.
    if v_result.id is null or v_result.status = 'draft' or public.lab_clinic_is_being_erased(old.clinic_id) then
      return old;
    end if;
    raise exception 'lab result value: values of a % result cannot be removed', v_result.status;
  end if;

  select * into v_result from public.lab_results r
  where r.id = new.result_id and r.clinic_id = new.clinic_id;
  if v_result.status is distinct from 'draft' then
    raise exception 'lab result value: only a draft result accepts values';
  end if;
  if tg_op = 'UPDATE' and (new.result_id <> old.result_id or new.parameter_id <> old.parameter_id or new.clinic_id <> old.clinic_id) then
    raise exception 'lab result value: result and parameter cannot change';
  end if;

  select * into v_param from public.lab_test_parameters p
  where p.id = new.parameter_id and p.clinic_id = new.clinic_id;
  select i.test_id into v_test_id from public.lab_order_items i where i.id = v_result.order_item_id;
  if v_param.test_id is distinct from v_test_id then
    raise exception 'lab result value: the parameter does not belong to the ordered test';
  end if;
  if not v_param.active and v_result.source = 'manual' then
    raise exception 'lab result value: parameter % is inactive', v_param.code;
  end if;

  -- The value must match the parameter's type.
  if (v_param.value_type = 'numeric' and new.value_numeric is null)
     or (v_param.value_type = 'boolean' and new.value_boolean is null)
     or (v_param.value_type in ('text', 'choice') and new.value_text is null) then
    raise exception 'lab result value: % expects a % value', v_param.code, v_param.value_type;
  end if;
  if v_param.value_type = 'choice' and not (new.value_text = any (v_param.choices)) then
    raise exception 'lab result value: % is not one of the configured choices of %', new.value_text, v_param.code;
  end if;

  -- Configuration, not the caller, sets everything below.
  new.unit_snapshot := v_param.unit;
  new.reference_range_id := null;
  new.range_low := null;
  new.range_high := null;
  new.range_text := null;
  new.critical_low := null;
  new.critical_high := null;
  new.flag := 'not_evaluated';
  if tg_op = 'INSERT' then
    new.created_at := now();
  else
    new.created_at := old.created_at;
  end if;
  new.updated_at := now();

  select p.sex, p.date_of_birth into v_sex, v_dob
  from public.patients p
  where p.id = v_result.patient_id;
  if v_dob is not null then
    v_age := (coalesce(v_result.performed_at, now()) at time zone 'UTC')::date - v_dob;
  end if;

  -- The most specific active range for this patient: a sex-specific range
  -- before an any-sex one, an age band before an open one, the narrowest
  -- band first. Unknown sex only matches any-sex ranges; unknown age only
  -- matches ranges without an age band.
  select * into v_range
  from public.lab_reference_ranges r
  where r.parameter_id = new.parameter_id
    and r.active
    and (r.sex is null or r.sex = v_sex)
    and (
      (r.age_min_days is null and r.age_max_days is null)
      or (v_age is not null
          and v_age >= coalesce(r.age_min_days, 0)
          and v_age <= coalesce(r.age_max_days, 2147483647))
    )
  order by (r.sex is not null) desc,
           num_nonnulls(r.age_min_days, r.age_max_days) desc,
           coalesce(r.age_max_days, 2147483647)::bigint - coalesce(r.age_min_days, 0) asc
  limit 1;

  if v_range.id is not null then
    new.reference_range_id := v_range.id;
    new.range_low := v_range.low;
    new.range_high := v_range.high;
    new.range_text := v_range.normal_text;
    new.critical_low := v_range.critical_low;
    new.critical_high := v_range.critical_high;

    if v_param.value_type = 'numeric' then
      new.flag := case
        when v_range.critical_low is not null and new.value_numeric < v_range.critical_low then 'critical_low'
        when v_range.critical_high is not null and new.value_numeric > v_range.critical_high then 'critical_high'
        when v_range.low is not null and new.value_numeric < v_range.low then 'low'
        when v_range.high is not null and new.value_numeric > v_range.high then 'high'
        when v_range.low is null and v_range.high is null then 'not_evaluated'
        else 'normal'
      end::public.lab_value_flag;
    elsif v_range.normal_text is not null then
      v_actual := case when v_param.value_type = 'boolean' then new.value_boolean::text else new.value_text end;
      new.flag := case
        when lower(btrim(v_actual)) = lower(btrim(v_range.normal_text)) then 'normal'
        else 'abnormal'
      end::public.lab_value_flag;
    end if;
  end if;
  return new;
end;
$$;

revoke all on function public.lab_result_values_validate() from public, anon, authenticated;

create trigger lab_result_values_validate
  before insert or update or delete on public.lab_result_values
  for each row execute function public.lab_result_values_validate();

-- ---------------------------------------------------------------------------
-- lab_documents: provenance; withdrawn, never deleted
-- ---------------------------------------------------------------------------

create or replace function public.lab_documents_validate()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    if public.lab_clinic_is_being_erased(old.clinic_id) then
      return old;
    end if;
    raise exception 'lab document: documents are withdrawn, never deleted';
  end if;

  if tg_op = 'INSERT' then
    new.created_at := now();
    if new.withdrawn_at is not null then
      raise exception 'lab document: a new document cannot be withdrawn';
    end if;
    if not public.lab_is_clinic_member(new.clinic_id, new.uploaded_by) then
      raise exception 'lab document: uploaded_by must be a staff member of the clinic';
    end if;
    if new.result_id is not null and not exists (
      select 1
      from public.lab_results r
      join public.lab_order_items i on i.id = r.order_item_id
      where r.id = new.result_id and i.order_id = new.order_id
    ) then
      raise exception 'lab document: the result belongs to another order';
    end if;
    return new;
  end if;

  perform public.lab_assert_only_changed(
    to_jsonb(old), to_jsonb(new), array['withdrawn_at', 'withdrawn_by', 'withdraw_reason'], 'lab document');
  if old.withdrawn_at is not null then
    raise exception 'lab document: already withdrawn';
  end if;
  if new.withdrawn_by is null or not public.lab_is_clinic_member(new.clinic_id, new.withdrawn_by) then
    raise exception 'lab document: withdrawn_by must be a staff member of the clinic';
  end if;
  new.withdrawn_at := now();
  return new;
end;
$$;

revoke all on function public.lab_documents_validate() from public, anon, authenticated;

create trigger lab_documents_validate
  before insert or update or delete on public.lab_documents
  for each row execute function public.lab_documents_validate();

-- ---------------------------------------------------------------------------
-- Audit: ids and states only — never values, comments or file names
-- ---------------------------------------------------------------------------

create or replace function public.lab_results_audit()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_action text;
  v_actor uuid;
  v_row public.lab_results;
begin
  if tg_op = 'DELETE' then
    v_row := old;
    v_action := 'lab_result_draft_discarded';
    v_actor := auth.uid();
  else
    v_row := new;
    if tg_op = 'INSERT' then
      v_action := case when new.supersedes_result_id is null then 'lab_result_entered' else 'lab_result_correction_started' end;
      v_actor := new.entered_by;
    elsif new.status = old.status then
      return null;
    elsif new.status = 'submitted' then
      v_action := 'lab_result_submitted';
      v_actor := new.submitted_by;
    elsif new.status = 'draft' then
      v_action := 'lab_result_returned';
      v_actor := auth.uid();
    elsif new.status = 'verified' then
      v_action := case when new.supersedes_result_id is null then 'lab_result_verified' else 'lab_result_corrected' end;
      v_actor := new.verified_by;
    else
      v_action := 'lab_result_superseded';
      v_actor := auth.uid();
    end if;
  end if;

  if public.lab_clinic_is_being_erased(v_row.clinic_id) then
    return null;
  end if;

  insert into public.audit_events (clinic_id, actor_id, actor_type, action, entity_type, entity_id, patient_id, new_values)
  values (
    v_row.clinic_id,
    v_actor,
    case when v_actor is null then 'system'::public.actor_type else 'staff'::public.actor_type end,
    v_action,
    'lab_results',
    v_row.id::text,
    v_row.patient_id,
    jsonb_build_object('order_item_id', v_row.order_item_id, 'version', v_row.version, 'status', v_row.status,
                       'source', v_row.source, 'supersedes_result_id', v_row.supersedes_result_id)
  );
  return null;
end;
$$;

revoke all on function public.lab_results_audit() from public, anon, authenticated;

create trigger lab_results_audit
  after insert or update or delete on public.lab_results
  for each row execute function public.lab_results_audit();

create or replace function public.lab_documents_audit()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.audit_events (clinic_id, actor_id, actor_type, action, entity_type, entity_id, patient_id, new_values)
  values (
    new.clinic_id,
    case when tg_op = 'INSERT' then new.uploaded_by else new.withdrawn_by end,
    'staff'::public.actor_type,
    case when tg_op = 'INSERT' then 'lab_document_uploaded' else 'lab_document_withdrawn' end,
    'lab_documents',
    new.id::text,
    new.patient_id,
    jsonb_build_object('order_id', new.order_id, 'result_id', new.result_id, 'kind', new.kind)
  );
  return null;
end;
$$;

revoke all on function public.lab_documents_audit() from public, anon, authenticated;

create trigger lab_documents_audit
  after insert or update on public.lab_documents
  for each row execute function public.lab_documents_audit();

-- ---------------------------------------------------------------------------
-- Access: server only
-- ---------------------------------------------------------------------------

alter table public.lab_results enable row level security;
alter table public.lab_result_values enable row level security;
alter table public.lab_documents enable row level security;

-- No policies: RLS denies every signed-in role even if a privilege is
-- granted by mistake. Reads go through the server, which authorizes by role
-- and purpose and audits each read.

revoke all on table public.lab_results from public, anon, authenticated, service_role;
revoke all on table public.lab_result_values from public, anon, authenticated, service_role;
revoke all on table public.lab_documents from public, anon, authenticated, service_role;
grant select, insert, update, delete on table public.lab_results to service_role;
grant select, insert, update, delete on table public.lab_result_values to service_role;
grant select, insert, update on table public.lab_documents to service_role;

-- ---------------------------------------------------------------------------
-- Storage: private bucket, server only
-- ---------------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('lab-documents', 'lab-documents', false, 20971520,
        array['application/pdf', 'image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do nothing;

drop policy if exists "lab-documents service role access" on storage.objects;
create policy "lab-documents service role access"
  on storage.objects
  for all
  to service_role
  using (bucket_id = 'lab-documents')
  with check (bucket_id = 'lab-documents');

-- No policy for anon or authenticated: lab files are delivered only through
-- short-lived signed URLs the server issues after authorization (Phase 11).

-- =====================================================================
-- FILE: 20261005000005_lab_staff_role.sql
-- =====================================================================
-- Laboratory (Phase 3, 1 of 2): the lab staff role.
--
-- docs/labs/PHASE_1_DOMAIN_MODEL.md §2.2. Kept in a migration of its own: a
-- value added with ALTER TYPE … ADD VALUE cannot be used in the transaction
-- that added it, and 20261005000006 uses it.
--
--   lab — laboratory staff ("Laboratoriya xodimi"): sees the lab work queue
--         and the lab data needed to perform tests and enter results; never
--         patient lists, appointments, conversations, payments, analytics or
--         doctors' clinical text. Every existing policy on those tables names
--         its roles explicitly, so the new value gains nothing there.
--
-- Reversible only by recreating the type (Postgres cannot drop enum values).

alter type public.staff_role add value if not exists 'lab' after 'receptionist';

-- New enum values must be committed before any later statement uses them.
commit;

-- =====================================================================
-- FILE: 20261005000006_lab_role_access.sql
-- =====================================================================
-- Laboratory (Phase 3, 2 of 2): the lab role in the database access model.
--
-- Lab work tables stay server-only (no table privileges for signed-in roles,
-- 20261005000003); these policies are the backstop that matches the
-- AGENTS.md access model if a privilege is ever granted:
--   * lab staff see their clinic's orders, items, samples and sample links —
--     the lab work queue;
--   * result tables keep RLS without policies (20261005000004): nobody signed
--     in reads them directly, lab staff included — the server authorizes and
--     audits every result read.
-- The catalog is already readable by every staff member of the clinic.

create policy "lab orders read for lab staff" on public.lab_orders
  for select to authenticated
  using (public.is_clinic_staff(clinic_id, array['lab']::public.staff_role[]));

create policy "lab order items read for lab staff" on public.lab_order_items
  for select to authenticated
  using (public.is_clinic_staff(clinic_id, array['lab']::public.staff_role[]));

create policy "lab samples read for lab staff" on public.lab_samples
  for select to authenticated
  using (public.is_clinic_staff(clinic_id, array['lab']::public.staff_role[]));

create policy "lab sample items read for lab staff" on public.lab_sample_items
  for select to authenticated
  using (public.is_clinic_staff(clinic_id, array['lab']::public.staff_role[]));

-- =====================================================================
-- FILE: 20261005000007_lab_order_creation.sql
-- =====================================================================
-- Laboratory (Phase 5): creating a lab order, atomically, in the database.
--
-- create_lab_order() is the only way the application creates an order with
-- its items. In one transaction it:
--   * replays an earlier order placed with the same creation key (same
--     orderer, same patient, same tests and panels) instead of creating a
--     second one; the same key with a different content is refused;
--   * inserts the order and one item per test — the item trigger takes code,
--     name and list price from the catalog and refuses inactive tests;
--   * splits each panel's price across its tests in proportion to their
--     standalone prices (owner decision O2). The split is in whole so'm when
--     the panel price is whole (else in 0.01), and the rounding remainder goes
--     to the test with the largest list price (ties: the panel's sort order),
--     so the items always add up to exactly the panel price. If every member
--     test is free, the panel price is split equally the same way. The
--     allocated amounts are stored on the items and never recalculated;
--   * makes the items ready for collection unless the clinic's lab payment
--     policy is "before_collection" (O6: payment is not required by default).
-- A test may appear once per order: selecting a test that a chosen panel
-- already contains is refused rather than silently charged twice.
--
-- SECURITY INVOKER: it runs as the calling server (service_role), so every
-- table trigger and constraint still applies; signed-in roles cannot call it.

create or replace function public.create_lab_order(
  p_clinic_id uuid,
  p_patient_id uuid,
  p_ordered_by uuid,
  p_source public.lab_order_source,
  p_test_ids uuid[],
  p_panel_ids uuid[],
  p_creation_key uuid default null,
  p_ordering_doctor_id uuid default null,
  p_appointment_id uuid default null
)
returns table (lab_order_id uuid, replayed boolean)
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_tests uuid[] := coalesce(p_test_ids, '{}');
  v_panels uuid[] := coalesce(p_panel_ids, '{}');
  v_order uuid;
  v_existing public.lab_orders;
  v_panel public.lab_panels;
  v_unit numeric;
  v_units bigint;
  v_total numeric;
  v_count integer;
  v_assigned bigint;
  v_share bigint;
  v_test uuid;
  v_policy text;
  r record;
begin
  if cardinality(v_tests) + cardinality(v_panels) = 0 then
    raise exception 'lab_order_empty: choose at least one test or panel';
  end if;
  if cardinality(v_tests) + cardinality(v_panels) > 50 then
    raise exception 'lab_order_too_large: at most 50 tests and panels per order';
  end if;
  if (select count(distinct t) from unnest(v_tests) t) <> cardinality(v_tests)
     or (select count(distinct p) from unnest(v_panels) p) <> cardinality(v_panels) then
    raise exception 'lab_order_duplicate_test: a test or panel is chosen twice';
  end if;

  -- Idempotent replay.
  if p_creation_key is not null then
    select * into v_existing
    from public.lab_orders o
    where o.clinic_id = p_clinic_id and o.ordered_by = p_ordered_by and o.creation_key = p_creation_key;
    if found then
      if v_existing.patient_id <> p_patient_id
         or (select coalesce(array_agg(i.test_id order by i.test_id), '{}') from public.lab_order_items i where i.order_id = v_existing.id and i.panel_id is null)
            <> (select coalesce(array_agg(t order by t), '{}') from unnest(v_tests) t)
         or (select coalesce(array_agg(distinct i.panel_id order by i.panel_id), '{}') from public.lab_order_items i where i.order_id = v_existing.id and i.panel_id is not null)
            <> (select coalesce(array_agg(p order by p), '{}') from unnest(v_panels) p) then
        raise exception 'lab_order_key_reused: this request key was already used for a different order';
      end if;
      return query select v_existing.id, true;
      return;
    end if;
  end if;

  begin
    insert into public.lab_orders (clinic_id, patient_id, source, ordered_by, ordering_doctor_id, appointment_id, creation_key)
    values (p_clinic_id, p_patient_id, p_source, p_ordered_by, p_ordering_doctor_id, p_appointment_id, p_creation_key)
    returning id into v_order;
  exception when unique_violation then
    -- A concurrent request with the same key won the race: replay it.
    select o.id into v_order
    from public.lab_orders o
    where o.clinic_id = p_clinic_id and o.ordered_by = p_ordered_by and o.creation_key = p_creation_key;
    if v_order is null then
      raise;
    end if;
    return query select v_order, true;
    return;
  end;

  -- Single tests: the item trigger prices them from the catalog.
  foreach v_test in array v_tests loop
    insert into public.lab_order_items (clinic_id, order_id, patient_id, test_id, test_code_snapshot, test_name_snapshot, list_price_snapshot, price_snapshot)
    values (p_clinic_id, v_order, p_patient_id, v_test, '', '', 0, 0);
  end loop;

  -- Panels: proportional allocation of the panel price (O2).
  foreach v_test in array v_panels loop
    select * into v_panel from public.lab_panels p where p.id = v_test and p.clinic_id = p_clinic_id;
    if not found then
      raise exception 'lab_order_unknown_panel: the panel is not in this clinic';
    end if;
    if not v_panel.active then
      raise exception 'lab_order_inactive_panel: panel % is inactive and cannot be ordered', v_panel.code;
    end if;

    v_unit := case when v_panel.price = trunc(v_panel.price) then 1 else 0.01 end;
    v_units := (v_panel.price / v_unit)::bigint;

    select coalesce(sum(t.price), 0), count(*) into v_total, v_count
    from public.lab_panel_tests pt
    join public.lab_tests t on t.id = pt.test_id
    where pt.panel_id = v_panel.id;
    if v_count = 0 then
      raise exception 'lab_order_empty_panel: panel % has no tests', v_panel.code;
    end if;

    v_assigned := 0;
    for r in
      select pt.test_id,
             t.price,
             case when v_total = 0 then floor(v_units::numeric / v_count)
                  else floor(v_units * t.price / v_total) end::bigint as share,
             row_number() over (order by t.price desc, pt.sort_order, pt.test_id) as rank
      from public.lab_panel_tests pt
      join public.lab_tests t on t.id = pt.test_id
      where pt.panel_id = v_panel.id
      order by rank desc
    loop
      -- Every test but the first-ranked takes its floor share; the first
      -- (largest list price) takes what remains, so the sum is exact.
      v_share := case when r.rank = 1 then v_units - v_assigned else r.share end;
      v_assigned := v_assigned + v_share;
      begin
        insert into public.lab_order_items (clinic_id, order_id, patient_id, test_id, panel_id, test_code_snapshot, test_name_snapshot, list_price_snapshot, price_snapshot)
        values (p_clinic_id, v_order, p_patient_id, r.test_id, v_panel.id, '', '', 0, v_share * v_unit);
      exception when unique_violation then
        raise exception 'lab_order_duplicate_test: a test is ordered twice (on its own and in a panel, or in two panels)';
      end;
    end loop;
  end loop;

  -- O6: unless the clinic requires payment first, the items are ready for
  -- collection right away. Imports keep their own lifecycle.
  if p_source <> 'external_import' then
    select s.value ->> 'paymentPolicy' into v_policy
    from public.app_settings s
    where s.clinic_id = p_clinic_id and s.key = 'lab';
    if v_policy is distinct from 'before_collection' then
      update public.lab_order_items
      set status = 'ready_for_collection', status_changed_by = p_ordered_by
      where order_id = v_order;
    end if;
  end if;

  return query select v_order, false;
end;
$$;

revoke all on function public.create_lab_order(uuid, uuid, uuid, public.lab_order_source, uuid[], uuid[], uuid, uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.create_lab_order(uuid, uuid, uuid, public.lab_order_source, uuid[], uuid[], uuid, uuid, uuid)
  to service_role;

comment on function public.create_lab_order(uuid, uuid, uuid, public.lab_order_source, uuid[], uuid[], uuid, uuid, uuid) is
  'Creates a lab order and its items atomically: idempotent on the creation key, proportional panel price allocation (O2), ready for collection unless payment is required first (O6). Server only.';

-- =====================================================================
-- FILE: 20261005000008_lab_payments.sql
-- =====================================================================
-- Laboratory (Phase 6): lab orders in the existing payment engine.
--
-- No second payment system: public.payments gains a second possible subject.
-- A payment belongs to exactly one appointment OR one lab order; every
-- existing path keeps finding appointment payments by appointment_id, so the
-- booking engine, the Click webhook, the Mini App and analytics are
-- untouched. Status changes still go only through the server
-- (payments_block_direct_write, transitionPaymentStatus); order status and
-- payment status stay separate (lab_orders.status vs payments.status).
--
--   * create_lab_order() now also creates the order's bill: one 'manual'
--     payment, status 'unpaid', amount = the sum of the items' stored prices
--     (catalog price or allocated panel share — never a client value).
--   * payments_lab_amount_guard: a lab payment's amount must always equal its
--     order's non-cancelled item total while it is unpaid (or failed), and can
--     never change once pending, paid or refunded — so it cannot be forged
--     even by a server bug.
--   * Cancelling an item of an unpaid order lowers the bill to match.
--   * When a lab payment becomes paid, items still waiting for payment
--     ('ordered', clinic policy "before_collection") become ready for
--     collection. Under the default policy they already are (O6).
--   * Refunds use the existing transition paid → refunded (whole payment):
--     the existing Kassa has no partial refunds, and item prices are stored
--     per item for when it does.
-- Lab payments never cascade-delete: a lab order with a bill keeps it.

alter table public.payments
  alter column appointment_id drop not null,
  add column lab_order_id uuid;

alter table public.payments
  add constraint payments_one_subject_check
    check (num_nonnulls(appointment_id, lab_order_id) = 1),
  add constraint payments_lab_order_fkey
    foreign key (lab_order_id, clinic_id, patient_id) references public.lab_orders (id, clinic_id, patient_id);

create unique index payments_lab_order_key on public.payments (lab_order_id) where lab_order_id is not null;

comment on column public.payments.lab_order_id is
  'The lab order this payment bills (exactly one of appointment_id / lab_order_id). Amount = the order''s stored item prices.';

-- ---------- Amount guard ----------

create or replace function public.lab_order_bill_total(p_order_id uuid)
returns numeric
language sql
stable
set search_path = public, pg_temp
as $$
  select coalesce(sum(i.price_snapshot), 0)
  from public.lab_order_items i
  where i.order_id = p_order_id and i.status <> 'cancelled';
$$;

revoke all on function public.lab_order_bill_total(uuid) from public, anon, authenticated;

create or replace function public.payments_lab_amount_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.lab_order_id is null then
    if tg_op = 'UPDATE' and old.lab_order_id is not null then
      raise exception 'payment: the subject of a payment cannot change';
    end if;
    return new;
  end if;
  if tg_op = 'UPDATE' and (old.lab_order_id is distinct from new.lab_order_id or old.appointment_id is distinct from new.appointment_id) then
    raise exception 'payment: the subject of a payment cannot change';
  end if;
  if tg_op = 'UPDATE' and old.status not in ('unpaid', 'failed') then
    if new.amount is distinct from old.amount then
      raise exception 'payment: the amount of a % lab payment cannot change', old.status;
    end if;
    return new;
  end if;
  if new.amount is distinct from public.lab_order_bill_total(new.lab_order_id) then
    raise exception 'payment: a lab payment''s amount must equal its order''s item prices';
  end if;
  return new;
end;
$$;

revoke all on function public.payments_lab_amount_guard() from public, anon, authenticated;

create trigger payments_lab_amount_guard
  before insert or update on public.payments
  for each row execute function public.payments_lab_amount_guard();

-- ---------- Cancelled items leave an unpaid bill ----------

create or replace function public.lab_items_rebill()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.payments
  set amount = public.lab_order_bill_total(new.order_id), updated_at = now()
  where lab_order_id = new.order_id and status in ('unpaid', 'failed');
  return null;
end;
$$;

revoke all on function public.lab_items_rebill() from public, anon, authenticated;

create trigger lab_order_items_rebill
  after update of status on public.lab_order_items
  for each row when (new.status = 'cancelled' and old.status is distinct from new.status)
  execute function public.lab_items_rebill();

-- ---------- Paid releases items waiting for payment ----------

create or replace function public.payments_release_lab_items()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.lab_order_items
  set status = 'ready_for_collection', status_changed_by = new.paid_by
  where order_id = new.lab_order_id and status = 'ordered';
  return null;
end;
$$;

revoke all on function public.payments_release_lab_items() from public, anon, authenticated;

create trigger payments_release_lab_items
  after update of status on public.payments
  for each row when (new.lab_order_id is not null and new.status = 'paid' and old.status is distinct from new.status)
  execute function public.payments_release_lab_items();

-- ---------- create_lab_order() now bills the order ----------

create or replace function public.create_lab_order(
  p_clinic_id uuid,
  p_patient_id uuid,
  p_ordered_by uuid,
  p_source public.lab_order_source,
  p_test_ids uuid[],
  p_panel_ids uuid[],
  p_creation_key uuid default null,
  p_ordering_doctor_id uuid default null,
  p_appointment_id uuid default null
)
returns table (lab_order_id uuid, replayed boolean)
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_tests uuid[] := coalesce(p_test_ids, '{}');
  v_panels uuid[] := coalesce(p_panel_ids, '{}');
  v_order uuid;
  v_existing public.lab_orders;
  v_panel public.lab_panels;
  v_unit numeric;
  v_units bigint;
  v_total numeric;
  v_count integer;
  v_assigned bigint;
  v_share bigint;
  v_test uuid;
  v_policy text;
  r record;
begin
  if cardinality(v_tests) + cardinality(v_panels) = 0 then
    raise exception 'lab_order_empty: choose at least one test or panel';
  end if;
  if cardinality(v_tests) + cardinality(v_panels) > 50 then
    raise exception 'lab_order_too_large: at most 50 tests and panels per order';
  end if;
  if (select count(distinct t) from unnest(v_tests) t) <> cardinality(v_tests)
     or (select count(distinct p) from unnest(v_panels) p) <> cardinality(v_panels) then
    raise exception 'lab_order_duplicate_test: a test or panel is chosen twice';
  end if;

  -- Idempotent replay.
  if p_creation_key is not null then
    select * into v_existing
    from public.lab_orders o
    where o.clinic_id = p_clinic_id and o.ordered_by = p_ordered_by and o.creation_key = p_creation_key;
    if found then
      if v_existing.patient_id <> p_patient_id
         or (select coalesce(array_agg(i.test_id order by i.test_id), '{}') from public.lab_order_items i where i.order_id = v_existing.id and i.panel_id is null)
            <> (select coalesce(array_agg(t order by t), '{}') from unnest(v_tests) t)
         or (select coalesce(array_agg(distinct i.panel_id order by i.panel_id), '{}') from public.lab_order_items i where i.order_id = v_existing.id and i.panel_id is not null)
            <> (select coalesce(array_agg(p order by p), '{}') from unnest(v_panels) p) then
        raise exception 'lab_order_key_reused: this request key was already used for a different order';
      end if;
      return query select v_existing.id, true;
      return;
    end if;
  end if;

  begin
    insert into public.lab_orders (clinic_id, patient_id, source, ordered_by, ordering_doctor_id, appointment_id, creation_key)
    values (p_clinic_id, p_patient_id, p_source, p_ordered_by, p_ordering_doctor_id, p_appointment_id, p_creation_key)
    returning id into v_order;
  exception when unique_violation then
    -- A concurrent request with the same key won the race: replay it.
    select o.id into v_order
    from public.lab_orders o
    where o.clinic_id = p_clinic_id and o.ordered_by = p_ordered_by and o.creation_key = p_creation_key;
    if v_order is null then
      raise;
    end if;
    return query select v_order, true;
    return;
  end;

  -- Single tests: the item trigger prices them from the catalog.
  foreach v_test in array v_tests loop
    insert into public.lab_order_items (clinic_id, order_id, patient_id, test_id, test_code_snapshot, test_name_snapshot, list_price_snapshot, price_snapshot)
    values (p_clinic_id, v_order, p_patient_id, v_test, '', '', 0, 0);
  end loop;

  -- Panels: proportional allocation of the panel price (O2).
  foreach v_test in array v_panels loop
    select * into v_panel from public.lab_panels p where p.id = v_test and p.clinic_id = p_clinic_id;
    if not found then
      raise exception 'lab_order_unknown_panel: the panel is not in this clinic';
    end if;
    if not v_panel.active then
      raise exception 'lab_order_inactive_panel: panel % is inactive and cannot be ordered', v_panel.code;
    end if;

    v_unit := case when v_panel.price = trunc(v_panel.price) then 1 else 0.01 end;
    v_units := (v_panel.price / v_unit)::bigint;

    select coalesce(sum(t.price), 0), count(*) into v_total, v_count
    from public.lab_panel_tests pt
    join public.lab_tests t on t.id = pt.test_id
    where pt.panel_id = v_panel.id;
    if v_count = 0 then
      raise exception 'lab_order_empty_panel: panel % has no tests', v_panel.code;
    end if;

    v_assigned := 0;
    for r in
      select pt.test_id,
             t.price,
             case when v_total = 0 then floor(v_units::numeric / v_count)
                  else floor(v_units * t.price / v_total) end::bigint as share,
             row_number() over (order by t.price desc, pt.sort_order, pt.test_id) as rank
      from public.lab_panel_tests pt
      join public.lab_tests t on t.id = pt.test_id
      where pt.panel_id = v_panel.id
      order by rank desc
    loop
      -- Every test but the first-ranked takes its floor share; the first
      -- (largest list price) takes what remains, so the sum is exact.
      v_share := case when r.rank = 1 then v_units - v_assigned else r.share end;
      v_assigned := v_assigned + v_share;
      begin
        insert into public.lab_order_items (clinic_id, order_id, patient_id, test_id, panel_id, test_code_snapshot, test_name_snapshot, list_price_snapshot, price_snapshot)
        values (p_clinic_id, v_order, p_patient_id, r.test_id, v_panel.id, '', '', 0, v_share * v_unit);
      exception when unique_violation then
        raise exception 'lab_order_duplicate_test: a test is ordered twice (on its own and in a panel, or in two panels)';
      end;
    end loop;
  end loop;

  -- The bill: one manual payment for the order, the sum of the stored item
  -- prices (Phase 6). The amount guard on payments re-checks it.
  if p_source <> 'external_import' then
    insert into public.payments (clinic_id, patient_id, lab_order_id, amount, status, provider)
    select p_clinic_id, p_patient_id, v_order, coalesce(sum(i.price_snapshot), 0), 'unpaid', 'manual'
    from public.lab_order_items i
    where i.order_id = v_order;
  end if;

  -- O6: unless the clinic requires payment first, the items are ready for
  -- collection right away. Imports keep their own lifecycle.
  if p_source <> 'external_import' then
    select s.value ->> 'paymentPolicy' into v_policy
    from public.app_settings s
    where s.clinic_id = p_clinic_id and s.key = 'lab';
    if v_policy is distinct from 'before_collection' then
      update public.lab_order_items
      set status = 'ready_for_collection', status_changed_by = p_ordered_by
      where order_id = v_order;
    end if;
  end if;

  return query select v_order, false;
end;
$$;

revoke all on function public.create_lab_order(uuid, uuid, uuid, public.lab_order_source, uuid[], uuid[], uuid, uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.create_lab_order(uuid, uuid, uuid, public.lab_order_source, uuid[], uuid[], uuid, uuid, uuid)
  to service_role;

-- =====================================================================
-- FILE: 20261005000009_lab_sample_collection.sql
-- =====================================================================
-- Laboratory (Phase 7): sample collection and the lab work queue.
--
-- Three server-only functions move specimens through the existing tables
-- (lab_samples, lab_sample_items, lab_order_items) in one transaction each:
--
--   collect_lab_sample   one tube for one or more items of the same order and
--                        the same sample type. The items must be
--                        ready_for_collection (so a cancelled order, a
--                        cancelled item, or an item still waiting for payment
--                        under the "before collection" policy is refused).
--                        The items are locked first, so of two collectors
--                        racing for the same item exactly one succeeds; the
--                        other is told the item was already collected.
--                        Idempotent on (clinic, collector, creation key): a
--                        repeated submit returns the first sample.
--                        Items → collected. The sample code is generated by
--                        the database (unique in the clinic).
--   receive_lab_sample   the lab accepts the specimen: sample → received,
--                        its collected items → processing.
--   reject_lab_sample    the specimen is unusable: sample → rejected with a
--                        reason, its items return to ready_for_collection
--                        for a new sample. Refused once any item already has
--                        a result.
--
-- Clinic, patient and order come from the order row, never from the caller:
-- a sample can only ever join items of its own order, patient and clinic
-- (also pinned by composite foreign keys and lab_sample_items_validate).
--
-- SECURITY INVOKER: runs as the calling server (service_role) so every table
-- trigger and constraint still applies; signed-in roles cannot call these.

alter table public.lab_samples add column creation_key uuid;

create unique index lab_samples_creation_key_idx
  on public.lab_samples (clinic_id, collected_by, creation_key)
  where creation_key is not null;

-- The creation key is immutable like every other column outside
-- lab_samples_validate's mutable list (lab_assert_only_changed).

-- ---------------------------------------------------------------------------
-- collect_lab_sample
-- ---------------------------------------------------------------------------

create or replace function public.collect_lab_sample(
  p_clinic_id uuid,
  p_order_id uuid,
  p_item_ids uuid[],
  p_collected_by uuid,
  p_notes text default null,
  p_creation_key uuid default null
)
returns table (lab_sample_id uuid, sample_code text, replayed boolean)
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_items uuid[] := coalesce(p_item_ids, '{}');
  v_order public.lab_orders;
  v_existing public.lab_samples;
  v_sample uuid;
  v_code text;
  v_type text;
  v_types integer;
  v_found integer;
  v_tz text;
  v_attempt integer := 0;
  r record;
begin
  if cardinality(v_items) = 0 then
    raise exception 'lab_sample_empty: choose at least one test for the sample';
  end if;
  if cardinality(v_items) > 50 then
    raise exception 'lab_sample_too_large: at most 50 tests per sample';
  end if;
  if (select count(distinct i) from unnest(v_items) i) <> cardinality(v_items) then
    raise exception 'lab_sample_duplicate_item: a test is chosen twice';
  end if;

  -- Lock the items first (in a fixed order, so concurrent collectors cannot
  -- deadlock). Whoever waits here sees the winner's committed sample next.
  perform 1 from public.lab_order_items i
  where i.id = any (v_items) and i.clinic_id = p_clinic_id
  order by i.id
  for update;

  -- Idempotent replay of the same collector's same submit (after the lock,
  -- so a concurrent duplicate submit replays instead of failing).
  if p_creation_key is not null then
    select * into v_existing
    from public.lab_samples s
    where s.clinic_id = p_clinic_id and s.collected_by = p_collected_by and s.creation_key = p_creation_key;
    if found then
      if v_existing.order_id <> p_order_id
         or (select coalesce(array_agg(si.order_item_id order by si.order_item_id), '{}')
             from public.lab_sample_items si where si.sample_id = v_existing.id)
            <> (select array_agg(i order by i) from unnest(v_items) i) then
        raise exception 'lab_sample_key_reused: this request key was already used for a different sample';
      end if;
      return query select v_existing.id, v_existing.sample_code, true;
      return;
    end if;
  end if;

  select * into v_order from public.lab_orders o where o.id = p_order_id and o.clinic_id = p_clinic_id;
  if not found then
    raise exception 'lab_sample_unknown_order: the order is not in this clinic';
  end if;
  if v_order.status <> 'active' then
    raise exception 'lab_sample_order_not_active: the order is %', v_order.status;
  end if;

  -- Re-read the locked items' state.
  v_found := 0;
  for r in
    select i.id, i.status, i.order_id, t.sample_type
    from public.lab_order_items i
    join public.lab_tests t on t.id = i.test_id and t.clinic_id = i.clinic_id
    where i.id = any (v_items) and i.clinic_id = p_clinic_id
    order by i.id
  loop
    v_found := v_found + 1;
    if r.order_id <> p_order_id then
      raise exception 'lab_sample_foreign_item: a test belongs to another order';
    end if;
    if r.status = 'cancelled' then
      raise exception 'lab_sample_item_cancelled: a chosen test was cancelled';
    end if;
    if r.status = 'ordered' then
      raise exception 'lab_sample_item_not_ready: a chosen test is not ready for collection (awaiting payment)';
    end if;
    if r.status <> 'ready_for_collection' then
      raise exception 'lab_sample_item_already_collected: a chosen test already has a sample';
    end if;
  end loop;
  if v_found <> cardinality(v_items) then
    raise exception 'lab_sample_foreign_item: a test is not in this clinic';
  end if;

  select count(distinct lower(btrim(t.sample_type))), min(t.sample_type) into v_types, v_type
  from public.lab_order_items i
  join public.lab_tests t on t.id = i.test_id and t.clinic_id = i.clinic_id
  where i.id = any (v_items);
  if v_types <> 1 then
    raise exception 'lab_sample_mixed_types: tests needing different sample types cannot share one sample';
  end if;

  select c.timezone into v_tz from public.clinics c where c.id = p_clinic_id;

  loop
    v_attempt := v_attempt + 1;
    v_code := to_char(now() at time zone coalesce(v_tz, 'UTC'), 'YYMMDD') || '-'
              || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 6));
    begin
      insert into public.lab_samples (clinic_id, patient_id, order_id, sample_code, sample_type, collected_by, notes, creation_key)
      values (p_clinic_id, v_order.patient_id, v_order.id, v_code, v_type, p_collected_by,
              nullif(btrim(coalesce(p_notes, '')), ''), p_creation_key)
      returning id into v_sample;
      exit;
    exception when unique_violation then
      if p_creation_key is not null then
        select * into v_existing
        from public.lab_samples s
        where s.clinic_id = p_clinic_id and s.collected_by = p_collected_by and s.creation_key = p_creation_key;
        if found then
          -- A concurrent request with the same key won the race.
          return query select v_existing.id, v_existing.sample_code, true;
          return;
        end if;
      end if;
      if v_attempt >= 5 then
        raise;
      end if;
    end;
  end loop;

  insert into public.lab_sample_items (sample_id, order_item_id, clinic_id)
  select v_sample, i, p_clinic_id from unnest(v_items) i;

  update public.lab_order_items
  set status = 'collected', status_changed_by = p_collected_by
  where id = any (v_items) and clinic_id = p_clinic_id;

  return query select v_sample, v_code, false;
end;
$$;

-- ---------------------------------------------------------------------------
-- receive_lab_sample / reject_lab_sample
-- ---------------------------------------------------------------------------

create or replace function public.receive_lab_sample(p_clinic_id uuid, p_sample_id uuid, p_received_by uuid)
returns boolean
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_sample public.lab_samples;
begin
  select * into v_sample from public.lab_samples s
  where s.id = p_sample_id and s.clinic_id = p_clinic_id
  for update;
  if not found then
    raise exception 'lab_sample_not_found: the sample is not in this clinic';
  end if;
  if v_sample.status = 'received' then
    return false; -- already received: nothing to do
  end if;
  if v_sample.status <> 'collected' then
    raise exception 'lab_sample_not_collected: the sample is %', v_sample.status;
  end if;

  update public.lab_samples set status = 'received', received_by = p_received_by
  where id = v_sample.id;

  update public.lab_order_items i
  set status = 'processing', status_changed_by = p_received_by
  from public.lab_sample_items si
  where si.sample_id = v_sample.id and si.order_item_id = i.id and i.clinic_id = p_clinic_id
    and i.status = 'collected';
  return true;
end;
$$;

create or replace function public.reject_lab_sample(p_clinic_id uuid, p_sample_id uuid, p_rejected_by uuid, p_reason text)
returns boolean
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_sample public.lab_samples;
begin
  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'lab_sample_reason_required: a rejection needs a reason';
  end if;

  select * into v_sample from public.lab_samples s
  where s.id = p_sample_id and s.clinic_id = p_clinic_id
  for update;
  if not found then
    raise exception 'lab_sample_not_found: the sample is not in this clinic';
  end if;
  if v_sample.status = 'rejected' then
    return false;
  end if;

  -- Lock the sample's items; refuse once any has a result.
  perform 1 from public.lab_order_items i
  join public.lab_sample_items si on si.order_item_id = i.id
  where si.sample_id = v_sample.id
  order by i.id
  for update of i;
  if exists (
    select 1 from public.lab_order_items i
    join public.lab_sample_items si on si.order_item_id = i.id
    where si.sample_id = v_sample.id and i.status not in ('collected', 'processing')
  ) or exists (
    select 1 from public.lab_results r
    join public.lab_sample_items si on si.order_item_id = r.order_item_id
    where si.sample_id = v_sample.id and r.status <> 'superseded'
  ) then
    raise exception 'lab_sample_has_results: a test of this sample already has a result';
  end if;

  update public.lab_samples
  set status = 'rejected', rejected_by = p_rejected_by, reject_reason = btrim(p_reason)
  where id = v_sample.id;

  update public.lab_order_items i
  set status = 'ready_for_collection', status_changed_by = p_rejected_by
  from public.lab_sample_items si
  where si.sample_id = v_sample.id and si.order_item_id = i.id and i.clinic_id = p_clinic_id;
  return true;
end;
$$;

revoke all on function public.collect_lab_sample(uuid, uuid, uuid[], uuid, text, uuid) from public, anon, authenticated;
revoke all on function public.receive_lab_sample(uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function public.reject_lab_sample(uuid, uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.collect_lab_sample(uuid, uuid, uuid[], uuid, text, uuid) to service_role;
grant execute on function public.receive_lab_sample(uuid, uuid, uuid) to service_role;
grant execute on function public.reject_lab_sample(uuid, uuid, uuid, text) to service_role;

-- =====================================================================
-- FILE: 20261005000010_lab_result_entry.sql
-- =====================================================================
-- Laboratory (Phase 8): structured result entry.
--
-- Lab staff enter one draft result per order item, parameter by parameter,
-- and submit it for second-person verification (Phase 9). Three server-only
-- functions do each step in one transaction:
--
--   save_lab_result_draft   creates the item's first draft if there is none
--                           (the sample must have been received: item
--                           status processing) and sets or clears values,
--                           the lab comment and the performed time. Only the
--                           person who started a draft changes it: a value
--                           silently added by someone else would let that
--                           person verify a result they partly entered (O4).
--   submit_lab_result       the person who entered the draft submits it,
--                           once every active parameter has a value; the
--                           item becomes resulted. A submitted result is not
--                           edited — it is verified or returned (Phase 9).
--   discard_lab_result_draft  any lab staff member may discard a draft (for
--                           example one left by a colleague); audited.
--
-- Values are validated by type in lab_result_values_validate (numeric /
-- text / boolean / choice, configured choices, now also the configured
-- number of decimal places). The unit, the reference range used and the flag
-- are still set by the database from the clinic's configuration: the flag
-- only places a value against the configured range, never interprets it.
--
-- lab_applicable_range() is the single choice of reference range, used both
-- when a value is stored and when the entry screen shows the range before a
-- value is typed, so the two can never disagree.
--
-- Corrections of verified results are Phase 9 and are refused here.

-- ---------------------------------------------------------------------------
-- The acting staff member for audit rows written by triggers. The server
-- runs as service_role (auth.uid() is null), so the entry functions name the
-- actor for the transaction.
-- ---------------------------------------------------------------------------

create or replace function public.lab_current_actor()
returns uuid
language sql
stable
set search_path = public, pg_temp
as $$
  select coalesce(nullif(current_setting('app.lab_actor', true), '')::uuid, auth.uid());
$$;

revoke all on function public.lab_current_actor() from public, anon, authenticated;
grant execute on function public.lab_current_actor() to service_role;

create or replace function public.lab_results_audit()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_action text;
  v_actor uuid;
  v_row public.lab_results;
begin
  if tg_op = 'DELETE' then
    v_row := old;
    v_action := 'lab_result_draft_discarded';
    v_actor := public.lab_current_actor();
  else
    v_row := new;
    if tg_op = 'INSERT' then
      v_action := case when new.supersedes_result_id is null then 'lab_result_entered' else 'lab_result_correction_started' end;
      v_actor := new.entered_by;
    elsif new.status = old.status then
      return null;
    elsif new.status = 'submitted' then
      v_action := 'lab_result_submitted';
      v_actor := new.submitted_by;
    elsif new.status = 'draft' then
      v_action := 'lab_result_returned';
      v_actor := public.lab_current_actor();
    elsif new.status = 'verified' then
      v_action := case when new.supersedes_result_id is null then 'lab_result_verified' else 'lab_result_corrected' end;
      v_actor := new.verified_by;
    else
      v_action := 'lab_result_superseded';
      v_actor := public.lab_current_actor();
    end if;
  end if;

  if public.lab_clinic_is_being_erased(v_row.clinic_id) then
    return null;
  end if;

  insert into public.audit_events (clinic_id, actor_id, actor_type, action, entity_type, entity_id, patient_id, new_values)
  values (
    v_row.clinic_id,
    v_actor,
    case when v_actor is null then 'system'::public.actor_type else 'staff'::public.actor_type end,
    v_action,
    'lab_results',
    v_row.id::text,
    v_row.patient_id,
    jsonb_build_object('order_item_id', v_row.order_item_id, 'version', v_row.version, 'status', v_row.status,
                       'source', v_row.source, 'supersedes_result_id', v_row.supersedes_result_id)
  );
  return null;
end;
$$;

-- ---------------------------------------------------------------------------
-- Reference range choice
-- ---------------------------------------------------------------------------

-- The most specific active range for a patient: a sex-specific range before
-- an any-sex one, an age band before an open one, the narrowest band first.
-- Unknown sex only matches any-sex ranges; unknown age only matches ranges
-- without an age band.
create or replace function public.lab_applicable_range(
  p_parameter_id uuid,
  p_sex public.patient_sex,
  p_age_days integer
)
returns setof public.lab_reference_ranges
language sql
stable
set search_path = public, pg_temp
as $$
  select r.*
  from public.lab_reference_ranges r
  where r.parameter_id = p_parameter_id
    and r.active
    and (r.sex is null or r.sex = p_sex)
    and (
      (r.age_min_days is null and r.age_max_days is null)
      or (p_age_days is not null
          and p_age_days >= coalesce(r.age_min_days, 0)
          and p_age_days <= coalesce(r.age_max_days, 2147483647))
    )
  order by (r.sex is not null) desc,
           num_nonnulls(r.age_min_days, r.age_max_days) desc,
           coalesce(r.age_max_days, 2147483647)::bigint - coalesce(r.age_min_days, 0) asc
  limit 1;
$$;

revoke all on function public.lab_applicable_range(uuid, public.patient_sex, integer) from public, anon, authenticated;

create or replace function public.lab_result_values_validate()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_result public.lab_results;
  v_param public.lab_test_parameters;
  v_test_id uuid;
  v_sex public.patient_sex;
  v_dob date;
  v_age integer;
  v_range public.lab_reference_ranges;
  v_actual text;
begin
  if tg_op = 'DELETE' then
    select * into v_result from public.lab_results r where r.id = old.result_id;
    -- Gone (a discarded draft cascading), still a draft, or the clinic is
    -- being erased.
    if v_result.id is null or v_result.status = 'draft' or public.lab_clinic_is_being_erased(old.clinic_id) then
      return old;
    end if;
    raise exception 'lab result value: values of a % result cannot be removed', v_result.status;
  end if;

  select * into v_result from public.lab_results r
  where r.id = new.result_id and r.clinic_id = new.clinic_id;
  if v_result.status is distinct from 'draft' then
    raise exception 'lab result value: only a draft result accepts values';
  end if;
  if tg_op = 'UPDATE' and (new.result_id <> old.result_id or new.parameter_id <> old.parameter_id or new.clinic_id <> old.clinic_id) then
    raise exception 'lab result value: result and parameter cannot change';
  end if;

  select * into v_param from public.lab_test_parameters p
  where p.id = new.parameter_id and p.clinic_id = new.clinic_id;
  select i.test_id into v_test_id from public.lab_order_items i where i.id = v_result.order_item_id;
  if v_param.test_id is distinct from v_test_id then
    raise exception 'lab result value: the parameter does not belong to the ordered test';
  end if;
  if not v_param.active and v_result.source = 'manual' then
    raise exception 'lab result value: parameter % is inactive', v_param.code;
  end if;

  -- The value must match the parameter's type.
  if (v_param.value_type = 'numeric' and new.value_numeric is null)
     or (v_param.value_type = 'boolean' and new.value_boolean is null)
     or (v_param.value_type in ('text', 'choice') and new.value_text is null) then
    raise exception 'lab result value: % expects a % value', v_param.code, v_param.value_type;
  end if;
  if v_param.value_type = 'choice' and not (new.value_text = any (v_param.choices)) then
    raise exception 'lab result value: % is not one of the configured choices of %', new.value_text, v_param.code;
  end if;

  if v_param.value_type = 'numeric' and v_param.decimals is not null
     and new.value_numeric <> round(new.value_numeric, v_param.decimals) then
    raise exception 'lab result value: % takes at most % decimal places', v_param.code, v_param.decimals;
  end if;

  -- Configuration, not the caller, sets everything below.
  new.unit_snapshot := v_param.unit;
  new.reference_range_id := null;
  new.range_low := null;
  new.range_high := null;
  new.range_text := null;
  new.critical_low := null;
  new.critical_high := null;
  new.flag := 'not_evaluated';
  if tg_op = 'INSERT' then
    new.created_at := now();
  else
    new.created_at := old.created_at;
  end if;
  new.updated_at := now();

  select p.sex, p.date_of_birth into v_sex, v_dob
  from public.patients p
  where p.id = v_result.patient_id;
  if v_dob is not null then
    v_age := (coalesce(v_result.performed_at, now()) at time zone 'UTC')::date - v_dob;
  end if;

  -- The most specific active range for this patient (lab_applicable_range).
  select * into v_range from public.lab_applicable_range(new.parameter_id, v_sex, v_age);

  if v_range.id is not null then
    new.reference_range_id := v_range.id;
    new.range_low := v_range.low;
    new.range_high := v_range.high;
    new.range_text := v_range.normal_text;
    new.critical_low := v_range.critical_low;
    new.critical_high := v_range.critical_high;

    if v_param.value_type = 'numeric' then
      new.flag := case
        when v_range.critical_low is not null and new.value_numeric < v_range.critical_low then 'critical_low'
        when v_range.critical_high is not null and new.value_numeric > v_range.critical_high then 'critical_high'
        when v_range.low is not null and new.value_numeric < v_range.low then 'low'
        when v_range.high is not null and new.value_numeric > v_range.high then 'high'
        when v_range.low is null and v_range.high is null then 'not_evaluated'
        else 'normal'
      end::public.lab_value_flag;
    elsif v_range.normal_text is not null then
      v_actual := case when v_param.value_type = 'boolean' then new.value_boolean::text else new.value_text end;
      new.flag := case
        when lower(btrim(v_actual)) = lower(btrim(v_range.normal_text)) then 'normal'
        else 'abnormal'
      end::public.lab_value_flag;
    end if;
  end if;
  return new;
end;
$$;


-- The range each parameter of an item's test would use for its patient now.
create or replace function public.lab_entry_ranges(p_clinic_id uuid, p_order_item_id uuid)
returns table (
  parameter_id uuid,
  range_low numeric,
  range_high numeric,
  range_text text,
  critical_low numeric,
  critical_high numeric
)
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select p.id, r.low, r.high, r.normal_text, r.critical_low, r.critical_high
  from public.lab_order_items i
  join public.patients pt on pt.id = i.patient_id and pt.clinic_id = i.clinic_id
  join public.lab_test_parameters p on p.test_id = i.test_id and p.clinic_id = i.clinic_id
  left join lateral public.lab_applicable_range(
    p.id, pt.sex,
    case when pt.date_of_birth is not null then (now() at time zone 'UTC')::date - pt.date_of_birth end
  ) r on true
  where i.id = p_order_item_id and i.clinic_id = p_clinic_id;
$$;

-- ---------------------------------------------------------------------------
-- save_lab_result_draft
-- ---------------------------------------------------------------------------

-- p_values: [{"parameter_id": uuid, "value_numeric"|"value_text"|"value_boolean": …}]
-- or {"parameter_id": uuid, "clear": true} to remove a value from the draft.
create or replace function public.save_lab_result_draft(
  p_clinic_id uuid,
  p_order_item_id uuid,
  p_entered_by uuid,
  p_values jsonb,
  p_lab_comment text default null,
  p_performed_at timestamptz default null
)
returns table (lab_result_id uuid, created boolean)
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_item public.lab_order_items;
  v_source public.lab_order_source;
  v_result public.lab_results;
  v_created boolean := false;
  v_entry jsonb;
  v_param uuid;
begin
  if p_values is null or jsonb_typeof(p_values) <> 'array' then
    raise exception 'lab_result_bad_values: values must be a list';
  end if;
  if jsonb_array_length(p_values) > 200 then
    raise exception 'lab_result_bad_values: too many values';
  end if;
  if (select count(distinct e->>'parameter_id') from jsonb_array_elements(p_values) e) <> jsonb_array_length(p_values) then
    raise exception 'lab_result_bad_values: a parameter is given twice';
  end if;

  perform set_config('app.lab_actor', p_entered_by::text, true);

  -- One writer per item at a time.
  select * into v_item from public.lab_order_items i
  where i.id = p_order_item_id and i.clinic_id = p_clinic_id
  for update;
  if not found then
    raise exception 'lab_result_unknown_item: the test is not in this clinic';
  end if;
  select o.source into v_source from public.lab_orders o where o.id = v_item.order_id;
  if v_source = 'external_import' then
    raise exception 'lab_result_imported: results of imported orders are recorded by the import';
  end if;

  select * into v_result from public.lab_results r
  where r.order_item_id = v_item.id and r.supersedes_result_id is null and r.status <> 'superseded'
  for update;

  if found then
    if v_result.status = 'submitted' then
      raise exception 'lab_result_submitted: the result was submitted for verification';
    elsif v_result.status = 'verified' then
      raise exception 'lab_result_verified: the result is verified; a change is a correction';
    elsif v_result.entered_by <> p_entered_by then
      raise exception 'lab_result_draft_owned: another staff member is entering this result';
    end if;
  else
    if v_item.status <> 'processing' then
      raise exception 'lab_result_item_not_ready: results are entered once the lab has received the sample (the test is %)', v_item.status;
    end if;
    insert into public.lab_results (clinic_id, patient_id, order_item_id, entered_by, source)
    values (p_clinic_id, v_item.patient_id, v_item.id, p_entered_by, 'manual')
    returning * into v_result;
    v_created := true;
  end if;

  if v_result.lab_comment is distinct from nullif(btrim(coalesce(p_lab_comment, '')), '')
     or v_result.performed_at is distinct from p_performed_at then
    update public.lab_results
    set lab_comment = nullif(btrim(coalesce(p_lab_comment, '')), ''), performed_at = p_performed_at
    where id = v_result.id;
  end if;

  for v_entry in select * from jsonb_array_elements(p_values) loop
    begin
      v_param := (v_entry->>'parameter_id')::uuid;
    exception when others then
      raise exception 'lab_result_bad_values: unknown parameter';
    end;
    if v_param is null then
      raise exception 'lab_result_bad_values: unknown parameter';
    end if;
    if not exists (
      select 1 from public.lab_test_parameters p
      where p.id = v_param and p.clinic_id = p_clinic_id and p.test_id = v_item.test_id
    ) then
      raise exception 'lab_result_bad_values: a parameter does not belong to this test';
    end if;

    if coalesce((v_entry->>'clear')::boolean, false) then
      delete from public.lab_result_values v where v.result_id = v_result.id and v.parameter_id = v_param;
    else
      insert into public.lab_result_values (clinic_id, result_id, parameter_id, value_numeric, value_text, value_boolean)
      values (
        p_clinic_id, v_result.id, v_param,
        (v_entry->>'value_numeric')::numeric,
        nullif(btrim(v_entry->>'value_text'), ''),
        (v_entry->>'value_boolean')::boolean
      )
      on conflict (result_id, parameter_id) do update
      set value_numeric = excluded.value_numeric,
          value_text = excluded.value_text,
          value_boolean = excluded.value_boolean;
    end if;
  end loop;

  return query select v_result.id, v_created;
end;
$$;

-- ---------------------------------------------------------------------------
-- submit_lab_result / discard_lab_result_draft
-- ---------------------------------------------------------------------------

create or replace function public.submit_lab_result(p_clinic_id uuid, p_result_id uuid, p_submitted_by uuid)
returns boolean
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_result public.lab_results;
  v_test uuid;
  v_missing integer;
begin
  perform set_config('app.lab_actor', p_submitted_by::text, true);

  select * into v_result from public.lab_results r
  where r.id = p_result_id and r.clinic_id = p_clinic_id
  for update;
  if not found then
    raise exception 'lab_result_not_found: the result is not in this clinic';
  end if;
  if v_result.status = 'submitted' and v_result.submitted_by = p_submitted_by then
    return false; -- already submitted by this person: nothing to do
  end if;
  if v_result.status <> 'draft' then
    raise exception 'lab_result_submitted: the result is %', v_result.status;
  end if;
  if v_result.entered_by <> p_submitted_by then
    raise exception 'lab_result_draft_owned: only the person who entered the result submits it';
  end if;

  select i.test_id into v_test from public.lab_order_items i where i.id = v_result.order_item_id;
  select count(*) into v_missing
  from public.lab_test_parameters p
  where p.test_id = v_test and p.clinic_id = p_clinic_id and p.active
    and not exists (select 1 from public.lab_result_values v where v.result_id = v_result.id and v.parameter_id = p.id);
  if v_missing > 0 then
    raise exception 'lab_result_incomplete: % parameter(s) have no value', v_missing;
  end if;

  update public.lab_results set status = 'submitted', submitted_by = p_submitted_by where id = v_result.id;
  return true;
end;
$$;

create or replace function public.discard_lab_result_draft(p_clinic_id uuid, p_result_id uuid, p_by uuid)
returns boolean
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_result public.lab_results;
begin
  if not public.lab_is_clinic_member(p_clinic_id, p_by) then
    raise exception 'lab_result_not_found: the result is not in this clinic';
  end if;
  perform set_config('app.lab_actor', p_by::text, true);

  select * into v_result from public.lab_results r
  where r.id = p_result_id and r.clinic_id = p_clinic_id
  for update;
  if not found then
    raise exception 'lab_result_not_found: the result is not in this clinic (or was already discarded)';
  end if;
  if v_result.status <> 'draft' then
    raise exception 'lab_result_submitted: only a draft can be discarded (the result is %)', v_result.status;
  end if;
  delete from public.lab_results where id = v_result.id;
  return true;
end;
$$;

revoke all on function public.lab_entry_ranges(uuid, uuid) from public, anon, authenticated;
revoke all on function public.save_lab_result_draft(uuid, uuid, uuid, jsonb, text, timestamptz) from public, anon, authenticated;
revoke all on function public.submit_lab_result(uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function public.discard_lab_result_draft(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.lab_applicable_range(uuid, public.patient_sex, integer) to service_role;
grant execute on function public.lab_entry_ranges(uuid, uuid) to service_role;
grant execute on function public.save_lab_result_draft(uuid, uuid, uuid, jsonb, text, timestamptz) to service_role;
grant execute on function public.submit_lab_result(uuid, uuid, uuid) to service_role;
grant execute on function public.discard_lab_result_draft(uuid, uuid, uuid) to service_role;

-- =====================================================================
-- FILE: 20261005000011_lab_result_verification.sql
-- =====================================================================
-- Laboratory (Phase 9): verification, return for rework, corrections as
-- new versions.
--
-- Lifecycle of one version (lab_result_status, unchanged):
--   draft → submitted ("review") → verified → superseded
--            ↖ returned ↙
-- RESULT_READY in the prompt is a verified result that the clinic releases
-- to the patient (settings.releaseToPatient, Phase 12) — not another status.
--
--   verify_lab_result          a second person (never who entered or
--                              submitted it — O4, also a CHECK constraint)
--                              verifies a submitted version. The row is
--                              locked: of two verifiers, one wins; the other
--                              is told it is no longer awaiting review.
--                              Verifying a correction retires the version it
--                              corrects in the same statement (existing
--                              trigger). When every test of the order is
--                              verified or cancelled, the order completes.
--   return_lab_result          a reviewer (or the author) sends a submitted
--                              version back to its author as a draft.
--   start_lab_result_correction a verified result is never edited: a
--                              correction is version n+1 (supersedes the
--                              current verified version, reason required),
--                              starting from its values; it is entered,
--                              submitted and verified like any result. Until
--                              then the earlier version stays the verified
--                              one. Every version keeps its author, times,
--                              submitter and verifier.
--
-- save_lab_result_draft now edits the version in progress, first result or
-- correction alike. Trigger-written audit rows name the acting staff member
-- (lab_current_actor) for order, item, sample and result changes.

create or replace function public.lab_workflow_audit()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_action text;
  v_actor uuid;
  v_values jsonb;
begin
  if tg_table_name = 'lab_orders' then
    if tg_op = 'INSERT' then
      v_action := 'lab_order_created';
      v_actor := new.ordered_by;
    elsif new.status is distinct from old.status then
      v_action := 'lab_order_' || new.status::text;
      v_actor := coalesce(new.cancelled_by, public.lab_current_actor());
    else
      return null;
    end if;
    v_values := jsonb_build_object('status', new.status, 'source', new.source,
                                   'ordering_doctor_id', new.ordering_doctor_id, 'appointment_id', new.appointment_id);
  elsif tg_table_name = 'lab_order_items' then
    if tg_op = 'INSERT' then
      v_action := 'lab_order_item_created';
    elsif new.status is distinct from old.status then
      v_action := 'lab_order_item_status_changed';
    else
      return null;
    end if;
    v_actor := coalesce(new.status_changed_by, public.lab_current_actor());
    v_values := jsonb_build_object('order_id', new.order_id, 'test_id', new.test_id, 'status', new.status,
                                   'previous_status', case when tg_op = 'UPDATE' then old.status end);
  elsif tg_table_name = 'lab_samples' then
    if tg_op = 'INSERT' then
      v_action := 'lab_sample_collected';
      v_actor := new.collected_by;
    elsif new.status is distinct from old.status then
      v_action := 'lab_sample_' || new.status::text;
      v_actor := coalesce(new.rejected_by, new.received_by, public.lab_current_actor());
    else
      return null;
    end if;
    v_values := jsonb_build_object('order_id', new.order_id, 'status', new.status);
  else
    return null;
  end if;

  insert into public.audit_events (clinic_id, actor_id, actor_type, action, entity_type, entity_id, patient_id, new_values)
  values (
    new.clinic_id,
    v_actor,
    case when v_actor is null then 'system'::public.actor_type else 'staff'::public.actor_type end,
    v_action,
    tg_table_name,
    new.id::text,
    new.patient_id,
    v_values
  );
  return null;
end;
$$;

create or replace function public.lab_results_sync_item()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_item public.lab_order_items;
  v_target public.lab_item_status;
  v_actor uuid;
begin
  if new.supersedes_result_id is not null then
    return null;
  end if;
  select * into v_item from public.lab_order_items where id = new.order_item_id;

  if tg_op = 'INSERT' then
    v_target := case when v_item.status = 'collected' then 'processing'::public.lab_item_status end;
    v_actor := new.entered_by;
  elsif new.status = 'submitted' and old.status = 'draft' then
    v_target := 'resulted';
    v_actor := new.submitted_by;
  elsif new.status = 'draft' and old.status = 'submitted' then
    v_target := 'processing';
    v_actor := public.lab_current_actor();
  elsif new.status = 'verified' and old.status = 'submitted' then
    v_target := 'verified';
    v_actor := new.verified_by;
  end if;

  if v_target is not null and v_target is distinct from v_item.status then
    update public.lab_order_items
    set status = v_target, status_changed_by = v_actor
    where id = new.order_item_id;
  end if;
  return null;
end;
$$;

create or replace function public.save_lab_result_draft(
  p_clinic_id uuid,
  p_order_item_id uuid,
  p_entered_by uuid,
  p_values jsonb,
  p_lab_comment text default null,
  p_performed_at timestamptz default null
)
returns table (lab_result_id uuid, created boolean)
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_item public.lab_order_items;
  v_source public.lab_order_source;
  v_result public.lab_results;
  v_created boolean := false;
  v_entry jsonb;
  v_param uuid;
begin
  if p_values is null or jsonb_typeof(p_values) <> 'array' then
    raise exception 'lab_result_bad_values: values must be a list';
  end if;
  if jsonb_array_length(p_values) > 200 then
    raise exception 'lab_result_bad_values: too many values';
  end if;
  if (select count(distinct e->>'parameter_id') from jsonb_array_elements(p_values) e) <> jsonb_array_length(p_values) then
    raise exception 'lab_result_bad_values: a parameter is given twice';
  end if;

  perform set_config('app.lab_actor', p_entered_by::text, true);

  -- One writer per item at a time.
  select * into v_item from public.lab_order_items i
  where i.id = p_order_item_id and i.clinic_id = p_clinic_id
  for update;
  if not found then
    raise exception 'lab_result_unknown_item: the test is not in this clinic';
  end if;
  select o.source into v_source from public.lab_orders o where o.id = v_item.order_id;
  if v_source = 'external_import' then
    raise exception 'lab_result_imported: results of imported orders are recorded by the import';
  end if;

  -- The version in progress (a first result or a correction), if any.
  select * into v_result from public.lab_results r
  where r.order_item_id = v_item.id and r.status in ('draft', 'submitted')
  for update;

  if found then
    if v_result.status = 'submitted' then
      raise exception 'lab_result_submitted: the result was submitted for verification';
    elsif v_result.entered_by <> p_entered_by then
      raise exception 'lab_result_draft_owned: another staff member is entering this result';
    end if;
  elsif exists (select 1 from public.lab_results r where r.order_item_id = v_item.id and r.status = 'verified') then
    raise exception 'lab_result_verified: the result is verified; a change is a correction';
  else
    if v_item.status <> 'processing' then
      raise exception 'lab_result_item_not_ready: results are entered once the lab has received the sample (the test is %)', v_item.status;
    end if;
    insert into public.lab_results (clinic_id, patient_id, order_item_id, entered_by, source)
    values (p_clinic_id, v_item.patient_id, v_item.id, p_entered_by, 'manual')
    returning * into v_result;
    v_created := true;
  end if;

  if v_result.lab_comment is distinct from nullif(btrim(coalesce(p_lab_comment, '')), '')
     or v_result.performed_at is distinct from p_performed_at then
    update public.lab_results
    set lab_comment = nullif(btrim(coalesce(p_lab_comment, '')), ''), performed_at = p_performed_at
    where id = v_result.id;
  end if;

  for v_entry in select * from jsonb_array_elements(p_values) loop
    begin
      v_param := (v_entry->>'parameter_id')::uuid;
    exception when others then
      raise exception 'lab_result_bad_values: unknown parameter';
    end;
    if v_param is null then
      raise exception 'lab_result_bad_values: unknown parameter';
    end if;
    if not exists (
      select 1 from public.lab_test_parameters p
      where p.id = v_param and p.clinic_id = p_clinic_id and p.test_id = v_item.test_id
    ) then
      raise exception 'lab_result_bad_values: a parameter does not belong to this test';
    end if;

    if coalesce((v_entry->>'clear')::boolean, false) then
      delete from public.lab_result_values v where v.result_id = v_result.id and v.parameter_id = v_param;
    else
      insert into public.lab_result_values (clinic_id, result_id, parameter_id, value_numeric, value_text, value_boolean)
      values (
        p_clinic_id, v_result.id, v_param,
        (v_entry->>'value_numeric')::numeric,
        nullif(btrim(v_entry->>'value_text'), ''),
        (v_entry->>'value_boolean')::boolean
      )
      on conflict (result_id, parameter_id) do update
      set value_numeric = excluded.value_numeric,
          value_text = excluded.value_text,
          value_boolean = excluded.value_boolean;
    end if;
  end loop;

  return query select v_result.id, v_created;
end;
$$;

-- ---------------------------------------------------------------------------
-- verify / return
-- ---------------------------------------------------------------------------

create or replace function public.verify_lab_result(p_clinic_id uuid, p_result_id uuid, p_verified_by uuid)
returns boolean
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_result public.lab_results;
  v_order uuid;
begin
  perform set_config('app.lab_actor', p_verified_by::text, true);

  select * into v_result from public.lab_results r
  where r.id = p_result_id and r.clinic_id = p_clinic_id
  for update;
  if not found then
    raise exception 'lab_result_not_found: the result is not in this clinic';
  end if;
  if v_result.status = 'verified' and v_result.verified_by = p_verified_by then
    return false; -- already verified by this person: nothing to do
  end if;
  if v_result.status <> 'submitted' then
    raise exception 'lab_result_not_submitted: the result is % (not awaiting review)', v_result.status;
  end if;
  if p_verified_by = v_result.entered_by or p_verified_by = v_result.submitted_by then
    raise exception 'lab_result_second_person: a second person must verify the result';
  end if;

  update public.lab_results set status = 'verified', verified_by = p_verified_by where id = v_result.id;

  -- The order is complete once every test is verified or cancelled.
  select i.order_id into v_order from public.lab_order_items i where i.id = v_result.order_item_id;
  perform 1 from public.lab_orders o where o.id = v_order for update;
  if exists (select 1 from public.lab_orders o where o.id = v_order and o.status = 'active')
     and not exists (
       select 1 from public.lab_order_items i
       where i.order_id = v_order and i.status not in ('verified', 'cancelled')
     ) then
    update public.lab_orders set status = 'completed' where id = v_order;
  end if;
  return true;
end;
$$;

create or replace function public.return_lab_result(p_clinic_id uuid, p_result_id uuid, p_by uuid)
returns boolean
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_result public.lab_results;
begin
  if not public.lab_is_clinic_member(p_clinic_id, p_by) then
    raise exception 'lab_result_not_found: the result is not in this clinic';
  end if;
  perform set_config('app.lab_actor', p_by::text, true);

  select * into v_result from public.lab_results r
  where r.id = p_result_id and r.clinic_id = p_clinic_id
  for update;
  if not found then
    raise exception 'lab_result_not_found: the result is not in this clinic';
  end if;
  if v_result.status <> 'submitted' then
    raise exception 'lab_result_not_submitted: the result is % (not awaiting review)', v_result.status;
  end if;
  update public.lab_results set status = 'draft' where id = v_result.id;
  return true;
end;
$$;

-- ---------------------------------------------------------------------------
-- start_lab_result_correction
-- ---------------------------------------------------------------------------

create or replace function public.start_lab_result_correction(
  p_clinic_id uuid,
  p_result_id uuid,
  p_by uuid,
  p_reason text
)
returns table (lab_result_id uuid, created boolean)
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_target public.lab_results;
  v_existing public.lab_results;
  v_new uuid;
begin
  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'lab_result_reason_required: a correction needs a reason';
  end if;
  perform set_config('app.lab_actor', p_by::text, true);

  -- Lock the item first (the same order as entry), then the version.
  perform 1 from public.lab_order_items i
  join public.lab_results r on r.order_item_id = i.id
  where r.id = p_result_id and r.clinic_id = p_clinic_id
  for update of i;

  select * into v_target from public.lab_results r
  where r.id = p_result_id and r.clinic_id = p_clinic_id
  for update;
  if not found then
    raise exception 'lab_result_not_found: the result is not in this clinic';
  end if;

  select * into v_existing from public.lab_results r
  where r.order_item_id = v_target.order_item_id and r.status in ('draft', 'submitted');
  if found then
    if v_existing.supersedes_result_id = v_target.id and v_existing.entered_by = p_by and v_existing.status = 'draft' then
      return query select v_existing.id, false; -- the same person's correction in progress
      return;
    end if;
    raise exception 'lab_result_correction_exists: a correction of this result is already in progress';
  end if;
  if v_target.status <> 'verified' then
    raise exception 'lab_result_not_current: only the current verified result can be corrected (this one is %)', v_target.status;
  end if;

  insert into public.lab_results (
    clinic_id, patient_id, order_item_id, version, supersedes_result_id, source,
    entered_by, correction_reason, lab_comment, performed_at)
  values (
    p_clinic_id, v_target.patient_id, v_target.order_item_id, v_target.version + 1, v_target.id, 'manual',
    p_by, btrim(p_reason), v_target.lab_comment, v_target.performed_at)
  returning id into v_new;

  -- Start from the verified values (active parameters); unit, range and flag
  -- are set again by the value trigger from the current configuration.
  insert into public.lab_result_values (clinic_id, result_id, parameter_id, value_numeric, value_text, value_boolean)
  select v.clinic_id, v_new, v.parameter_id, v.value_numeric, v.value_text, v.value_boolean
  from public.lab_result_values v
  join public.lab_test_parameters p on p.id = v.parameter_id
  where v.result_id = v_target.id and p.active;

  return query select v_new, true;
end;
$$;

revoke all on function public.verify_lab_result(uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function public.return_lab_result(uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function public.start_lab_result_correction(uuid, uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.verify_lab_result(uuid, uuid, uuid) to service_role;
grant execute on function public.return_lab_result(uuid, uuid, uuid) to service_role;
grant execute on function public.start_lab_result_correction(uuid, uuid, uuid, text) to service_role;

-- =====================================================================
-- FILE: 20261005000012_lab_documents.sql
-- =====================================================================
-- Laboratory (Phase 11): result documents in the existing private storage.
--
-- Files live in the private bucket lab-documents (Phase 2, same pattern as
-- voice-messages): <clinic_id>/<document id>, no policy for anon or
-- authenticated — bytes are delivered only through short-lived signed URLs the
-- server issues after authorization. lab_documents keeps clinic, patient,
-- order, result, kind, type, size, SHA-256, uploader and time; documents are
-- withdrawn with a reason, never deleted, and their bytes are retained.
--
-- Two rules added here:
--   * a document is attached to a result only while that result is a draft
--     or awaiting review — a verified version's evidence is final, and a
--     corrected report goes with its correction (a new version);
--   * a draft with attached documents cannot be discarded.

create or replace function public.lab_documents_validate()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    if public.lab_clinic_is_being_erased(old.clinic_id) then
      return old;
    end if;
    raise exception 'lab document: documents are withdrawn, never deleted';
  end if;

  if tg_op = 'INSERT' then
    new.created_at := now();
    if new.withdrawn_at is not null then
      raise exception 'lab document: a new document cannot be withdrawn';
    end if;
    if not public.lab_is_clinic_member(new.clinic_id, new.uploaded_by) then
      raise exception 'lab document: uploaded_by must be a staff member of the clinic';
    end if;
    if new.result_id is not null and not exists (
      select 1
      from public.lab_results r
      join public.lab_order_items i on i.id = r.order_item_id
      where r.id = new.result_id and i.order_id = new.order_id
    ) then
      raise exception 'lab document: the result belongs to another order';
    end if;
    -- Evidence is attached while the result is being entered or reviewed. A
    -- verified (or superseded) version is final: a corrected report belongs
    -- to its correction.
    if new.result_id is not null and not exists (
      select 1 from public.lab_results r where r.id = new.result_id and r.status in ('draft', 'submitted')
    ) then
      raise exception 'lab_document_result_final: documents are attached to a result before it is verified';
    end if;
    return new;
  end if;

  perform public.lab_assert_only_changed(
    to_jsonb(old), to_jsonb(new), array['withdrawn_at', 'withdrawn_by', 'withdraw_reason'], 'lab document');
  if old.withdrawn_at is not null then
    raise exception 'lab document: already withdrawn';
  end if;
  if new.withdrawn_by is null or not public.lab_is_clinic_member(new.clinic_id, new.withdrawn_by) then
    raise exception 'lab document: withdrawn_by must be a staff member of the clinic';
  end if;
  new.withdrawn_at := now();
  return new;
end;
$$;

create or replace function public.discard_lab_result_draft(p_clinic_id uuid, p_result_id uuid, p_by uuid)
returns boolean
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_result public.lab_results;
begin
  if not public.lab_is_clinic_member(p_clinic_id, p_by) then
    raise exception 'lab_result_not_found: the result is not in this clinic';
  end if;
  perform set_config('app.lab_actor', p_by::text, true);

  select * into v_result from public.lab_results r
  where r.id = p_result_id and r.clinic_id = p_clinic_id
  for update;
  if not found then
    raise exception 'lab_result_not_found: the result is not in this clinic (or was already discarded)';
  end if;
  if v_result.status <> 'draft' then
    raise exception 'lab_result_submitted: only a draft can be discarded (the result is %)', v_result.status;
  end if;
  -- Attached documents are retained clinical records (withdrawn, never
  -- deleted), so a draft that has any cannot disappear under them.
  if exists (select 1 from public.lab_documents d where d.result_id = v_result.id) then
    raise exception 'lab_result_has_documents: a draft with attached documents cannot be discarded';
  end if;
  delete from public.lab_results where id = v_result.id;
  return true;
end;
$$;

-- =====================================================================
-- FILE: 20261005000013_lab_notification_type.sql
-- =====================================================================
-- Laboratory (Phase 12): a notification type for "your lab result is ready".
-- (An enum value is added in its own migration: it cannot be used in the
-- same transaction that adds it.)

alter type public.notification_job_type add value if not exists 'lab_result_ready';

-- New enum values must be committed before any later statement uses them.
commit;

-- =====================================================================
-- FILE: 20261005000014_lab_patient_results.sql
-- =====================================================================
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

-- =====================================================================
-- FILE: 20261005000015_lab_import.sql
-- =====================================================================
-- Laboratory (Phase 13): historical lab-result import engine.
--
-- A migration tool, not a patient workflow. External data (a CSV exported
-- from MedPlus, Excel or another laboratory system — no provider API is
-- assumed) goes through:
--
--   upload → schema detection → field mapping → validation → patient
--   matching → duplicate detection → preview (+ dry run) → confirmation by a
--   SECOND staff member → import (partial, retryable) → import report
--
--   lab_import_batches  one uploaded file: who prepared it, the mapping, the
--                       state, who confirmed it. The same file (sha256) can
--                       be in only one non-cancelled batch per clinic.
--   lab_import_rows     one data row of the file: its cells, the server's
--                       reading of them (patient, test, parameter, typed
--                       value, date), its status and error codes, and the
--                       result it became.
--
-- Both tables are server-only (service_role), like the result tables: the
-- cells hold patient identifiers and result values. Audit rows carry ids,
-- counts and codes only.
--
-- run_lab_import() imports "groups" — one patient, one test, one date (and
-- source accession): one result. Each group is its own subtransaction, so a
-- failure affects that group only (partial import); failed groups can be
-- retried. Each imported group becomes an external_import order (reference
-- import:<group key>, unique per clinic — the same data is never imported
-- twice), one item, and one result version with source = import:
-- entered and submitted by the preparer, verified by the confirming second
-- person (O4 holds: the CHECK constraint on lab_results still applies). A
-- group is never imported over an existing result of the same patient,
-- test and day: nothing existing is replaced or merged.
--
-- Dry run: the same function with p_dry_run = true performs every insert
-- up to submission and then rolls the group back, reporting whether it
-- would import.
--
-- Imported (historical) results never notify the patient: the
-- lab_result_ready trigger now skips source = import.

create type public.lab_import_status as enum ('uploaded', 'analysed', 'confirmed', 'completed', 'cancelled');

create type public.lab_import_row_status as enum (
  'pending',         -- uploaded, not analysed yet
  'ready',           -- valid, exact (or staff-confirmed) patient match, no duplicate
  'invalid',         -- validation errors (see errors)
  'unmatched',       -- no patient found
  'possible_match',  -- weak identifiers match one patient: a staff member must confirm
  'conflict',        -- identifiers contradict each other or point to several patients,
                     -- or an existing result differs
  'duplicate',       -- repeated in the file, or already in the clinic's records
  'imported',
  'failed',          -- the import of its group failed (retryable)
  'skipped'          -- left out when the batch was finished or cancelled
);

create table public.lab_import_batches (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete cascade,
  -- Free label of the origin system, e.g. "MedPlus", "Excel".
  source_system text not null,
  file_name text not null,
  file_sha256 text not null,
  status public.lab_import_status not null default 'uploaded',
  headers jsonb not null,
  mapping jsonb,
  row_count integer not null,
  summary jsonb not null default '{}'::jsonb,
  created_by uuid not null references public.profiles(id),
  analysed_by uuid references public.profiles(id),
  analysed_at timestamptz,
  confirmed_by uuid references public.profiles(id),
  confirmed_at timestamptz,
  completed_at timestamptz,
  cancelled_by uuid references public.profiles(id),
  cancelled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint lab_import_batches_id_clinic_id_key unique (id, clinic_id),
  constraint lab_import_batches_source_check
    check (source_system ~ '\S' and char_length(source_system) <= 80),
  constraint lab_import_batches_file_name_check
    check (file_name ~ '\S' and char_length(file_name) <= 200),
  constraint lab_import_batches_sha_check check (file_sha256 ~ '^[0-9a-f]{64}$'),
  constraint lab_import_batches_headers_check
    check (jsonb_typeof(headers) = 'array' and jsonb_array_length(headers) between 1 and 50),
  constraint lab_import_batches_rows_check check (row_count between 1 and 5000),
  constraint lab_import_batches_analysed_check
    check ((analysed_at is null) = (analysed_by is null)
           and (status in ('uploaded', 'cancelled') or analysed_at is not null)),
  -- A second person confirms (O4, as for results).
  constraint lab_import_batches_confirm_check
    check ((confirmed_at is null) = (confirmed_by is null)
           and (confirmed_by is null or confirmed_by <> created_by)
           and (status not in ('confirmed', 'completed') or confirmed_by is not null)),
  constraint lab_import_batches_cancel_check
    check ((status = 'cancelled') = (cancelled_at is not null)
           and (cancelled_at is null) = (cancelled_by is null)),
  constraint lab_import_batches_completed_check
    check ((status = 'completed') = (completed_at is not null))
);

-- One live batch per file: an imported or in-progress file cannot be uploaded again.
create unique index lab_import_batches_file_key
  on public.lab_import_batches (clinic_id, file_sha256) where status <> 'cancelled';
create index lab_import_batches_clinic_idx on public.lab_import_batches (clinic_id, created_at desc);

create table public.lab_import_rows (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete cascade,
  batch_id uuid not null,
  -- 1-based data row number in the file (the header is row 0).
  row_number integer not null,
  -- The row's cells, aligned with lab_import_batches.headers.
  raw jsonb not null,
  status public.lab_import_row_status not null default 'pending',
  errors text[] not null default '{}',
  -- The server's reading of the row (set by analysis).
  patient_key text,
  patient_id uuid,
  match_kind text,
  match_confirmed_by uuid references public.profiles(id),
  candidate_patient_ids uuid[] not null default '{}',
  test_id uuid,
  parameter_id uuid,
  value_numeric numeric,
  value_text text,
  value_boolean boolean,
  performed_at timestamptz,
  accession text,
  group_key text,
  lab_result_id uuid,
  attempts integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint lab_import_rows_batch_row_key unique (batch_id, row_number),
  constraint lab_import_rows_batch_fkey
    foreign key (batch_id, clinic_id) references public.lab_import_batches (id, clinic_id) on delete cascade,
  constraint lab_import_rows_patient_fkey
    foreign key (patient_id, clinic_id) references public.patients (id, clinic_id) on delete set null (patient_id),
  constraint lab_import_rows_test_fkey
    foreign key (test_id, clinic_id) references public.lab_tests (id, clinic_id),
  constraint lab_import_rows_parameter_fkey
    foreign key (parameter_id, clinic_id) references public.lab_test_parameters (id, clinic_id),
  constraint lab_import_rows_result_fkey
    foreign key (lab_result_id, clinic_id) references public.lab_results (id, clinic_id),
  constraint lab_import_rows_row_number_check check (row_number between 1 and 5000),
  constraint lab_import_rows_raw_check check (jsonb_typeof(raw) = 'array'),
  constraint lab_import_rows_match_kind_check
    check (match_kind is null or match_kind in ('patient_id', 'pinfl', 'document_number', 'staff_confirmed')),
  constraint lab_import_rows_accession_check
    check (accession is null or (accession ~ '\S' and char_length(accession) <= 80)),
  constraint lab_import_rows_group_key_check check (group_key is null or group_key ~ '^[0-9a-f]{64}$'),
  constraint lab_import_rows_text_check check (value_text is null or char_length(value_text) <= 500),
  -- What an importable row must carry.
  constraint lab_import_rows_ready_check
    check (status not in ('ready', 'failed', 'imported')
           or (patient_id is not null and test_id is not null and parameter_id is not null
               and performed_at is not null and group_key is not null
               and num_nonnulls(value_numeric, value_text, value_boolean) = 1)),
  constraint lab_import_rows_imported_check
    check ((status = 'imported') = (lab_result_id is not null)),
  constraint lab_import_rows_confirmed_match_check
    check ((match_kind = 'staff_confirmed') = (match_confirmed_by is not null))
);

create index lab_import_rows_status_idx on public.lab_import_rows (batch_id, status, row_number);
create index lab_import_rows_group_idx on public.lab_import_rows (batch_id, group_key) where group_key is not null;
create index lab_import_rows_patient_idx on public.lab_import_rows (patient_id) where patient_id is not null;

create or replace function public.lab_import_touch()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'INSERT' then
    new.created_at := now();
  else
    new.created_at := old.created_at;
    if new.clinic_id <> old.clinic_id then
      raise exception 'lab import: the clinic cannot change';
    end if;
  end if;
  new.updated_at := now();
  return new;
end;
$$;

revoke all on function public.lab_import_touch() from public, anon, authenticated;

create trigger lab_import_batches_touch
  before insert or update on public.lab_import_batches
  for each row execute function public.lab_import_touch();
create trigger lab_import_rows_touch
  before insert or update on public.lab_import_rows
  for each row execute function public.lab_import_touch();

-- A batch's file, preparer and cells never change after upload; a finished
-- batch never changes at all.
create or replace function public.lab_import_batches_guard()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.created_by <> old.created_by or new.file_sha256 <> old.file_sha256
     or new.headers <> old.headers or new.row_count <> old.row_count or new.file_name <> old.file_name then
    raise exception 'lab import: the uploaded file and its preparer cannot change';
  end if;
  if old.status in ('completed', 'cancelled') then
    raise exception 'lab import: a % batch cannot change', old.status;
  end if;
  if new.status is distinct from old.status and not (
    (old.status, new.status) in (('uploaded', 'analysed'), ('analysed', 'confirmed'), ('confirmed', 'completed'),
                                 ('uploaded', 'cancelled'), ('analysed', 'cancelled'), ('confirmed', 'cancelled'))
  ) then
    raise exception 'lab import: % → % is not allowed', old.status, new.status;
  end if;
  if old.status in ('confirmed') and new.mapping is distinct from old.mapping then
    raise exception 'lab import: the mapping of a confirmed batch cannot change';
  end if;
  return new;
end;
$$;

revoke all on function public.lab_import_batches_guard() from public, anon, authenticated;

create trigger lab_import_batches_guard
  before update on public.lab_import_batches
  for each row execute function public.lab_import_batches_guard();

create or replace function public.lab_import_rows_guard()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.batch_id <> old.batch_id or new.row_number <> old.row_number or new.raw <> old.raw then
    raise exception 'lab import row: the uploaded cells cannot change';
  end if;
  if old.status = 'imported' then
    raise exception 'lab import row: an imported row cannot change';
  end if;
  return new;
end;
$$;

revoke all on function public.lab_import_rows_guard() from public, anon, authenticated;

create trigger lab_import_rows_guard
  before update on public.lab_import_rows
  for each row execute function public.lab_import_rows_guard();

alter table public.lab_import_batches enable row level security;
alter table public.lab_import_rows enable row level security;
-- No policies: no signed-in or anonymous access. The server (service_role)
-- authorizes every request (lab staff holding import.manage) and audits it.
revoke all on table public.lab_import_batches from public, anon, authenticated, service_role;
revoke all on table public.lab_import_rows from public, anon, authenticated, service_role;
grant select, insert, update on table public.lab_import_batches to service_role;
grant select, insert, update on table public.lab_import_rows to service_role;

-- ---------------------------------------------------------------------------
-- store_lab_import_analysis: the server's analysis of every row and the
-- batch's new state, in one locked transaction (a confirmation can never
-- land between them). Only the preparer, only before confirmation.
-- ---------------------------------------------------------------------------

create or replace function public.store_lab_import_analysis(
  p_clinic_id uuid,
  p_batch_id uuid,
  p_actor uuid,
  p_mapping jsonb,
  p_summary jsonb,
  p_rows jsonb
)
returns void
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_batch public.lab_import_batches;
  v_count integer;
begin
  select * into v_batch from public.lab_import_batches b
  where b.id = p_batch_id and b.clinic_id = p_clinic_id
  for update;
  if not found then
    raise exception 'lab_import_not_found: the import is not in this clinic';
  end if;
  if v_batch.status not in ('uploaded', 'analysed') then
    raise exception 'lab_import_not_editable: the import is %', v_batch.status;
  end if;
  if v_batch.created_by <> p_actor then
    raise exception 'lab_import_not_preparer: only the preparer maps and analyses the file';
  end if;

  update public.lab_import_rows r
  set status = x.status,
      errors = coalesce(x.errors, '{}'),
      patient_key = x.patient_key,
      patient_id = x.patient_id,
      match_kind = x.match_kind,
      match_confirmed_by = x.match_confirmed_by,
      candidate_patient_ids = coalesce(x.candidate_patient_ids, '{}'),
      test_id = x.test_id,
      parameter_id = x.parameter_id,
      value_numeric = x.value_numeric,
      value_text = x.value_text,
      value_boolean = x.value_boolean,
      performed_at = x.performed_at,
      accession = x.accession,
      group_key = x.group_key
  from jsonb_to_recordset(p_rows) as x(
    row_number integer, status public.lab_import_row_status, errors text[], patient_key text, patient_id uuid,
    match_kind text, match_confirmed_by uuid, candidate_patient_ids uuid[], test_id uuid, parameter_id uuid,
    value_numeric numeric, value_text text, value_boolean boolean, performed_at timestamptz, accession text, group_key text)
  where r.batch_id = v_batch.id and r.row_number = x.row_number;
  get diagnostics v_count = row_count;
  if v_count <> v_batch.row_count then
    raise exception 'lab_import_rows_mismatch: % of % rows analysed', v_count, v_batch.row_count;
  end if;

  update public.lab_import_batches
  set status = 'analysed', mapping = p_mapping, summary = p_summary, analysed_by = p_actor, analysed_at = now()
  where id = v_batch.id;
end;
$$;

revoke all on function public.store_lab_import_analysis(uuid, uuid, uuid, jsonb, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.store_lab_import_analysis(uuid, uuid, uuid, jsonb, jsonb, jsonb) to service_role;

-- ---------------------------------------------------------------------------
-- run_lab_import
-- ---------------------------------------------------------------------------

create or replace function public.run_lab_import(
  p_clinic_id uuid,
  p_batch_id uuid,
  p_actor uuid,
  p_dry_run boolean,
  p_after_row integer default 0,
  p_max_groups integer default 100
)
returns table (group_key text, first_row integer, outcome text, error_code text, lab_result_id uuid)
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
#variable_conflict use_column
declare
  v_batch public.lab_import_batches;
  v_tz text;
  v_group record;
  v_first public.lab_import_rows;
  v_ref text;
  v_order uuid;
  v_item uuid;
  v_result uuid;
  v_outcome text;
  v_code text;
  v_day date;
  v_status public.lab_import_row_status;
begin
  perform set_config('app.lab_actor', p_actor::text, true);

  select * into v_batch from public.lab_import_batches b
  where b.id = p_batch_id and b.clinic_id = p_clinic_id
  for update;
  if not found then
    raise exception 'lab_import_not_found: the import is not in this clinic';
  end if;
  if not public.lab_is_clinic_member(p_clinic_id, p_actor) then
    raise exception 'lab_import_not_staff: the actor is not a staff member of the clinic';
  end if;
  if p_dry_run then
    if v_batch.status <> 'analysed' then
      raise exception 'lab_import_not_analysed: the import is %', v_batch.status;
    end if;
  else
    if v_batch.status <> 'confirmed' then
      raise exception 'lab_import_not_confirmed: the import is %', v_batch.status;
    end if;
    if p_actor = v_batch.created_by then
      raise exception 'lab_import_second_person: the preparer cannot run the import';
    end if;
  end if;

  select c.timezone into v_tz from public.clinics c where c.id = p_clinic_id;

  for v_group in
    select r.group_key as key, min(r.row_number) as first_row
    from public.lab_import_rows r
    where r.batch_id = v_batch.id and r.group_key is not null
    group by r.group_key
    -- A group is imported whole or not at all: every row must be ready.
    having bool_and(r.status = 'ready') and min(r.row_number) > coalesce(p_after_row, 0)
    order by min(r.row_number)
    limit greatest(1, least(coalesce(p_max_groups, 100), 500))
  loop
    v_outcome := null;
    v_code := null;
    v_result := null;
    select * into v_first from public.lab_import_rows r
    where r.batch_id = v_batch.id and r.group_key = v_group.key
    order by r.row_number
    limit 1;
    v_ref := 'import:' || v_group.key;

    begin
      if exists (
        select 1 from public.lab_orders o
        where o.clinic_id = p_clinic_id and o.source = 'external_import' and o.external_reference = v_ref
      ) then
        raise exception 'lab_import_duplicate: this group was already imported';
      end if;
      -- Never alongside an existing result of the same patient, test and day.
      v_day := (v_first.performed_at at time zone v_tz)::date;
      if exists (
        select 1
        from public.lab_results lr
        join public.lab_order_items i on i.id = lr.order_item_id
        where lr.clinic_id = p_clinic_id
          and lr.patient_id = v_first.patient_id
          and i.test_id = v_first.test_id
          and lr.status <> 'superseded'
          and (coalesce(lr.performed_at, lr.verified_at, lr.entered_at) at time zone v_tz)::date = v_day
      ) then
        raise exception 'lab_import_existing_result: the patient already has this test on this day';
      end if;

      insert into public.lab_orders (clinic_id, patient_id, source, ordered_by, external_reference)
      values (p_clinic_id, v_first.patient_id, 'external_import', v_batch.created_by, v_ref)
      returning id into v_order;

      insert into public.lab_order_items (clinic_id, order_id, patient_id, test_id, test_code_snapshot, test_name_snapshot, list_price_snapshot, price_snapshot)
      values (p_clinic_id, v_order, v_first.patient_id, v_first.test_id, '', '', 0, 0)
      returning id into v_item;

      insert into public.lab_results (clinic_id, order_item_id, patient_id, source, entered_by, performed_at)
      values (p_clinic_id, v_item, v_first.patient_id, 'import', v_batch.created_by, v_first.performed_at)
      returning id into v_result;

      insert into public.lab_result_values (clinic_id, result_id, parameter_id, value_numeric, value_text, value_boolean)
      select p_clinic_id, v_result, r.parameter_id, r.value_numeric, r.value_text, r.value_boolean
      from public.lab_import_rows r
      where r.batch_id = v_batch.id and r.group_key = v_group.key;

      update public.lab_results set status = 'submitted', submitted_by = v_batch.created_by where id = v_result;

      if p_dry_run then
        raise exception 'lab_import_dry_run_ok';
      end if;

      update public.lab_results set status = 'verified', verified_by = p_actor where id = v_result;
      update public.lab_orders set status = 'completed' where id = v_order;
      v_outcome := 'imported';
    exception when others then
      v_result := null;
      if sqlerrm = 'lab_import_dry_run_ok' then
        v_outcome := 'would_import';
      else
        -- Codes only: database messages can quote a value.
        v_code := case
          when sqlerrm like 'lab_import_duplicate%' or sqlstate = '23505' then 'already_imported'
          when sqlerrm like 'lab_import_existing_result%' then 'existing_result'
          when sqlerrm like '%expects a%' or sqlerrm like '%configured choices%' or sqlerrm like '%decimal places%'
               or sqlerrm like '%does not belong to the ordered test%' then 'value_rejected'
          when sqlerrm like '%cannot be in the future%' then 'invalid_date'
          when sqlerrm like '%must be a staff member%' then 'preparer_not_staff'
          when sqlerrm like '%unknown test%' or sqlstate = '23503' then 'reference_missing'
          else 'import_failed'
        end;
        v_outcome := case when v_code in ('already_imported', 'existing_result') then 'duplicate' else 'failed' end;
      end if;
    end;

    if not p_dry_run then
      v_status := case v_outcome when 'imported' then 'imported' when 'duplicate' then 'duplicate' else 'failed' end;
      update public.lab_import_rows r
      set status = v_status,
          errors = case when v_code is null then '{}'::text[] else array[v_code] end,
          lab_result_id = v_result,
          attempts = r.attempts + 1
      where r.batch_id = v_batch.id and r.group_key = v_group.key;
    end if;

    group_key := v_group.key;
    first_row := v_group.first_row;
    outcome := v_outcome;
    error_code := v_code;
    lab_result_id := v_result;
    return next;
  end loop;

  if not p_dry_run and not exists (
    select 1 from public.lab_import_rows r where r.batch_id = v_batch.id and r.status in ('ready', 'failed')
  ) then
    update public.lab_import_batches set status = 'completed', completed_at = now() where id = v_batch.id;
  end if;
end;
$$;

revoke all on function public.run_lab_import(uuid, uuid, uuid, boolean, integer, integer) from public, anon, authenticated;
grant execute on function public.run_lab_import(uuid, uuid, uuid, boolean, integer, integer) to service_role;

-- ---------------------------------------------------------------------------
-- Historical results never notify the patient.
-- ---------------------------------------------------------------------------

create or replace function public.lab_results_notify_patient()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_telegram bigint;
begin
  if new.source = 'import' then
    return null; -- historical data brought in by an import: not news to the patient
  end if;
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

-- =====================================================================
-- FILE: 20261005000016_patient_merge.sql
-- =====================================================================
-- Patient merge (Lab Phase 14): one person, two patient records of the same
-- clinic, made one longitudinal record — without destroying or rewriting
-- anything.
--
-- The patient is the root of the longitudinal record, and much of what hangs
-- off it is immutable by design (clinical records, lab results and values,
-- documents, the append-only audit trail) and keyed by composite foreign
-- keys that include patient_id. Re-pointing those rows would rewrite who a
-- historical fact was recorded about. So a merge is a LINK, not a move:
--
--   * patients.merged_into_patient_id: the duplicate record points at the
--     canonical one. No appointment, payment, conversation, referral,
--     clinical record, lab order / result / document or audit row changes.
--     Every one keeps its author, time and the patient it was recorded for.
--   * patient_record_group(): the canonical record plus the records merged
--     into it. Doctor access (doctor_patient_access) and the server's
--     longitudinal reads use the group, so the person's history reads as
--     one. Per-appointment coverage is unchanged: a doctor still sees only
--     their own visits, referral-linked ones and shared histories.
--   * The unique identity a patient is reached by moves to the canonical
--     record when only the duplicate has it (Telegram identity, PINFL,
--     passport/ID number), so the bot and future imports find the canonical
--     record. Facts the canonical record lacks (date of birth, sex, phone,
--     name, consent) are COPIED from the duplicate. Everything moved or
--     copied is recorded on the merge.
--   * A merged record takes no new appointments, lab orders, referrals,
--     clinical records or conversations (trigger): new work goes to the
--     canonical record.
--   * unmerge_patients() undoes the link and moves the identity back (when
--     it is still as the merge left it). Copied facts stay on the canonical
--     record (the duplicate still has its own). What was created on the
--     canonical record after the merge stays there; the report says so.
--
-- A merge is refused (never guessed) when the two records contradict each
-- other — date of birth, sex, PINFL, document, two different Telegram
-- identities — or when the duplicate has live work: upcoming or ongoing
-- appointments, open referrals, active lab orders or unfinished results,
-- open conversations, pending notifications, or import rows waiting to be
-- imported. Finish or cancel those first.
--
-- patient_merge_preview() is the complete pre-merge preview (counts per
-- entity on both records, identity plan, blockers, warnings — including the
-- doctors whose access will extend to the combined record) with a
-- fingerprint; merge_patients() recomputes it under row locks and refuses if
-- anything changed since the preview the staff member confirmed.
--
-- Clinic-scoped (composite keys), server-only (service_role), transactional,
-- audited (patient_merged / patient_unmerged on both records — ids and field
-- names only, never identity values).

-- ---------------------------------------------------------------------------
-- The link
-- ---------------------------------------------------------------------------

alter table public.patients
  add column merged_into_patient_id uuid,
  add column merged_at timestamptz;

alter table public.patients
  add constraint patients_merged_into_fkey
    foreign key (merged_into_patient_id, clinic_id) references public.patients (id, clinic_id),
  add constraint patients_merged_into_check
    check (merged_into_patient_id is distinct from id
           and (merged_into_patient_id is null) = (merged_at is null));

create index patients_merged_into_idx on public.patients (merged_into_patient_id) where merged_into_patient_id is not null;
create index patients_clinic_birth_idx on public.patients (clinic_id, date_of_birth) where date_of_birth is not null;

comment on column public.patients.merged_into_patient_id is
  'Set when this record was merged into another record of the same clinic (patient_merges). The record and everything recorded for it stay as they were; reads of the longitudinal record use patient_record_group().';

create table public.patient_merges (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete cascade,
  canonical_patient_id uuid not null,
  duplicate_patient_id uuid not null,
  reason text not null,
  merged_by uuid not null references public.profiles(id),
  merged_at timestamptz not null default now(),
  -- The preview the staff member confirmed (counts, plan, warnings).
  preview jsonb not null,
  -- Identity moved from the duplicate to the canonical record: {field: value}.
  moved jsonb not null default '{}'::jsonb,
  -- Facts copied onto the canonical record (the duplicate keeps its own): {field: value}.
  copied jsonb not null default '{}'::jsonb,
  unmerged_by uuid references public.profiles(id),
  unmerged_at timestamptz,
  unmerge_reason text,
  unmerge_report jsonb,

  constraint patient_merges_canonical_fkey
    foreign key (canonical_patient_id, clinic_id) references public.patients (id, clinic_id),
  constraint patient_merges_duplicate_fkey
    foreign key (duplicate_patient_id, clinic_id) references public.patients (id, clinic_id),
  constraint patient_merges_distinct_check check (canonical_patient_id <> duplicate_patient_id),
  constraint patient_merges_reason_check check (reason ~ '\S' and char_length(reason) between 3 and 500),
  constraint patient_merges_unmerge_check
    check ((unmerged_at is null) = (unmerged_by is null)
           and (unmerged_at is null) = (unmerge_reason is null)
           and (unmerge_reason is null or (unmerge_reason ~ '\S' and char_length(unmerge_reason) between 3 and 500)))
);

create unique index patient_merges_live_duplicate_key on public.patient_merges (duplicate_patient_id) where unmerged_at is null;
create index patient_merges_clinic_idx on public.patient_merges (clinic_id, merged_at desc);
create index patient_merges_canonical_idx on public.patient_merges (canonical_patient_id);

-- The merge log never changes, except to record its undoing once.
create or replace function public.patient_merges_guard()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    if public.lab_clinic_is_being_erased(old.clinic_id) then
      return old;
    end if;
    raise exception 'patient merge: the merge log cannot be deleted';
  end if;
  if old.unmerged_at is not null then
    raise exception 'patient merge: an undone merge cannot change';
  end if;
  if (to_jsonb(new) - array['unmerged_by', 'unmerged_at', 'unmerge_reason', 'unmerge_report'])
     <> (to_jsonb(old) - array['unmerged_by', 'unmerged_at', 'unmerge_reason', 'unmerge_report']) then
    raise exception 'patient merge: only its undoing is recorded';
  end if;
  return new;
end;
$$;

revoke all on function public.patient_merges_guard() from public, anon, authenticated;

create trigger patient_merges_guard
  before update or delete on public.patient_merges
  for each row execute function public.patient_merges_guard();

alter table public.patient_merges enable row level security;
revoke all on table public.patient_merges from public, anon, authenticated, service_role;
grant select, insert, update on table public.patient_merges to service_role;

-- ---------------------------------------------------------------------------
-- The record group
-- ---------------------------------------------------------------------------

create or replace function public.patient_canonical_id(p_patient_id uuid)
returns uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(p.merged_into_patient_id, p.id) from public.patients p where p.id = p_patient_id;
$$;

-- The canonical record of `p_patient_id` and every record merged into it.
-- Merges are one level deep (a merged record cannot be canonical), so this
-- is exact. Empty for an unknown id.
create or replace function public.patient_record_group(p_patient_id uuid)
returns uuid[]
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(array(
    select x.id
    from public.patients x
    where x.id = c.canonical or x.merged_into_patient_id = c.canonical
    order by (x.id = c.canonical) desc, x.created_at
  ), '{}')
  from (select public.patient_canonical_id(p_patient_id) as canonical) c;
$$;

revoke all on function public.patient_canonical_id(uuid) from public, anon, authenticated;
revoke all on function public.patient_record_group(uuid) from public, anon, authenticated;
grant execute on function public.patient_canonical_id(uuid) to service_role;
grant execute on function public.patient_record_group(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- Doctor access over the group (same rules, the person's records as one)
-- ---------------------------------------------------------------------------

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
set search_path = public, pg_temp
as $$
  select
    d.clinic_id,
    -- Own relationship: a live appointment, or a record the doctor wrote.
    exists (
      select 1
      from public.appointments a
      where a.clinic_id = d.clinic_id
        and a.patient_id = any (g.ids)
        and a.doctor_id = d.id
        and a.status <> 'cancelled'
    )
    or exists (
      select 1
      from public.clinical_records cr
      where cr.clinic_id = d.clinic_id
        and cr.patient_id = any (g.ids)
        and cr.author_doctor_id = d.id
    ),
    array(
      select r.id
      from public.referrals r
      where r.clinic_id = d.clinic_id
        and r.patient_id = any (g.ids)
        and r.referred_to_doctor_id = d.id
        and r.status in ('pending', 'accepted', 'in_progress')
        and r.expires_at > now()
      order by r.created_at
    ),
    array(
      select distinct r.referring_doctor_id
      from public.referrals r
      where r.clinic_id = d.clinic_id
        and r.patient_id = any (g.ids)
        and r.referred_to_doctor_id = d.id
        and r.status in ('accepted', 'in_progress')
        and r.expires_at > now()
    ),
    array(
      -- The consultation an open referral to this doctor was raised from…
      select r.originating_appointment_id
      from public.referrals r
      where r.clinic_id = d.clinic_id
        and r.patient_id = any (g.ids)
        and r.referred_to_doctor_id = d.id
        and r.status in ('pending', 'accepted', 'in_progress')
        and r.expires_at > now()
      union
      -- …and the follow-up of a referral this doctor made, while it stands.
      select r.follow_up_appointment_id
      from public.referrals r
      where r.clinic_id = d.clinic_id
        and r.patient_id = any (g.ids)
        and r.referring_doctor_id = d.id
        and r.follow_up_appointment_id is not null
        and r.status in ('accepted', 'in_progress', 'completed')
        and r.expires_at > now()
    )
  from public.doctors d
  join public.patients p
    on p.id = p_patient_id
   and p.clinic_id = d.clinic_id
  cross join lateral (select public.patient_record_group(p.id) as ids) g
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
  'What an active doctor may see of a patient (see 20260929000001; over the merged record group since 20261005000016): own relationship (live appointment or authored record); open, unexpired referrals to them; referring doctors whose visits accepted/in-progress referrals share; referral-linked appointments. No row = no access. Server-only.';

-- ---------------------------------------------------------------------------
-- A merged record takes no new work
-- ---------------------------------------------------------------------------

create or replace function public.refuse_merged_patient()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if exists (select 1 from public.patients p where p.id = new.patient_id and p.merged_into_patient_id is not null) then
    raise exception 'patient_merged: this patient record was merged into another; use that record';
  end if;
  return new;
end;
$$;

revoke all on function public.refuse_merged_patient() from public, anon, authenticated;

create trigger appointments_refuse_merged_patient before insert on public.appointments
  for each row execute function public.refuse_merged_patient();
create trigger lab_orders_refuse_merged_patient before insert on public.lab_orders
  for each row execute function public.refuse_merged_patient();
create trigger referrals_refuse_merged_patient before insert on public.referrals
  for each row execute function public.refuse_merged_patient();
create trigger clinical_records_refuse_merged_patient before insert on public.clinical_records
  for each row execute function public.refuse_merged_patient();
create trigger conversations_refuse_merged_patient before insert on public.conversations
  for each row execute function public.refuse_merged_patient();

-- ---------------------------------------------------------------------------
-- Preview
-- ---------------------------------------------------------------------------

create or replace function public.patient_entity_counts(p_clinic_id uuid, p_patient_id uuid)
returns jsonb
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'appointments', (select count(*) from public.appointments a where a.clinic_id = p_clinic_id and a.patient_id = p_patient_id),
    'appointments_active', (select count(*) from public.appointments a where a.clinic_id = p_clinic_id and a.patient_id = p_patient_id
                              and a.status in ('pending', 'confirmed', 'checked_in', 'in_progress')),
    'payments', (select count(*) from public.payments x where x.clinic_id = p_clinic_id and x.patient_id = p_patient_id),
    'conversations', (select count(*) from public.conversations x where x.clinic_id = p_clinic_id and x.patient_id = p_patient_id),
    'conversations_open', (select count(*) from public.conversations x where x.clinic_id = p_clinic_id and x.patient_id = p_patient_id
                             and x.status in ('open', 'assigned')),
    'referrals', (select count(*) from public.referrals x where x.clinic_id = p_clinic_id and x.patient_id = p_patient_id),
    'referrals_open', (select count(*) from public.referrals x where x.clinic_id = p_clinic_id and x.patient_id = p_patient_id
                         and x.status in ('pending', 'accepted', 'in_progress')),
    'clinical_records', (select count(*) from public.clinical_records x where x.clinic_id = p_clinic_id and x.patient_id = p_patient_id),
    'lab_orders', (select count(*) from public.lab_orders x where x.clinic_id = p_clinic_id and x.patient_id = p_patient_id),
    'lab_orders_active', (select count(*) from public.lab_orders x where x.clinic_id = p_clinic_id and x.patient_id = p_patient_id and x.status = 'active'),
    'lab_results', (select count(*) from public.lab_results x where x.clinic_id = p_clinic_id and x.patient_id = p_patient_id),
    'lab_results_unfinished', (select count(*) from public.lab_results x where x.clinic_id = p_clinic_id and x.patient_id = p_patient_id
                                 and x.status in ('draft', 'submitted')),
    'lab_documents', (select count(*) from public.lab_documents x where x.clinic_id = p_clinic_id and x.patient_id = p_patient_id),
    'notifications_pending', (
      select count(*) from public.notification_jobs j
      where j.clinic_id = p_clinic_id and j.status in ('pending', 'in_progress')
        -- Appointment messages only: a pending "result ready" message still
        -- reaches the person (their Telegram identity moves with the merge).
        and j.appointment_id in (select a.id from public.appointments a where a.patient_id = p_patient_id)),
    'import_rows_pending', (select count(*) from public.lab_import_rows x where x.clinic_id = p_clinic_id and x.patient_id = p_patient_id
                              and x.status in ('ready', 'failed')),
    'audit_events', (select count(*) from public.audit_events x where x.clinic_id = p_clinic_id and x.patient_id = p_patient_id),
    'analytics_events', (select count(*) from public.analytics_events x where x.clinic_id = p_clinic_id and x.patient_id = p_patient_id)
  );
$$;

revoke all on function public.patient_entity_counts(uuid, uuid) from public, anon, authenticated;
grant execute on function public.patient_entity_counts(uuid, uuid) to service_role;

-- Doctors with their own relationship (live appointment or authored record) to a patient record.
create or replace function public.patient_relationship_doctors(p_clinic_id uuid, p_patient_id uuid)
returns uuid[]
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select coalesce(array(
    select a.doctor_id from public.appointments a
    where a.clinic_id = p_clinic_id and a.patient_id = p_patient_id and a.status <> 'cancelled'
    union
    select cr.author_doctor_id from public.clinical_records cr
    where cr.clinic_id = p_clinic_id and cr.patient_id = p_patient_id
  ), '{}');
$$;

revoke all on function public.patient_relationship_doctors(uuid, uuid) from public, anon, authenticated;
grant execute on function public.patient_relationship_doctors(uuid, uuid) to service_role;

create or replace function public.patient_merge_preview(p_clinic_id uuid, p_canonical_id uuid, p_duplicate_id uuid)
returns jsonb
language plpgsql
stable
security invoker
set search_path = public, pg_temp
as $$
declare
  c public.patients;
  d public.patients;
  v_blockers text[] := '{}';
  v_warnings text[] := '{}';
  v_plan jsonb := '{}'::jsonb;
  v_counts_c jsonb;
  v_counts_d jsonb;
  v_doctors_c uuid[];
  v_doctors_d uuid[];
  v_gain jsonb;
  v_body jsonb;
  v_field text;
  v_cv text;
  v_dv text;
begin
  select * into c from public.patients p where p.id = p_canonical_id and p.clinic_id = p_clinic_id;
  select * into d from public.patients p where p.id = p_duplicate_id and p.clinic_id = p_clinic_id;
  if c.id is null or d.id is null then
    raise exception 'patient_merge_not_found: both records must be patients of this clinic';
  end if;
  if c.id = d.id then
    v_blockers := array_append(v_blockers, ('same_patient')::text);
  end if;
  if c.merged_into_patient_id is not null then v_blockers := array_append(v_blockers, ('canonical_merged')::text); end if;
  if d.merged_into_patient_id is not null then v_blockers := array_append(v_blockers, ('duplicate_merged')::text); end if;
  if exists (select 1 from public.patients x where x.merged_into_patient_id = d.id) then
    v_blockers := array_append(v_blockers, ('duplicate_has_merged_records')::text);
  end if;

  -- Identity: contradictions stop the merge; what only the duplicate has moves (unique) or is copied.
  foreach v_field in array array['date_of_birth', 'sex', 'pinfl', 'document_number', 'telegram_user_id', 'full_name', 'phone'] loop
    v_cv := to_jsonb(c) ->> v_field;
    v_dv := to_jsonb(d) ->> v_field;
    v_plan := v_plan || jsonb_build_object(v_field,
      case
        when v_dv is null then 'keep'
        when v_cv is null then case when v_field in ('pinfl', 'document_number', 'telegram_user_id') then 'move' else 'copy' end
        when v_cv = v_dv then 'same'
        else 'differs'
      end);
    if v_cv is not null and v_dv is not null and v_cv <> v_dv then
      if v_field in ('date_of_birth', 'sex', 'pinfl', 'document_number') then
        v_blockers := array_append(v_blockers, ((case v_field when 'date_of_birth' then 'dob_differs' when 'document_number' then 'document_differs' else v_field || '_differs' end))::text);
      elsif v_field = 'telegram_user_id' then
        v_blockers := array_append(v_blockers, ('telegram_differs')::text);
      elsif v_field = 'full_name' then
        v_warnings := array_append(v_warnings, ('name_differs')::text);
      else
        v_warnings := array_append(v_warnings, ('phone_differs')::text);
      end if;
    end if;
  end loop;
  v_plan := v_plan || jsonb_build_object('consent', case when d.consent_given and not c.consent_given then 'copy' else 'keep' end);

  v_counts_c := public.patient_entity_counts(p_clinic_id, c.id);
  v_counts_d := public.patient_entity_counts(p_clinic_id, d.id);

  -- The duplicate's live work must be finished or cancelled first.
  if (v_counts_d ->> 'appointments_active')::int > 0 then v_blockers := array_append(v_blockers, ('duplicate_active_appointments')::text); end if;
  if (v_counts_d ->> 'referrals_open')::int > 0 then v_blockers := array_append(v_blockers, ('duplicate_open_referrals')::text); end if;
  if (v_counts_d ->> 'lab_orders_active')::int > 0 then v_blockers := array_append(v_blockers, ('duplicate_active_lab_orders')::text); end if;
  if (v_counts_d ->> 'lab_results_unfinished')::int > 0 then v_blockers := array_append(v_blockers, ('duplicate_unfinished_lab_results')::text); end if;
  if (v_counts_d ->> 'conversations_open')::int > 0 then v_blockers := array_append(v_blockers, ('duplicate_open_conversations')::text); end if;
  if (v_counts_d ->> 'notifications_pending')::int > 0 then v_blockers := array_append(v_blockers, ('duplicate_pending_notifications')::text); end if;
  if (v_counts_d ->> 'import_rows_pending')::int > 0 then v_blockers := array_append(v_blockers, ('duplicate_pending_import')::text); end if;

  -- Whose access extends: a doctor with their own relationship to one record
  -- will see the combined record (their own visits on both, as always).
  v_doctors_c := public.patient_relationship_doctors(p_clinic_id, c.id);
  v_doctors_d := public.patient_relationship_doctors(p_clinic_id, d.id);
  select coalesce(jsonb_agg(jsonb_build_object('doctor_id', dr.id, 'name', dr.name, 'from', case when dr.id = any (v_doctors_d) then 'duplicate' else 'canonical' end) order by dr.name), '[]'::jsonb)
  into v_gain
  from public.doctors dr
  where dr.clinic_id = p_clinic_id
    and ((dr.id = any (v_doctors_d) and not dr.id = any (v_doctors_c))
         or (dr.id = any (v_doctors_c) and not dr.id = any (v_doctors_d)));
  if jsonb_array_length(v_gain) > 0 then
    v_warnings := array_append(v_warnings, ('doctor_access_extends')::text);
  end if;

  v_body := jsonb_build_object(
    'canonical', jsonb_build_object('id', c.id, 'full_name', c.full_name, 'phone', c.phone, 'date_of_birth', c.date_of_birth, 'sex', c.sex,
                                    'has_pinfl', c.pinfl is not null, 'has_document', c.document_number is not null,
                                    'has_telegram', c.telegram_user_id is not null, 'created_at', c.created_at, 'updated_at', c.updated_at,
                                    'counts', v_counts_c),
    'duplicate', jsonb_build_object('id', d.id, 'full_name', d.full_name, 'phone', d.phone, 'date_of_birth', d.date_of_birth, 'sex', d.sex,
                                    'has_pinfl', d.pinfl is not null, 'has_document', d.document_number is not null,
                                    'has_telegram', d.telegram_user_id is not null, 'created_at', d.created_at, 'updated_at', d.updated_at,
                                    'counts', v_counts_d),
    'plan', v_plan,
    'doctors_gaining_access', v_gain,
    'blockers', to_jsonb(v_blockers),
    'warnings', to_jsonb(v_warnings)
  );
  -- The fingerprint covers everything the staff member decides on; the
  -- audit and analytics counts are informational (viewing the preview is
  -- itself audited, so they would never match).
  return v_body || jsonb_build_object('fingerprint', md5((
    v_body #- '{canonical,counts,audit_events}' #- '{duplicate,counts,audit_events}'
           #- '{canonical,counts,analytics_events}' #- '{duplicate,counts,analytics_events}')::text));
end;
$$;

revoke all on function public.patient_merge_preview(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.patient_merge_preview(uuid, uuid, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- Merge
-- ---------------------------------------------------------------------------

create or replace function public.merge_patients(
  p_clinic_id uuid,
  p_canonical_id uuid,
  p_duplicate_id uuid,
  p_actor uuid,
  p_reason text,
  p_fingerprint text
)
returns uuid
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_preview jsonb;
  v_merge uuid;
  c public.patients;
  d public.patients;
  v_moved jsonb := '{}'::jsonb;
  v_copied jsonb := '{}'::jsonb;
begin
  if not exists (
    select 1 from public.staff_roles sr
    where sr.clinic_id = p_clinic_id and sr.profile_id = p_actor and sr.role in ('owner', 'admin')
  ) then
    raise exception 'patient_merge_forbidden: only the clinic owner or an administrator merges patients';
  end if;
  if p_reason is null or char_length(btrim(p_reason)) < 3 then
    raise exception 'patient_merge_reason_required: give the reason for the merge';
  end if;

  -- Both records, in a fixed order (no deadlock between opposite merges).
  perform 1 from public.patients p
  where p.id in (p_canonical_id, p_duplicate_id) and p.clinic_id = p_clinic_id
  order by p.id
  for update;

  v_preview := public.patient_merge_preview(p_clinic_id, p_canonical_id, p_duplicate_id);
  if jsonb_array_length(v_preview -> 'blockers') > 0 then
    raise exception 'patient_merge_blocked: %', (select string_agg(b, ',') from jsonb_array_elements_text(v_preview -> 'blockers') b);
  end if;
  if p_fingerprint is distinct from v_preview ->> 'fingerprint' then
    raise exception 'patient_merge_preview_changed: the records changed since the preview';
  end if;

  select * into c from public.patients p where p.id = p_canonical_id;
  select * into d from public.patients p where p.id = p_duplicate_id;

  -- Unique identity moves (cleared on the duplicate first, then set).
  if d.telegram_user_id is not null and c.telegram_user_id is null then
    v_moved := v_moved || jsonb_build_object('telegram_user_id', d.telegram_user_id, 'telegram_username', d.telegram_username,
                                             'telegram_first_name', d.telegram_first_name, 'telegram_last_name', d.telegram_last_name);
  end if;
  if d.pinfl is not null and c.pinfl is null then
    v_moved := v_moved || jsonb_build_object('pinfl', d.pinfl);
  end if;
  if d.document_number is not null and c.document_number is null then
    v_moved := v_moved || jsonb_build_object('document_number', d.document_number);
  end if;
  if v_moved <> '{}'::jsonb then
    update public.patients
    set telegram_user_id = case when v_moved ? 'telegram_user_id' then null else telegram_user_id end,
        telegram_username = case when v_moved ? 'telegram_user_id' then null else telegram_username end,
        telegram_first_name = case when v_moved ? 'telegram_user_id' then null else telegram_first_name end,
        telegram_last_name = case when v_moved ? 'telegram_user_id' then null else telegram_last_name end,
        pinfl = case when v_moved ? 'pinfl' then null else pinfl end,
        document_number = case when v_moved ? 'document_number' then null else document_number end
    where id = d.id;
    update public.patients
    set telegram_user_id = coalesce((v_moved ->> 'telegram_user_id')::bigint, telegram_user_id),
        telegram_username = case when v_moved ? 'telegram_user_id' then v_moved ->> 'telegram_username' else telegram_username end,
        telegram_first_name = case when v_moved ? 'telegram_user_id' then v_moved ->> 'telegram_first_name' else telegram_first_name end,
        telegram_last_name = case when v_moved ? 'telegram_user_id' then v_moved ->> 'telegram_last_name' else telegram_last_name end,
        pinfl = coalesce(v_moved ->> 'pinfl', pinfl),
        document_number = coalesce(v_moved ->> 'document_number', document_number)
    where id = c.id;
  end if;

  -- Facts the canonical record lacks are copied (the duplicate keeps them too).
  if c.date_of_birth is null and d.date_of_birth is not null then v_copied := v_copied || jsonb_build_object('date_of_birth', d.date_of_birth); end if;
  if c.sex is null and d.sex is not null then v_copied := v_copied || jsonb_build_object('sex', d.sex); end if;
  if c.full_name is null and d.full_name is not null then v_copied := v_copied || jsonb_build_object('full_name', d.full_name); end if;
  if c.phone is null and d.phone is not null then v_copied := v_copied || jsonb_build_object('phone', d.phone); end if;
  if not c.consent_given and d.consent_given then
    v_copied := v_copied || jsonb_build_object('consent_given', true, 'consent_given_at', d.consent_given_at);
  end if;
  if v_copied <> '{}'::jsonb then
    update public.patients
    set date_of_birth = coalesce(date_of_birth, (v_copied ->> 'date_of_birth')::date),
        sex = coalesce(sex, (v_copied ->> 'sex')::public.patient_sex),
        full_name = coalesce(full_name, v_copied ->> 'full_name'),
        phone = coalesce(phone, v_copied ->> 'phone'),
        consent_given = consent_given or coalesce((v_copied ->> 'consent_given')::boolean, false),
        consent_given_at = case when v_copied ? 'consent_given' then (v_copied ->> 'consent_given_at')::timestamptz else consent_given_at end
    where id = c.id;
  end if;

  update public.patients set merged_into_patient_id = c.id, merged_at = now() where id = d.id;

  insert into public.patient_merges (clinic_id, canonical_patient_id, duplicate_patient_id, reason, merged_by, preview, moved, copied)
  values (p_clinic_id, c.id, d.id, btrim(p_reason), p_actor, v_preview, v_moved, v_copied)
  returning id into v_merge;

  -- Ids and field names only — never identity values or the reason text.
  insert into public.audit_events (clinic_id, actor_id, actor_type, action, entity_type, entity_id, patient_id, new_values)
  values
    (p_clinic_id, p_actor, 'staff', 'patient_merged', 'patient_merges', v_merge::text, c.id,
     jsonb_build_object('role', 'canonical', 'canonical_patient_id', c.id, 'duplicate_patient_id', d.id,
                        'moved_fields', (select coalesce(jsonb_agg(k), '[]') from jsonb_object_keys(v_moved) k),
                        'copied_fields', (select coalesce(jsonb_agg(k), '[]') from jsonb_object_keys(v_copied) k))),
    (p_clinic_id, p_actor, 'staff', 'patient_merged', 'patient_merges', v_merge::text, d.id,
     jsonb_build_object('role', 'duplicate', 'canonical_patient_id', c.id, 'duplicate_patient_id', d.id));
  return v_merge;
end;
$$;

revoke all on function public.merge_patients(uuid, uuid, uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.merge_patients(uuid, uuid, uuid, uuid, text, text) to service_role;

-- ---------------------------------------------------------------------------
-- Unmerge
-- ---------------------------------------------------------------------------

create or replace function public.unmerge_patients(p_clinic_id uuid, p_merge_id uuid, p_actor uuid, p_reason text)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  m public.patient_merges;
  c public.patients;
  d public.patients;
  v_restored text[] := '{}';
  v_left text[] := '{}';
  v_report jsonb;
  v_since jsonb;
begin
  if not exists (
    select 1 from public.staff_roles sr
    where sr.clinic_id = p_clinic_id and sr.profile_id = p_actor and sr.role in ('owner', 'admin')
  ) then
    raise exception 'patient_merge_forbidden: only the clinic owner or an administrator undoes a merge';
  end if;
  if p_reason is null or char_length(btrim(p_reason)) < 3 then
    raise exception 'patient_merge_reason_required: give the reason';
  end if;

  select * into m from public.patient_merges x where x.id = p_merge_id and x.clinic_id = p_clinic_id for update;
  if not found then
    raise exception 'patient_merge_not_found: no such merge in this clinic';
  end if;
  if m.unmerged_at is not null then
    raise exception 'patient_merge_already_undone: this merge was already undone';
  end if;

  perform 1 from public.patients p where p.id in (m.canonical_patient_id, m.duplicate_patient_id) order by p.id for update;
  select * into c from public.patients p where p.id = m.canonical_patient_id;
  select * into d from public.patients p where p.id = m.duplicate_patient_id;

  -- Identity goes back only while it is exactly as the merge left it.
  if m.moved ? 'telegram_user_id' then
    if c.telegram_user_id = (m.moved ->> 'telegram_user_id')::bigint and d.telegram_user_id is null then
      update public.patients set telegram_user_id = null, telegram_username = null, telegram_first_name = null, telegram_last_name = null where id = c.id;
      update public.patients
      set telegram_user_id = (m.moved ->> 'telegram_user_id')::bigint, telegram_username = m.moved ->> 'telegram_username',
          telegram_first_name = m.moved ->> 'telegram_first_name', telegram_last_name = m.moved ->> 'telegram_last_name'
      where id = d.id;
      v_restored := array_append(v_restored, ('telegram_user_id')::text);
    else
      v_left := array_append(v_left, ('telegram_user_id')::text);
    end if;
  end if;
  if m.moved ? 'pinfl' then
    if c.pinfl = m.moved ->> 'pinfl' and d.pinfl is null then
      update public.patients set pinfl = null where id = c.id;
      update public.patients set pinfl = m.moved ->> 'pinfl' where id = d.id;
      v_restored := array_append(v_restored, ('pinfl')::text);
    else
      v_left := array_append(v_left, ('pinfl')::text);
    end if;
  end if;
  if m.moved ? 'document_number' then
    if c.document_number = m.moved ->> 'document_number' and d.document_number is null then
      update public.patients set document_number = null where id = c.id;
      update public.patients set document_number = m.moved ->> 'document_number' where id = d.id;
      v_restored := array_append(v_restored, ('document_number')::text);
    else
      v_left := array_append(v_left, ('document_number')::text);
    end if;
  end if;

  update public.patients set merged_into_patient_id = null, merged_at = null where id = d.id;

  -- What was created on the canonical record after the merge stays there.
  v_since := jsonb_build_object(
    'appointments', (select count(*) from public.appointments a where a.patient_id = c.id and a.created_at >= m.merged_at),
    'lab_orders', (select count(*) from public.lab_orders o where o.patient_id = c.id and o.created_at >= m.merged_at),
    'conversations', (select count(*) from public.conversations x where x.patient_id = c.id and x.created_at >= m.merged_at),
    'referrals', (select count(*) from public.referrals x where x.patient_id = c.id and x.created_at >= m.merged_at),
    'clinical_records', (select count(*) from public.clinical_records x where x.patient_id = c.id and x.created_at >= m.merged_at));
  v_report := jsonb_build_object(
    'restored_fields', to_jsonb(v_restored),
    'left_on_canonical', to_jsonb(v_left),
    'copied_fields_kept', (select coalesce(jsonb_agg(k), '[]') from jsonb_object_keys(m.copied) k),
    'created_on_canonical_since_merge', v_since);

  update public.patient_merges
  set unmerged_by = p_actor, unmerged_at = now(), unmerge_reason = btrim(p_reason), unmerge_report = v_report
  where id = m.id;

  insert into public.audit_events (clinic_id, actor_id, actor_type, action, entity_type, entity_id, patient_id, new_values)
  values
    (p_clinic_id, p_actor, 'staff', 'patient_unmerged', 'patient_merges', m.id::text, c.id,
     jsonb_build_object('role', 'canonical', 'restored_fields', to_jsonb(v_restored), 'left_on_canonical', to_jsonb(v_left))),
    (p_clinic_id, p_actor, 'staff', 'patient_unmerged', 'patient_merges', m.id::text, d.id,
     jsonb_build_object('role', 'duplicate'));
  return v_report;
end;
$$;

revoke all on function public.unmerge_patients(uuid, uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.unmerge_patients(uuid, uuid, uuid, text) to service_role;

-- ---------------------------------------------------------------------------
-- Possible duplicates (suggestions for staff review — never merged automatically)
-- ---------------------------------------------------------------------------

create or replace function public.patient_name_key(p_name text)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select nullif(array_to_string(array(
    select t from unnest(regexp_split_to_array(lower(regexp_replace(coalesce(p_name, ''), '[ʻʼ‘’`''"]', '', 'g')), '[^[:alpha:]]+')) t
    where t <> '' order by t), ' '), '');
$$;

create or replace function public.patient_duplicate_candidates(p_clinic_id uuid, p_limit integer default 100)
returns table (patient_a uuid, patient_b uuid, reasons text[])
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  with live as (
    select p.id, p.date_of_birth,
           public.patient_name_key(coalesce(p.full_name, concat_ws(' ', p.telegram_first_name, p.telegram_last_name))) as name_key,
           nullif(right(regexp_replace(coalesce(p.phone, ''), '\D', '', 'g'), 9), '') as phone_key
    from public.patients p
    where p.clinic_id = p_clinic_id and p.merged_into_patient_id is null
  ), pairs as (
    select a.id as patient_a, b.id as patient_b,
           array_remove(array[
             case when a.date_of_birth = b.date_of_birth and a.name_key = b.name_key then 'same_name_and_birth_date' end,
             case when a.date_of_birth = b.date_of_birth and length(a.phone_key) = 9 and a.phone_key = b.phone_key then 'same_phone_and_birth_date' end,
             -- Name and phone agree, and no birth dates contradict them.
             case when a.name_key = b.name_key and length(a.phone_key) = 9 and a.phone_key = b.phone_key
                       and not (a.date_of_birth is not null and b.date_of_birth is not null and a.date_of_birth <> b.date_of_birth)
                  then 'same_name_and_phone' end
           ], null) as reasons
    from live a
    join live b on a.id < b.id
      and ((a.date_of_birth = b.date_of_birth) or (a.name_key = b.name_key and a.phone_key = b.phone_key))
  )
  select patient_a, patient_b, reasons from pairs
  where cardinality(reasons) > 0
  limit greatest(1, least(coalesce(p_limit, 100), 500));
$$;

revoke all on function public.patient_name_key(text) from public, anon, authenticated;
grant execute on function public.patient_name_key(text) to service_role;
revoke all on function public.patient_duplicate_candidates(uuid, integer) from public, anon, authenticated;
grant execute on function public.patient_duplicate_candidates(uuid, integer) to service_role;

-- ---------------------------------------------------------------------------
-- "Result ready" reaches the person's Telegram identity, wherever the merge put it.
-- ---------------------------------------------------------------------------

create or replace function public.lab_results_notify_patient()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_telegram bigint;
begin
  if new.source = 'import' then
    return null; -- historical data brought in by an import: not news to the patient
  end if;
  if not public.lab_release_to_patient(new.clinic_id) then
    return null;
  end if;
  select p.telegram_user_id into v_telegram
  from public.patients p
  where p.id = public.patient_canonical_id(new.patient_id) and p.clinic_id = new.clinic_id;
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

-- =====================================================================
-- FILE: 20261005000017_lab_external_providers.sql
-- =====================================================================
-- Laboratory (Phase 15): external laboratory integration architecture.
--
-- A test the clinic's lab has received can be SENT OUT to an external
-- laboratory through a provider adapter (src/lib/labs/providers). No real
-- provider is integrated yet (no verified API); the first adapter is a mock.
--
--   lab_providers         a clinic's configured external laboratory: which
--                         adapter speaks to it, non-secret settings, and the
--                         NAME of the environment variable holding its
--                         credential (LAB_PROVIDER_…). Secrets never enter
--                         the database.
--   lab_provider_codes    the provider's codes for the clinic's tests and
--                         parameters. Provider-specific codes live here, not
--                         in the core lab model.
--   lab_external_requests one send-out of one order item: status (normalized
--                         from the provider's), the provider's order id,
--                         retries with back-off, a processing lease, the
--                         result it produced, and whether it needs review.
--
-- Normalized flow:
--   queued → sent → in_progress → resulted       (failed / rejected / cancelled)
--
-- Results from a provider become a lab result version with source =
-- external, entered (and, when complete, submitted) on behalf of the staff
-- member who sent the test out, and VERIFIED BY A SECOND PERSON like every
-- result (O4). Nothing a provider sends is final on its own.
--
-- Duplicate prevention: one live send-out per order item; a provider order
-- id once per provider; a provider result id once per send-out; and while a
-- send-out is live, nobody enters a manual result for the item.

create type public.lab_external_status as enum ('queued', 'sent', 'in_progress', 'resulted', 'failed', 'rejected', 'cancelled');

create table public.lab_providers (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete cascade,
  code text not null,
  name text not null,
  -- Which adapter (src/lib/labs/providers/registry.ts) speaks to this provider.
  adapter text not null,
  active boolean not null default true,
  -- Non-secret settings for the adapter (validated by the adapter).
  config jsonb not null default '{}'::jsonb,
  -- The environment variable holding the credential — never the credential.
  credential_ref text,
  -- Minimum necessary: the patient's name is shared only when the provider requires it.
  send_patient_name boolean not null default false,
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint lab_providers_id_clinic_id_key unique (id, clinic_id),
  constraint lab_providers_code_key unique (clinic_id, code),
  constraint lab_providers_code_check check (code ~ '^[a-z0-9][a-z0-9_-]{1,39}$'),
  constraint lab_providers_name_check check (name ~ '\S' and char_length(name) <= 120),
  constraint lab_providers_adapter_check check (adapter ~ '^[a-z0-9_]{2,40}$'),
  constraint lab_providers_config_check check (jsonb_typeof(config) = 'object' and pg_column_size(config) <= 8192),
  constraint lab_providers_credential_check check (credential_ref is null or credential_ref ~ '^LAB_PROVIDER_[A-Z0-9_]{1,60}$')
);

create table public.lab_provider_codes (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete cascade,
  provider_id uuid not null,
  kind text not null,
  internal_id uuid not null,
  external_code text not null,
  created_at timestamptz not null default now(),

  constraint lab_provider_codes_provider_fkey
    foreign key (provider_id, clinic_id) references public.lab_providers (id, clinic_id) on delete cascade,
  constraint lab_provider_codes_kind_check check (kind in ('test', 'parameter')),
  constraint lab_provider_codes_code_check check (external_code ~ '\S' and char_length(external_code) <= 64),
  constraint lab_provider_codes_internal_key unique (provider_id, kind, internal_id),
  constraint lab_provider_codes_external_key unique (provider_id, kind, external_code)
);

-- A code names a test / parameter of the same clinic.
create or replace function public.lab_provider_codes_validate()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.kind = 'test' and not exists (
    select 1 from public.lab_tests t where t.id = new.internal_id and t.clinic_id = new.clinic_id
  ) then
    raise exception 'lab provider code: unknown test';
  end if;
  if new.kind = 'parameter' and not exists (
    select 1 from public.lab_test_parameters p where p.id = new.internal_id and p.clinic_id = new.clinic_id
  ) then
    raise exception 'lab provider code: unknown parameter';
  end if;
  return new;
end;
$$;

revoke all on function public.lab_provider_codes_validate() from public, anon, authenticated;

create trigger lab_provider_codes_validate
  before insert or update on public.lab_provider_codes
  for each row execute function public.lab_provider_codes_validate();

create table public.lab_external_requests (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete cascade,
  provider_id uuid not null,
  order_item_id uuid not null,
  patient_id uuid not null,
  status public.lab_external_status not null default 'queued',
  requested_by uuid not null references public.profiles(id),
  requested_at timestamptz not null default now(),
  -- The provider's identifier for the order (set once it accepted it).
  external_order_id text,
  -- The provider's identifier of the result recorded (duplicate deliveries are ignored).
  external_result_id text,
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  -- A worker holds the request until then (no two workers act on it at once).
  lease_until timestamptz,
  last_error_code text,
  sent_at timestamptz,
  resulted_at timestamptz,
  result_id uuid,
  -- Something the integration cannot settle on its own (codes only).
  review_reason text,
  cancelled_by uuid references public.profiles(id),
  cancelled_at timestamptz,
  updated_at timestamptz not null default now(),

  constraint lab_external_requests_id_clinic_id_key unique (id, clinic_id),
  constraint lab_external_requests_provider_fkey
    foreign key (provider_id, clinic_id) references public.lab_providers (id, clinic_id),
  constraint lab_external_requests_item_fkey
    foreign key (order_item_id, clinic_id, patient_id) references public.lab_order_items (id, clinic_id, patient_id),
  constraint lab_external_requests_result_fkey
    foreign key (result_id, clinic_id) references public.lab_results (id, clinic_id),
  constraint lab_external_requests_codes_check
    check ((last_error_code is null or last_error_code ~ '^[a-z_]{2,40}$')
           and (review_reason is null or review_reason ~ '^[a-z_]{2,40}$')
           and (external_order_id is null or (external_order_id ~ '\S' and char_length(external_order_id) <= 120))
           and (external_result_id is null or (external_result_id ~ '\S' and char_length(external_result_id) <= 120))),
  constraint lab_external_requests_resulted_check
    check ((status = 'resulted') = (result_id is not null) and (status = 'resulted') = (resulted_at is not null)),
  constraint lab_external_requests_cancel_check
    check ((status = 'cancelled') = (cancelled_at is not null))
);

-- One live send-out per test; a provider order id once per provider.
create unique index lab_external_requests_live_item_key
  on public.lab_external_requests (order_item_id) where status not in ('failed', 'rejected', 'cancelled');
create unique index lab_external_requests_external_order_key
  on public.lab_external_requests (provider_id, external_order_id) where external_order_id is not null;
create index lab_external_requests_due_idx
  on public.lab_external_requests (next_attempt_at) where status in ('queued', 'sent', 'in_progress');

create or replace function public.lab_external_requests_touch()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  new.updated_at := now();
  if tg_op = 'UPDATE' and (new.clinic_id <> old.clinic_id or new.order_item_id <> old.order_item_id
     or new.provider_id <> old.provider_id or new.patient_id <> old.patient_id or new.requested_by <> old.requested_by) then
    raise exception 'lab external request: what was sent and to whom cannot change';
  end if;
  if tg_op = 'UPDATE' and old.status in ('resulted', 'rejected', 'cancelled') and new.status <> old.status then
    raise exception 'lab external request: a % request is final', old.status;
  end if;
  return new;
end;
$$;

revoke all on function public.lab_external_requests_touch() from public, anon, authenticated;

create trigger lab_external_requests_touch
  before insert or update on public.lab_external_requests
  for each row execute function public.lab_external_requests_touch();

create trigger lab_providers_touch
  before update on public.lab_providers
  for each row execute function public.set_updated_at();

-- While a test is out at an external laboratory, nobody enters a manual result for it.
create or replace function public.lab_results_refuse_while_sent_out()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.source = 'manual' and new.supersedes_result_id is null and exists (
    select 1 from public.lab_external_requests r
    where r.order_item_id = new.order_item_id and r.status in ('queued', 'sent', 'in_progress')
  ) then
    raise exception 'lab_result_external_pending: the test is at an external laboratory';
  end if;
  return new;
end;
$$;

revoke all on function public.lab_results_refuse_while_sent_out() from public, anon, authenticated;

create trigger lab_results_refuse_while_sent_out
  before insert on public.lab_results
  for each row execute function public.lab_results_refuse_while_sent_out();

-- Audit: ids, status and codes — never values or provider payloads.
create or replace function public.lab_external_requests_audit()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_action text;
begin
  if tg_op = 'INSERT' then
    v_action := 'lab_external_requested';
  elsif new.status is distinct from old.status then
    v_action := 'lab_external_' || new.status::text;
  elsif new.review_reason is distinct from old.review_reason and new.review_reason is not null then
    v_action := 'lab_external_needs_review';
  else
    return null;
  end if;
  if public.lab_clinic_is_being_erased(new.clinic_id) then
    return null;
  end if;
  insert into public.audit_events (clinic_id, actor_id, actor_type, action, entity_type, entity_id, patient_id, new_values)
  values (
    new.clinic_id,
    case when tg_op = 'INSERT' then new.requested_by else coalesce(new.cancelled_by, public.lab_current_actor()) end,
    case when tg_op = 'INSERT' or coalesce(new.cancelled_by, public.lab_current_actor()) is not null then 'staff'::public.actor_type else 'system'::public.actor_type end,
    v_action,
    'lab_external_requests',
    new.id::text,
    new.patient_id,
    jsonb_build_object('order_item_id', new.order_item_id, 'provider_id', new.provider_id, 'status', new.status,
                       'attempts', new.attempts, 'error_code', new.last_error_code, 'review_reason', new.review_reason,
                       'result_id', new.result_id)
  );
  return null;
end;
$$;

revoke all on function public.lab_external_requests_audit() from public, anon, authenticated;

create trigger lab_external_requests_audit
  after insert or update on public.lab_external_requests
  for each row execute function public.lab_external_requests_audit();

alter table public.lab_providers enable row level security;
alter table public.lab_provider_codes enable row level security;
alter table public.lab_external_requests enable row level security;
revoke all on table public.lab_providers from public, anon, authenticated, service_role;
revoke all on table public.lab_provider_codes from public, anon, authenticated, service_role;
revoke all on table public.lab_external_requests from public, anon, authenticated, service_role;
grant select, insert, update on table public.lab_providers to service_role;
grant select, insert, update, delete on table public.lab_provider_codes to service_role;
grant select, insert, update on table public.lab_external_requests to service_role;

-- ---------------------------------------------------------------------------
-- request_external_lab: send a received test out (idempotent per item)
-- ---------------------------------------------------------------------------

create or replace function public.request_external_lab(p_clinic_id uuid, p_order_item_id uuid, p_provider_id uuid, p_actor uuid)
returns table (lab_external_request_id uuid, replayed boolean)
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_item public.lab_order_items;
  v_provider public.lab_providers;
  v_existing public.lab_external_requests;
  v_source public.lab_order_source;
  v_id uuid;
begin
  perform set_config('app.lab_actor', p_actor::text, true);
  if not public.lab_is_clinic_member(p_clinic_id, p_actor) then
    raise exception 'lab_external_forbidden: not a staff member of the clinic';
  end if;

  select * into v_item from public.lab_order_items i where i.id = p_order_item_id and i.clinic_id = p_clinic_id for update;
  if not found then
    raise exception 'lab_external_unknown_item: the test is not in this clinic';
  end if;
  select * into v_provider from public.lab_providers p where p.id = p_provider_id and p.clinic_id = p_clinic_id;
  if not found or not v_provider.active then
    raise exception 'lab_external_unknown_provider: no such active provider in this clinic';
  end if;

  select * into v_existing from public.lab_external_requests r
  where r.order_item_id = v_item.id and r.status not in ('failed', 'rejected', 'cancelled');
  if found then
    if v_existing.provider_id <> p_provider_id then
      raise exception 'lab_external_already_sent: the test is already sent to another laboratory';
    end if;
    return query select v_existing.id, true;
    return;
  end if;

  select o.source into v_source from public.lab_orders o where o.id = v_item.order_id;
  if v_source = 'external_import' then
    raise exception 'lab_external_imported: imported results are not sent out';
  end if;
  if v_item.status <> 'processing' then
    raise exception 'lab_external_item_not_ready: a test is sent out once the lab has received its sample (it is %)', v_item.status;
  end if;
  if exists (select 1 from public.lab_results r where r.order_item_id = v_item.id) then
    raise exception 'lab_external_has_result: the test already has a result';
  end if;
  if not exists (
    select 1 from public.lab_provider_codes c
    where c.provider_id = p_provider_id and c.kind = 'test' and c.internal_id = v_item.test_id
  ) then
    raise exception 'lab_external_unmapped_test: the provider has no code for this test';
  end if;

  insert into public.lab_external_requests (clinic_id, provider_id, order_item_id, patient_id, requested_by)
  values (p_clinic_id, p_provider_id, v_item.id, v_item.patient_id, p_actor)
  returning id into v_id;
  return query select v_id, false;
end;
$$;

revoke all on function public.request_external_lab(uuid, uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.request_external_lab(uuid, uuid, uuid, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- claim_external_lab_requests: the worker's atomic claim (SKIP LOCKED + lease)
-- ---------------------------------------------------------------------------

create or replace function public.claim_external_lab_requests(p_limit integer default 20, p_lease_seconds integer default 120)
returns setof public.lab_external_requests
language sql
security invoker
set search_path = public, pg_temp
as $$
  with due as (
    select r.id
    from public.lab_external_requests r
    join public.lab_providers p on p.id = r.provider_id
    where r.status in ('queued', 'sent', 'in_progress')
      and r.next_attempt_at <= now()
      and (r.lease_until is null or r.lease_until < now())
      and p.active
    order by r.next_attempt_at
    limit greatest(1, least(coalesce(p_limit, 20), 100))
    for update of r skip locked
  )
  update public.lab_external_requests r
  set lease_until = now() + make_interval(secs => greatest(30, least(coalesce(p_lease_seconds, 120), 900)))
  from due
  where r.id = due.id
  returning r.*;
$$;

revoke all on function public.claim_external_lab_requests(integer, integer) from public, anon, authenticated;
grant execute on function public.claim_external_lab_requests(integer, integer) to service_role;

-- ---------------------------------------------------------------------------
-- record_external_lab_result: a provider's result → a result version (source
-- external), idempotent per provider result id. Values arrive already mapped
-- to the clinic's parameters by the server; the value trigger checks types,
-- choices and decimals and computes flags from the clinic's ranges.
-- ---------------------------------------------------------------------------

create or replace function public.record_external_lab_result(
  p_clinic_id uuid,
  p_request_id uuid,
  p_external_result_id text,
  p_values jsonb,
  p_performed_at timestamptz default null
)
returns table (lab_result_id uuid, submitted boolean, replayed boolean)
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_req public.lab_external_requests;
  v_result uuid;
  v_submitted boolean := false;
  v_entry jsonb;
begin
  select * into v_req from public.lab_external_requests r
  where r.id = p_request_id and r.clinic_id = p_clinic_id
  for update;
  if not found then
    raise exception 'lab_external_unknown_request: no such send-out in this clinic';
  end if;
  if v_req.status = 'resulted' then
    if v_req.external_result_id = p_external_result_id then
      return query select v_req.result_id, true, true; -- the same delivery again
      return;
    end if;
    raise exception 'lab_external_result_conflict: a different result for a send-out that already has one';
  end if;
  if v_req.status not in ('sent', 'in_progress') then
    raise exception 'lab_external_not_awaiting_result: the send-out is %', v_req.status;
  end if;
  if p_values is null or jsonb_typeof(p_values) <> 'array' or jsonb_array_length(p_values) = 0 or jsonb_array_length(p_values) > 200 then
    raise exception 'lab_external_bad_values: no values';
  end if;

  perform set_config('app.lab_actor', v_req.requested_by::text, true);

  insert into public.lab_results (clinic_id, order_item_id, patient_id, source, entered_by, performed_at)
  values (p_clinic_id, v_req.order_item_id, v_req.patient_id, 'external', v_req.requested_by, p_performed_at)
  returning id into v_result;

  for v_entry in select * from jsonb_array_elements(p_values) loop
    insert into public.lab_result_values (clinic_id, result_id, parameter_id, value_numeric, value_text, value_boolean)
    values (p_clinic_id, v_result, (v_entry->>'parameter_id')::uuid,
            (v_entry->>'value_numeric')::numeric, nullif(btrim(v_entry->>'value_text'), ''), (v_entry->>'value_boolean')::boolean);
  end loop;

  -- Complete → submitted for a second person's verification; incomplete → a
  -- draft the requester completes. Never verified here.
  begin
    perform public.submit_lab_result(p_clinic_id, v_result, v_req.requested_by);
    v_submitted := true;
  exception when others then
    if sqlerrm not like 'lab_result_incomplete%' then
      raise;
    end if;
  end;

  update public.lab_external_requests
  set status = 'resulted', result_id = v_result, resulted_at = now(), external_result_id = p_external_result_id,
      lease_until = null, last_error_code = null,
      review_reason = case when v_submitted then null else 'result_incomplete' end
  where id = v_req.id;

  return query select v_result, v_submitted, false;
end;
$$;

revoke all on function public.record_external_lab_result(uuid, uuid, text, jsonb, timestamptz) from public, anon, authenticated;
grant execute on function public.record_external_lab_result(uuid, uuid, text, jsonb, timestamptz) to service_role;

-- =====================================================================
-- FILE: 20261005000018_lab_notification_events.sql
-- =====================================================================
-- Laboratory (Phase 16): the lab lifecycle events as notification job types.
-- Enum values are added in their own migration (a new value cannot be used
-- in the transaction that adds it); 20261005000019 uses them.
--
--   lab_order_created     LAB_ORDER_CREATED
--   lab_sample_collected  LAB_SAMPLE_COLLECTED
--   lab_result_entered    LAB_RESULT_ENTERED (submitted for verification)
--   lab_result_verified   LAB_RESULT_VERIFIED
--   lab_result_ready      LAB_RESULT_READY (Phase 12, the patient's message)
--   lab_result_corrected  LAB_RESULT_CORRECTED
--   lab_order_cancelled   LAB_ORDER_CANCELLED

alter type public.notification_job_type add value if not exists 'lab_order_created';
alter type public.notification_job_type add value if not exists 'lab_sample_collected';
alter type public.notification_job_type add value if not exists 'lab_result_entered';
alter type public.notification_job_type add value if not exists 'lab_result_verified';
alter type public.notification_job_type add value if not exists 'lab_result_corrected';
alter type public.notification_job_type add value if not exists 'lab_order_cancelled';

-- New enum values must be committed before any later statement uses them.
commit;

-- =====================================================================
-- FILE: 20261005000019_lab_notifications.sql
-- =====================================================================
-- Laboratory (Phase 16): lab lifecycle notifications on the existing
-- notification architecture (notification_jobs).
--
-- Two channels, one table:
--   * telegram — the patient's messages, claimed and sent by the existing
--     worker (claim_due_notification_jobs, SKIP LOCKED, retries, idempotency
--     key). LAB_RESULT_READY / CORRECTED (Phase 12) and, when the clinic
--     enables it, LAB_ORDER_CANCELLED.
--   * in_app — staff notifications (staff have no Telegram identity, and the
--     global admin chat is not per clinic). A row per recipient, delivered
--     on insert (status sent), read in the staff inbox; never claimed by
--     the Telegram worker.
--
-- Rows carry ids and an event type only — never names, test names, values
-- or clinical text. The inbox builds the wording when it is read, after
-- re-checking that the reader may still see the patient (doctors:
-- doctor_patient_access).
--
-- Who is notified (never the person who caused the event; imports never
-- notify anyone):
--   LAB_ORDER_CREATED     lab staff
--   LAB_SAMPLE_COLLECTED  lab staff
--   LAB_RESULT_ENTERED    the verifiers (clinic setting `verifiers`): lab
--                         staff and/or the ordering doctor
--   LAB_RESULT_VERIFIED   the ordering doctor
--   LAB_RESULT_CORRECTED  the ordering doctor
--   LAB_ORDER_CANCELLED   lab staff, managers (owner/manager/admin), the
--                         ordering doctor; the patient only if the clinic
--                         enables it (notifyPatientOnCancel, default off)
--   LAB_RESULT_READY      the patient (Phase 12; released results only)
-- Clinic configuration: app_settings lab.notifyStaff (default true) turns
-- all staff notifications off.
--
-- Idempotency: one job per (event, entity, recipient) — the unique
-- idempotency key — so a repeated event never notifies twice.

alter table public.notification_jobs
  add column recipient_profile_id uuid references public.profiles(id) on delete cascade,
  add column lab_order_id uuid,
  add column read_at timestamptz;

alter table public.notification_jobs
  drop constraint notification_jobs_lab_result_check,
  add constraint notification_jobs_lab_order_fkey
    foreign key (lab_order_id, clinic_id) references public.lab_orders (id, clinic_id) on delete cascade,
  add constraint notification_jobs_lab_refs_check
    check ((type in ('lab_result_ready', 'lab_result_entered', 'lab_result_verified', 'lab_result_corrected')) = (lab_result_id is not null)
           and (type not in ('lab_order_created', 'lab_sample_collected', 'lab_order_cancelled') or lab_order_id is not null)),
  add constraint notification_jobs_in_app_check
    check ((channel = 'in_app') = (recipient_profile_id is not null)
           and (channel <> 'in_app' or recipient_type = 'staff')
           and (read_at is null or channel = 'in_app'));

create index notification_jobs_inbox_idx
  on public.notification_jobs (recipient_profile_id, created_at desc) where channel = 'in_app';

-- The Telegram worker never claims in-app rows. An optional clinic filter
-- lets a run work on given clinics only (the scheduler passes none: all).
drop function public.claim_due_notification_jobs(int);

create or replace function public.claim_due_notification_jobs(p_limit int, p_clinic_ids uuid[] default null)
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
    set status = 'in_progress'::public.notification_job_status,
        updated_at = now()
  where nj.id in (
    select id
    from public.notification_jobs
    where status = 'pending'::public.notification_job_status
      and channel = 'telegram'
      and scheduled_for <= now()
      and (p_clinic_ids is null or clinic_id = any (p_clinic_ids))
    order by scheduled_for asc
    limit p_limit
    for update skip locked
  )
  returning nj.*;
end;
$$;

revoke all on function public.claim_due_notification_jobs(int, uuid[]) from public, anon, authenticated;
grant execute on function public.claim_due_notification_jobs(int, uuid[]) to service_role;

-- ---------------------------------------------------------------------------
-- Settings and recipients
-- ---------------------------------------------------------------------------

-- A boolean lab setting; only an explicit JSON boolean counts, anything else is the default.
create or replace function public.lab_setting_bool(p_clinic_id uuid, p_key text, p_default boolean)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce((
    select case jsonb_typeof(s.value -> p_key) when 'boolean' then (s.value ->> p_key)::boolean end
    from public.app_settings s
    where s.clinic_id = p_clinic_id and s.key = 'lab'
  ), p_default);
$$;

revoke all on function public.lab_setting_bool(uuid, text, boolean) from public, anon, authenticated;

create or replace function public.lab_staff_with_roles(p_clinic_id uuid, p_roles public.staff_role[])
returns uuid[]
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(array_agg(distinct sr.profile_id), '{}')
  from public.staff_roles sr
  where sr.clinic_id = p_clinic_id and sr.role = any (p_roles);
$$;

revoke all on function public.lab_staff_with_roles(uuid, public.staff_role[]) from public, anon, authenticated;

-- The ordering doctor's account, while they are an active doctor of the clinic.
create or replace function public.lab_ordering_doctor_profile(p_order_id uuid)
returns uuid[]
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(array_agg(d.profile_id), '{}')
  from public.lab_orders o
  join public.doctors d on d.id = o.ordering_doctor_id and d.clinic_id = o.clinic_id and d.active and d.profile_id is not null
  where o.id = p_order_id
    and exists (select 1 from public.staff_roles sr where sr.clinic_id = o.clinic_id and sr.profile_id = d.profile_id and sr.role = 'doctor');
$$;

revoke all on function public.lab_ordering_doctor_profile(uuid) from public, anon, authenticated;

-- One in-app notification per recipient (never the actor), idempotent per event.
create or replace function public.lab_notify_staff(
  p_clinic_id uuid,
  p_type public.notification_job_type,
  p_event_key text,
  p_recipients uuid[],
  p_actor uuid,
  p_lab_order_id uuid,
  p_lab_result_id uuid
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if public.lab_clinic_is_being_erased(p_clinic_id) or not public.lab_setting_bool(p_clinic_id, 'notifyStaff', true) then
    return;
  end if;
  insert into public.notification_jobs
    (clinic_id, type, channel, recipient_type, recipient_profile_id, lab_order_id, lab_result_id,
     scheduled_for, status, sent_at, idempotency_key, max_attempts)
  select p_clinic_id, p_type, 'in_app', 'staff', r, p_lab_order_id, p_lab_result_id,
         now(), 'sent', now(), p_type::text || ':' || p_event_key || ':' || r::text, 1
  from (select distinct unnest(p_recipients) as r) recipients
  where r is not null and r is distinct from p_actor
    and exists (select 1 from public.staff_roles sr where sr.clinic_id = p_clinic_id and sr.profile_id = r)
  on conflict (idempotency_key) do nothing;
end;
$$;

revoke all on function public.lab_notify_staff(uuid, public.notification_job_type, text, uuid[], uuid, uuid, uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Events
-- ---------------------------------------------------------------------------

create or replace function public.lab_orders_notify()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_telegram bigint;
begin
  if new.source = 'external_import' then
    return null; -- historical data: not news
  end if;
  if tg_op = 'INSERT' then
    perform public.lab_notify_staff(new.clinic_id, 'lab_order_created', new.id::text,
      public.lab_staff_with_roles(new.clinic_id, array['lab']::public.staff_role[]), new.ordered_by, new.id, null);
    return null;
  end if;

  -- Cancelled.
  perform public.lab_notify_staff(new.clinic_id, 'lab_order_cancelled', new.id::text,
    public.lab_staff_with_roles(new.clinic_id, array['lab', 'owner', 'manager', 'admin']::public.staff_role[])
      || public.lab_ordering_doctor_profile(new.id),
    new.cancelled_by, new.id, null);

  if public.lab_setting_bool(new.clinic_id, 'notifyPatientOnCancel', false) then
    select p.telegram_user_id into v_telegram
    from public.patients p
    where p.id = public.patient_canonical_id(new.patient_id) and p.clinic_id = new.clinic_id;
    if v_telegram is not null then
      insert into public.notification_jobs (clinic_id, type, lab_order_id, patient_telegram_user_id, scheduled_for, idempotency_key)
      values (new.clinic_id, 'lab_order_cancelled', new.id, v_telegram, now(), 'lab_order_cancelled:' || new.id::text)
      on conflict (idempotency_key) do nothing;
    end if;
  end if;
  return null;
end;
$$;

revoke all on function public.lab_orders_notify() from public, anon, authenticated;

create trigger lab_orders_notify_created
  after insert on public.lab_orders
  for each row execute function public.lab_orders_notify();
create trigger lab_orders_notify_cancelled
  after update of status on public.lab_orders
  for each row when (new.status = 'cancelled' and old.status is distinct from new.status)
  execute function public.lab_orders_notify();

create or replace function public.lab_samples_notify()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.lab_notify_staff(new.clinic_id, 'lab_sample_collected', new.id::text,
    public.lab_staff_with_roles(new.clinic_id, array['lab']::public.staff_role[]), new.collected_by, new.order_id, null);
  return null;
end;
$$;

revoke all on function public.lab_samples_notify() from public, anon, authenticated;

create trigger lab_samples_notify
  after insert on public.lab_samples
  for each row execute function public.lab_samples_notify();

create or replace function public.lab_results_notify_staff()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order uuid;
  v_verifiers text;
  v_recipients uuid[] := '{}';
begin
  if new.source = 'import' then
    return null;
  end if;
  select i.order_id into v_order from public.lab_order_items i where i.id = new.order_item_id;

  if new.status = 'submitted' then
    -- Whoever may verify it (clinic setting), never its author or submitter.
    select coalesce(s.value ->> 'verifiers', 'lab_and_doctor') into v_verifiers
    from public.app_settings s where s.clinic_id = new.clinic_id and s.key = 'lab';
    v_verifiers := coalesce(v_verifiers, 'lab_and_doctor');
    if v_verifiers <> 'doctor_only' then
      v_recipients := v_recipients || public.lab_staff_with_roles(new.clinic_id, array['lab']::public.staff_role[]);
    end if;
    if v_verifiers <> 'lab_only' then
      v_recipients := v_recipients || public.lab_ordering_doctor_profile(v_order);
    end if;
    v_recipients := array_remove(v_recipients, new.entered_by);
    perform public.lab_notify_staff(new.clinic_id, 'lab_result_entered', new.id::text, v_recipients, new.submitted_by, v_order, new.id);
  elsif new.status = 'verified' then
    perform public.lab_notify_staff(new.clinic_id,
      case when new.supersedes_result_id is null then 'lab_result_verified'::public.notification_job_type else 'lab_result_corrected'::public.notification_job_type end,
      new.id::text, public.lab_ordering_doctor_profile(v_order), new.verified_by, v_order, new.id);
  end if;
  return null;
end;
$$;

revoke all on function public.lab_results_notify_staff() from public, anon, authenticated;

create trigger lab_results_notify_staff
  after update of status on public.lab_results
  for each row
  when (new.status in ('submitted', 'verified') and old.status is distinct from new.status)
  execute function public.lab_results_notify_staff();

-- =====================================================================
-- FILE: 20261005000020_lab_dashboards.sql
-- =====================================================================
-- Laboratory (Phase 17): role-specific dashboards.
--
-- The dashboards read the existing tables through the server (service role,
-- after the route's role check); nothing new is exposed to signed-in roles.
-- This migration adds:
--   * lab_doctor_accessible_patients(): which patients of a candidate set a
--     doctor may see — exactly doctor_patient_access() (own patient or an
--     active, unexpired referral), evaluated in the database for the whole
--     set, so the doctor's dashboard never widens a doctor's scope and never
--     relies on a list computed elsewhere;
--   * indexes for the dashboard reads (orders by date and by ordering doctor,
--     current verified results by time).

create or replace function public.lab_doctor_accessible_patients(p_clinic_id uuid, p_doctor_id uuid, p_patient_ids uuid[])
returns setof uuid
language plpgsql
stable
security invoker
set search_path = public, pg_temp
as $$
begin
  if cardinality(p_patient_ids) > 5000 then
    raise exception 'too many patients';
  end if;
  -- The doctor must be an active doctor of this clinic.
  if not exists (select 1 from public.doctors d where d.id = p_doctor_id and d.clinic_id = p_clinic_id and d.active) then
    return;
  end if;
  return query
  select p.id
  from (select distinct unnest(p_patient_ids) as id) p
  where p.id is not null
    and exists (
      select 1
      from public.doctor_patient_access(p_doctor_id, p.id) x
      where x.clinic_id = p_clinic_id
        and (x.own_patient or cardinality(x.active_referral_ids) > 0)
    );
end;
$$;

revoke all on function public.lab_doctor_accessible_patients(uuid, uuid, uuid[]) from public, anon, authenticated;
grant execute on function public.lab_doctor_accessible_patients(uuid, uuid, uuid[]) to service_role;

create index if not exists lab_orders_created_idx
  on public.lab_orders (clinic_id, created_at);
create index if not exists lab_orders_ordering_doctor_idx
  on public.lab_orders (clinic_id, ordering_doctor_id, created_at desc) where ordering_doctor_id is not null;
create index if not exists lab_results_verified_idx
  on public.lab_results (clinic_id, verified_at desc) where status = 'verified';

-- =====================================================================
-- FILE: 20261005000021_lab_security_hardening.sql
-- =====================================================================
-- Laboratory security review (Phase 17/19, docs/labs/SECURITY_REVIEW.md).
--
-- F1  TRUNCATE (and REFERENCES / TRIGGER) were granted to anon / authenticated
--     on several public tables by Supabase's default privileges — clinics,
--     staff_roles, doctors, profiles, services, app_settings, … TRUNCATE is
--     not subject to row level security: a session able to run SQL as
--     `authenticated` could empty a table for every clinic at once (e.g.
--     app_settings, resetting every clinic's lab settings to defaults —
--     releaseToPatient back to true). PostgREST cannot issue TRUNCATE, so it
--     was not reachable over HTTP, but the privilege must not exist. Revoked
--     on every table, and from the default privileges so new tables never get
--     it again. The same for MAINTAIN (PostgreSQL 17: LOCK TABLE, VACUUM, …).
--
-- F2  Server/RLS parity for money: the server shows payment amounts only to
--     the payment roles (owner, admin — canViewPaymentDynamics), but the
--     payments SELECT policies let managers, receptionists and doctors read
--     whole rows directly — amounts, provider references, payment links and
--     metadata of appointment AND lab payments. The browser only ever reads
--     payments(status). Signed-in roles now get the status columns only; every
--     amount is read through the server.

do $$
declare
  t record;
begin
  for t in
    select c.relname
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm', 'f')
  loop
    execute format('revoke truncate, references, trigger on public.%I from anon, authenticated', t.relname);
    -- PostgreSQL 17+: MAINTAIN (LOCK TABLE, VACUUM, REINDEX, …) likewise.
    if current_setting('server_version_num')::int >= 170000 then
      execute format('revoke maintain on public.%I from anon, authenticated', t.relname);
    end if;
  end loop;
  execute 'alter default privileges in schema public revoke truncate, references, trigger on tables from anon, authenticated';
  if current_setting('server_version_num')::int >= 170000 then
    execute 'alter default privileges in schema public revoke maintain on tables from anon, authenticated';
  end if;
end;
$$;

revoke select on public.payments from authenticated;
grant select (id, clinic_id, patient_id, appointment_id, lab_order_id, status) on public.payments to authenticated;

-- F4  Forged verification at the database level. The database required only
--     that the verifier is "a staff member of the clinic, not the enterer":
--     a server path (or anyone with the service role) could record a
--     receptionist, the owner or a doctor with no access to the patient as
--     the person who entered, submitted or verified a result. The server
--     (result.enter / result.verify + resolveLabResultAccess) never did, but
--     the rule now holds in the database too:
--       * whoever enters, submits or verifies a result is lab staff of the
--         clinic, or a doctor of the clinic whom doctor_patient_access()
--         admits to the patient;
--       * the verifier also matches the clinic's `verifiers` setting
--         (lab_and_doctor / lab_only / doctor_only).

create or replace function public.lab_result_handler_ok(p_clinic_id uuid, p_patient_id uuid, p_profile_id uuid, p_as text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with policy as (
    select coalesce((select s.value ->> 'verifiers' from public.app_settings s where s.clinic_id = p_clinic_id and s.key = 'lab'), 'lab_and_doctor') as verifiers
  )
  select
    (
      (p_as <> 'verifier' or (select verifiers from policy) <> 'doctor_only')
      and exists (select 1 from public.staff_roles sr where sr.clinic_id = p_clinic_id and sr.profile_id = p_profile_id and sr.role = 'lab')
    )
    or (
      (p_as <> 'verifier' or (select verifiers from policy) <> 'lab_only')
      and exists (
        select 1
        from public.staff_roles sr
        join public.doctors d on d.profile_id = sr.profile_id and d.clinic_id = sr.clinic_id and d.active
        cross join lateral public.doctor_patient_access(d.id, p_patient_id) x
        where sr.clinic_id = p_clinic_id and sr.profile_id = p_profile_id and sr.role = 'doctor'
          and x.clinic_id = p_clinic_id and (x.own_patient or cardinality(x.active_referral_ids) > 0)
      )
    );
$$;

revoke all on function public.lab_result_handler_ok(uuid, uuid, uuid, text) from public, anon, authenticated;

create or replace function public.lab_results_check_handlers()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'INSERT' then
    if not public.lab_result_handler_ok(new.clinic_id, new.patient_id, new.entered_by, 'enterer') then
      raise exception 'lab result: entered_by must be lab staff of the clinic or a doctor with access to the patient';
    end if;
    return new;
  end if;
  if new.status is distinct from old.status then
    if new.status = 'submitted' and not public.lab_result_handler_ok(new.clinic_id, new.patient_id, new.submitted_by, 'submitter') then
      raise exception 'lab result: submitted_by must be lab staff of the clinic or a doctor with access to the patient';
    end if;
    if new.status = 'verified' and not public.lab_result_handler_ok(new.clinic_id, new.patient_id, new.verified_by, 'verifier') then
      raise exception 'lab_result_verifier_not_allowed: the verifier may not verify this result (role, access or the clinic''s verifier setting)';
    end if;
  end if;
  return new;
end;
$$;

revoke all on function public.lab_results_check_handlers() from public, anon, authenticated;

drop trigger if exists lab_results_check_handlers on public.lab_results;
create trigger lab_results_check_handlers
  before insert or update of status on public.lab_results
  for each row execute function public.lab_results_check_handlers();

-- =====================================================================
-- FILE: 20261007000001_operations_enums.sql
-- =====================================================================
-- Outpatient pilot enum values: a cashier staff role, distinct from reception,
-- and the queue-ticket notification.
--
-- Owner decision 2026-10-07 (docs/decisions/2026-10-07-retention-tenancy-refunds.md):
-- registration and cash collection are separate permissions even when a small
-- clinic gives both to one person; a cashier may refund only with a grant from
-- a manager or the owner (20261007000002).
--
-- An enum value cannot be used in the transaction that adds it, so it has its
-- own migration. Placed after 'receptionist' so the role order stays
-- owner, manager, admin, receptionist, cashier, lab, doctor.

alter type public.staff_role add value if not exists 'cashier' after 'receptionist';

-- The patient's digital queue ticket (no paper talon, owner 2026-10-07): sent
-- to the patient's own verified Telegram chat when a walk-in visit is queued
-- (20261007000002). Delivered by the existing notification worker, which
-- records the real delivery status.
alter type public.notification_job_type add value if not exists 'queue_ticket';

-- New enum values must be committed before any later statement uses them.
commit;

-- =====================================================================
-- FILE: 20261007000002_outpatient_operations.sql
-- =====================================================================
-- Outpatient pilot: walk-in arrivals, itemized charges, the kassa ledger,
-- refund grants, the digital queue and doctor access through a visit.
--
-- Requirements: docs/PILOT_PLAN.md; owner decisions 2026-10-07
-- (docs/decisions/2026-10-07-retention-tenancy-refunds.md and the pilot answers):
--   * reception registers an arrival; the patient pays at the kassa; the queue
--     number is issued on FULL payment (cash and card terminal may be split;
--     no partial payment / debt until the clinic sets a rule). A free visit is
--     queued at once. `clinics.queue_after_payment = false` queues at
--     registration instead.
--   * registration and cash collection are separate roles (receptionist /
--     cashier); refunds: owner or manager, or a cashier holding an active
--     grant from one of them; admin may not refund; partial refunds with a
--     reason; who authorized and who executed are both recorded.
--   * a queue ticket is not an appointment and promises no time. Unfinished
--     visits stay in the queue across midnight; the number keeps its day.
--   * money is append-only: charges are voided (never edited), collections and
--     refunds are ledger rows that cannot change. Two printed receipts are
--     never two payments: a collection is one row per method per request.
--   * no paper talon: the patient's own Telegram chat gets the ticket
--     (notification 'queue_ticket'); a waiting-room screen shows numbers.
--   * a walk-in consultation reuses the booking engine
--     (start_walk_in_consultation) so clinical records keep their authorship
--     rules; its auto-created appointment bill is removed in the same
--     transaction because the visit's charges are the bill.
--   * a referral gives the receiving doctor the referring doctor's history
--     at once (pending included) — no accept/start step is needed to read.
--
-- Every write goes through a SECURITY DEFINER function callable only by the
-- service role, which re-checks the actor's role in the clinic. Signed-in
-- roles get no table access (RLS on, no policies).

-- ---------------------------------------------------------------------------
-- Clinic operating settings
-- ---------------------------------------------------------------------------

alter table public.clinics
  add column operating_mode text not null default 'walk_in'
    check (operating_mode in ('walk_in', 'scheduled', 'mixed')),
  add column queue_after_payment boolean not null default true;

-- Existing clinics take bookings today: keep them working alongside walk-ins.
update public.clinics set operating_mode = 'mixed';

comment on column public.clinics.operating_mode is
  'walk_in (default for new clinics) | scheduled | mixed. Reception screens and the bot follow it.';
comment on column public.clinics.queue_after_payment is
  'true (owner decision 2026-10-07): a walk-in gets a queue number when the bill is fully paid; false: at registration.';

-- ---------------------------------------------------------------------------
-- Patient number (per clinic, human-readable, never reused)
-- ---------------------------------------------------------------------------

create table public.clinic_counters (
  clinic_id uuid not null references public.clinics(id) on delete cascade,
  name text not null,
  value bigint not null,
  primary key (clinic_id, name)
);
alter table public.clinic_counters enable row level security;
revoke all on public.clinic_counters from anon, authenticated;

alter table public.patients add column patient_number bigint;

with numbered as (
  select id, row_number() over (partition by clinic_id order by created_at, id) as n
  from public.patients
)
update public.patients p set patient_number = numbered.n from numbered where numbered.id = p.id;

insert into public.clinic_counters (clinic_id, name, value)
select clinic_id, 'patient_number', max(patient_number) from public.patients group by clinic_id;

create or replace function public.patients_assign_number()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'INSERT' then
    insert into public.clinic_counters as c (clinic_id, name, value)
    values (new.clinic_id, 'patient_number', 1)
    on conflict (clinic_id, name) do update set value = c.value + 1
    returning c.value into new.patient_number;
  elsif new.patient_number is distinct from old.patient_number then
    raise exception 'patients: patient_number cannot change' using errcode = '42501';
  end if;
  return new;
end;
$$;
revoke all on function public.patients_assign_number() from public, anon, authenticated;

create trigger patients_assign_number
  before insert or update of patient_number on public.patients
  for each row execute function public.patients_assign_number();

alter table public.patients alter column patient_number set not null;
create unique index patients_clinic_patient_number_key on public.patients (clinic_id, patient_number);

comment on column public.patients.patient_number is
  'Per-clinic patient number for reception and queue screens. Assigned on insert, never changed or reused.';

-- ---------------------------------------------------------------------------
-- Visits (arrivals)
-- ---------------------------------------------------------------------------

create table public.visits (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete restrict,
  patient_id uuid not null,
  doctor_id uuid not null,
  status text not null default 'awaiting_payment'
    check (status in ('awaiting_payment', 'waiting', 'called', 'in_progress', 'completed', 'cancelled')),
  queue_date date,
  queue_number integer check (queue_number > 0),
  arrived_at timestamptz not null default now(),
  queued_at timestamptz,
  called_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  cancelled_at timestamptz,
  cancel_reason text,
  appointment_id uuid,
  created_by uuid not null references public.profiles(id),
  idempotency_key uuid not null,
  request_fingerprint text not null,
  updated_at timestamptz not null default now(),
  constraint visits_patient_fkey foreign key (patient_id, clinic_id) references public.patients (id, clinic_id) on delete restrict,
  constraint visits_doctor_fkey foreign key (doctor_id, clinic_id) references public.doctors (id, clinic_id) on delete restrict,
  constraint visits_appointment_fkey foreign key (appointment_id, clinic_id) references public.appointments (id, clinic_id) on delete restrict,
  constraint visits_queue_pair_check check ((queue_date is null) = (queue_number is null) and (queue_number is null) = (queued_at is null)),
  constraint visits_queued_status_check check (status in ('awaiting_payment', 'cancelled') or queue_number is not null),
  constraint visits_cancel_check check ((status = 'cancelled') = (cancelled_at is not null) and (status <> 'cancelled' or char_length(btrim(cancel_reason)) between 3 and 500)),
  constraint visits_clinic_day_number_key unique (clinic_id, queue_date, queue_number),
  constraint visits_idempotency_key unique (clinic_id, idempotency_key),
  constraint visits_id_clinic_id_key unique (id, clinic_id),
  constraint visits_id_clinic_patient_key unique (id, clinic_id, patient_id)
);

alter table public.visits enable row level security;
revoke all on public.visits from anon, authenticated;

create index visits_open_queue_idx on public.visits (clinic_id, status, queue_date, queue_number)
  where status in ('awaiting_payment', 'waiting', 'called', 'in_progress');
create index visits_doctor_idx on public.visits (clinic_id, doctor_id, status);
create index visits_patient_idx on public.visits (clinic_id, patient_id, arrived_at desc);
create unique index visits_appointment_key on public.visits (appointment_id) where appointment_id is not null;

comment on table public.visits is
  'A walk-in arrival. Not an appointment and not a promise of a time: queue_number is arrival order for the clinic day, issued on full payment (or at registration, per clinic). Written only by the outpatient RPCs.';

-- ---------------------------------------------------------------------------
-- Charges (itemized, price snapshot, void instead of edit)
-- ---------------------------------------------------------------------------

create table public.visit_charges (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete restrict,
  visit_id uuid not null,
  patient_id uuid not null,
  service_id uuid not null,
  service_name text not null,
  unit_price numeric(12, 2) not null check (unit_price >= 0),
  quantity integer not null default 1 check (quantity between 1 and 99),
  amount numeric(12, 2) not null check (amount >= 0),
  currency text not null,
  status text not null default 'active' check (status in ('active', 'voided')),
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now(),
  idempotency_key uuid,
  voided_by uuid references public.profiles(id),
  voided_at timestamptz,
  void_reason text,
  constraint visit_charges_visit_fkey foreign key (visit_id, clinic_id, patient_id) references public.visits (id, clinic_id, patient_id) on delete restrict,
  constraint visit_charges_service_fkey foreign key (service_id, clinic_id) references public.services (id, clinic_id) on delete restrict,
  constraint visit_charges_amount_total_check check (amount = unit_price * quantity),
  constraint visit_charges_void_check check (
    (status = 'voided') = (voided_at is not null)
    and (status = 'voided') = (voided_by is not null)
    and (status <> 'voided' or char_length(btrim(void_reason)) between 3 and 500)
  )
);

alter table public.visit_charges enable row level security;
revoke all on public.visit_charges from anon, authenticated;
create index visit_charges_visit_idx on public.visit_charges (visit_id, created_at);
create unique index visit_charges_idempotency_key on public.visit_charges (clinic_id, idempotency_key) where idempotency_key is not null;

create or replace function public.visit_charges_guard()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'visit charges are never deleted; void them' using errcode = '42501';
  end if;
  -- The only change: active → voided, with who/when/why. Everything else is fixed.
  if old.status = 'active' and new.status = 'voided'
     and (new.id, new.clinic_id, new.visit_id, new.patient_id, new.service_id, new.service_name, new.unit_price,
          new.quantity, new.amount, new.currency, new.created_by, new.created_at, new.idempotency_key)
         is not distinct from
         (old.id, old.clinic_id, old.visit_id, old.patient_id, old.service_id, old.service_name, old.unit_price,
          old.quantity, old.amount, old.currency, old.created_by, old.created_at, old.idempotency_key) then
    return new;
  end if;
  raise exception 'visit charges cannot be changed; void and add a new line' using errcode = '42501';
end;
$$;

create trigger visit_charges_guard
  before update or delete on public.visit_charges
  for each row execute function public.visit_charges_guard();

-- ---------------------------------------------------------------------------
-- The kassa ledger (append-only)
-- ---------------------------------------------------------------------------

create table public.visit_transactions (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete restrict,
  visit_id uuid not null,
  patient_id uuid not null,
  kind text not null check (kind in ('collection', 'refund')),
  method text not null check (method in ('cash', 'terminal')),
  amount numeric(12, 2) not null check (amount > 0),
  currency text not null,
  reason text,
  executed_by uuid not null references public.profiles(id),
  authorized_by uuid not null references public.profiles(id),
  refund_grant_id uuid,
  request_key uuid not null,
  request_fingerprint text not null,
  created_at timestamptz not null default now(),
  constraint visit_transactions_visit_fkey foreign key (visit_id, clinic_id, patient_id) references public.visits (id, clinic_id, patient_id) on delete restrict,
  constraint visit_transactions_reason_check check (kind <> 'refund' or char_length(btrim(reason)) between 3 and 500),
  constraint visit_transactions_collection_check check (kind <> 'collection' or (reason is null and refund_grant_id is null and authorized_by = executed_by)),
  constraint visit_transactions_request_key unique (clinic_id, request_key, method)
);

alter table public.visit_transactions enable row level security;
revoke all on public.visit_transactions from anon, authenticated;
create index visit_transactions_visit_idx on public.visit_transactions (visit_id, created_at);
create index visit_transactions_clinic_time_idx on public.visit_transactions (clinic_id, created_at);

create or replace function public.visit_transactions_append_only()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  raise exception 'the kassa ledger is append-only; record a refund instead' using errcode = '42501';
end;
$$;

create trigger visit_transactions_append_only
  before update or delete on public.visit_transactions
  for each row execute function public.visit_transactions_append_only();

comment on table public.visit_transactions is
  'Money actually received (collection) or paid back (refund) at the kassa, by method. Append-only. Collected money is not revenue or profit; charges are in visit_charges.';

-- ---------------------------------------------------------------------------
-- Refund grants (manager/owner → named cashier)
-- ---------------------------------------------------------------------------

create table public.refund_grants (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete restrict,
  profile_id uuid not null references public.profiles(id),
  granted_by uuid not null references public.profiles(id),
  granted_at timestamptz not null default now(),
  revoked_by uuid references public.profiles(id),
  revoked_at timestamptz,
  revoke_reason text,
  constraint refund_grants_revoke_check check (
    (revoked_at is null) = (revoked_by is null)
    and (revoked_at is null or char_length(btrim(revoke_reason)) between 3 and 500)
  ),
  constraint refund_grants_id_clinic_id_key unique (id, clinic_id)
);

alter table public.refund_grants enable row level security;
revoke all on public.refund_grants from anon, authenticated;
create unique index refund_grants_active_key on public.refund_grants (clinic_id, profile_id) where revoked_at is null;

alter table public.visit_transactions
  add constraint visit_transactions_grant_fkey foreign key (refund_grant_id, clinic_id) references public.refund_grants (id, clinic_id);

create or replace function public.refund_grants_guard()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'refund grants are revoked, never deleted' using errcode = '42501';
  end if;
  if old.revoked_at is null and new.revoked_at is not null
     and (new.id, new.clinic_id, new.profile_id, new.granted_by, new.granted_at)
         is not distinct from (old.id, old.clinic_id, old.profile_id, old.granted_by, old.granted_at) then
    return new;
  end if;
  raise exception 'a refund grant can only be revoked' using errcode = '42501';
end;
$$;

create trigger refund_grants_guard
  before update or delete on public.refund_grants
  for each row execute function public.refund_grants_guard();

-- ---------------------------------------------------------------------------
-- Queue-ticket notifications
-- ---------------------------------------------------------------------------

alter table public.notification_jobs add column visit_id uuid;
alter table public.notification_jobs
  add constraint notification_jobs_visit_fkey
    foreign key (visit_id, clinic_id) references public.visits (id, clinic_id) on delete cascade,
  add constraint notification_jobs_visit_check
    check ((type = 'queue_ticket') = (visit_id is not null));

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

-- The actor must hold one of the roles in an active clinic.
create or replace function public.ops_require_role(p_clinic uuid, p_actor uuid, p_roles public.staff_role[])
returns void
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if p_actor is null or not exists (
    select 1 from public.staff_roles sr
    join public.clinics c on c.id = sr.clinic_id and c.is_active
    where sr.clinic_id = p_clinic and sr.profile_id = p_actor and sr.role = any (p_roles)
  ) then
    raise exception using message = 'operations: not allowed', errcode = '42501', hint = 'forbidden';
  end if;
end;
$$;

create or replace function public.ops_has_role(p_clinic uuid, p_actor uuid, p_roles public.staff_role[])
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.staff_roles sr
    where sr.clinic_id = p_clinic and sr.profile_id = p_actor and sr.role = any (p_roles)
  );
$$;

-- What a visit owes and has been paid, overall and per method.
create or replace function public.visit_balance(p_visit uuid)
returns table (
  charged numeric,
  collected numeric,
  refunded numeric,
  outstanding numeric,
  cash_net numeric,
  terminal_net numeric
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with c as (
    select coalesce(sum(amount) filter (where status = 'active'), 0) as charged
    from public.visit_charges where visit_id = p_visit
  ), t as (
    select
      coalesce(sum(amount) filter (where kind = 'collection'), 0) as collected,
      coalesce(sum(amount) filter (where kind = 'refund'), 0) as refunded,
      coalesce(sum(case when kind = 'collection' then amount else -amount end) filter (where method = 'cash'), 0) as cash_net,
      coalesce(sum(case when kind = 'collection' then amount else -amount end) filter (where method = 'terminal'), 0) as terminal_net
    from public.visit_transactions where visit_id = p_visit
  )
  select c.charged, t.collected, t.refunded, c.charged - t.collected + t.refunded, t.cash_net, t.terminal_net
  from c, t;
$$;

-- Give a visit the next number of the clinic's current day. Callers hold the
-- visit row lock; the advisory lock serializes numbering across the clinic.
create or replace function public.visit_enqueue(p_visit uuid)
returns public.visits
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v public.visits;
  v_date date;
  v_number integer;
  v_tg bigint;
begin
  select * into v from public.visits where id = p_visit for update;
  if v.queue_number is not null then
    return v;
  end if;
  perform pg_advisory_xact_lock(hashtextextended('visit-queue:' || v.clinic_id::text, 0));
  select (now() at time zone c.timezone)::date into v_date from public.clinics c where c.id = v.clinic_id;
  select coalesce(max(queue_number), 0) + 1 into v_number
    from public.visits where clinic_id = v.clinic_id and queue_date = v_date;
  update public.visits
     set status = case when status = 'awaiting_payment' then 'waiting' else status end,
         queue_date = v_date, queue_number = v_number, queued_at = now(), updated_at = now()
   where id = v.id
  returning * into v;

  -- The digital ticket, to the patient's own verified Telegram chat only.
  select p.telegram_user_id into v_tg from public.patients p where p.id = v.patient_id;
  if v_tg is not null then
    insert into public.notification_jobs (clinic_id, visit_id, type, patient_telegram_user_id, scheduled_for, idempotency_key)
    values (v.clinic_id, v.id, 'queue_ticket', v_tg, now(), 'queue_ticket:' || v.id::text)
    on conflict (idempotency_key) do nothing;
  end if;
  return v;
end;
$$;

-- ---------------------------------------------------------------------------
-- Registration
-- ---------------------------------------------------------------------------

create or replace function public.register_arrival(
  p_clinic uuid,
  p_actor uuid,
  p_key uuid,
  p_patient uuid,
  p_new_patient jsonb,
  p_doctor uuid,
  p_service_ids uuid[]
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v public.visits;
  v_patient uuid := p_patient;
  v_fingerprint text;
  v_clinic public.clinics;
  v_name text;
  v_phone text;
  v_dob date;
  v_doc text;
  v_pinfl text;
  v_match uuid;
  v_service uuid;
  v_total numeric := 0;
  v_count int;
begin
  perform public.ops_require_role(p_clinic, p_actor, array['owner', 'manager', 'admin', 'receptionist']::public.staff_role[]);
  if p_key is null then
    raise exception using message = 'operations: request key required', errcode = '22023', hint = 'invalid_request';
  end if;

  v_fingerprint := md5(jsonb_build_array(
    p_actor, p_patient, p_new_patient, p_doctor,
    (select coalesce(jsonb_agg(x order by x), '[]'::jsonb) from unnest(p_service_ids) x)
  )::text);

  -- Serialize registrations of one clinic (patient creation, duplicate checks, retries).
  perform pg_advisory_xact_lock(hashtextextended('visit-register:' || p_clinic::text, 0));

  select * into v from public.visits where clinic_id = p_clinic and idempotency_key = p_key;
  if found then
    if v.request_fingerprint <> v_fingerprint then
      raise exception using message = 'operations: request key reused for a different request', errcode = '22023', hint = 'idempotency_conflict';
    end if;
    return jsonb_build_object('visit_id', v.id, 'replayed', true);
  end if;

  select * into v_clinic from public.clinics where id = p_clinic;

  if not exists (select 1 from public.doctors d where d.id = p_doctor and d.clinic_id = p_clinic and d.active) then
    raise exception using message = 'operations: doctor unavailable', errcode = '22023', hint = 'doctor_not_found';
  end if;

  select count(*) into v_count from (select distinct x from unnest(p_service_ids) x where x is not null) s;
  if v_count = 0 or v_count > 10 or v_count <> coalesce(array_length(p_service_ids, 1), 0) then
    raise exception using message = 'operations: choose 1 to 10 different services', errcode = '22023', hint = 'invalid_services';
  end if;
  foreach v_service in array p_service_ids loop
    if not exists (select 1 from public.services s where s.id = v_service and s.clinic_id = p_clinic and s.active) then
      raise exception using message = 'operations: service unavailable', errcode = '22023', hint = 'service_not_found';
    end if;
    if exists (select 1 from public.doctor_services where doctor_id = p_doctor)
       and not exists (select 1 from public.doctor_services where doctor_id = p_doctor and service_id = v_service) then
      raise exception using message = 'operations: service not offered by this doctor', errcode = '22023', hint = 'service_not_offered';
    end if;
  end loop;

  if (v_patient is null) = (p_new_patient is null) then
    raise exception using message = 'operations: choose an existing patient or describe a new one', errcode = '22023', hint = 'invalid_patient';
  end if;

  if v_patient is not null then
    if not exists (select 1 from public.patients where id = v_patient and clinic_id = p_clinic) then
      raise exception using message = 'operations: patient not found', errcode = '22023', hint = 'patient_not_found';
    end if;
    if exists (select 1 from public.patients where id = v_patient and merged_into_patient_id is not null) then
      raise exception using message = 'operations: this record was merged; use the main record', errcode = '22023', hint = 'patient_merged';
    end if;
  else
    v_name := btrim(p_new_patient ->> 'full_name');
    v_phone := nullif(btrim(p_new_patient ->> 'phone'), '');
    v_doc := public.normalize_identity_document(p_new_patient ->> 'document_number');
    v_pinfl := public.normalize_identity_document(p_new_patient ->> 'pinfl');
    begin
      v_dob := nullif(p_new_patient ->> 'date_of_birth', '')::date;
    exception when others then
      raise exception using message = 'operations: invalid date of birth', errcode = '22023', hint = 'invalid_patient';
    end;
    if v_name is null or char_length(v_name) not between 2 and 120 then
      raise exception using message = 'operations: patient name required', errcode = '22023', hint = 'invalid_patient';
    end if;
    if v_dob is null then
      raise exception using message = 'operations: date of birth required', errcode = '22023', hint = 'invalid_patient';
    end if;
    if v_phone is not null and v_phone !~ '^\+?[0-9 ()-]{7,24}$' then
      raise exception using message = 'operations: invalid phone', errcode = '22023', hint = 'invalid_patient';
    end if;
    -- Never create a second record for someone the clinic already knows.
    select id into v_match from public.patients
     where clinic_id = p_clinic and merged_into_patient_id is null
       and ((v_pinfl is not null and pinfl = v_pinfl)
         or (v_doc is not null and document_number = v_doc)
         or (date_of_birth = v_dob and lower(btrim(full_name)) = lower(v_name)))
     order by created_at limit 1;
    if v_match is not null then
      raise exception using message = 'operations: this patient is already registered', errcode = '22023',
        hint = 'patient_exists', detail = v_match::text;
    end if;
    insert into public.patients (clinic_id, full_name, phone, date_of_birth, sex, document_number, pinfl)
    values (p_clinic, v_name, v_phone, v_dob, nullif(p_new_patient ->> 'sex', '')::public.patient_sex, v_doc, v_pinfl)
    returning id into v_patient;
  end if;

  if exists (
    select 1 from public.visits
     where clinic_id = p_clinic and patient_id = v_patient and doctor_id = p_doctor
       and status in ('awaiting_payment', 'waiting', 'called', 'in_progress')
  ) then
    raise exception using message = 'operations: this patient is already registered with this doctor', errcode = '22023', hint = 'already_registered';
  end if;

  insert into public.visits (clinic_id, patient_id, doctor_id, created_by, idempotency_key, request_fingerprint)
  values (p_clinic, v_patient, p_doctor, p_actor, p_key, v_fingerprint)
  returning * into v;

  insert into public.visit_charges (clinic_id, visit_id, patient_id, service_id, service_name, unit_price, quantity, amount, currency, created_by)
  select p_clinic, v.id, v_patient, s.id, s.name, coalesce(ds.price_override, s.price), 1, coalesce(ds.price_override, s.price), v_clinic.currency, p_actor
    from unnest(p_service_ids) with ordinality as u(service_id, ord)
    join public.services s on s.id = u.service_id
    left join public.doctor_services ds on ds.doctor_id = p_doctor and ds.service_id = s.id
   order by u.ord;

  select sum(amount) into v_total from public.visit_charges where visit_id = v.id;

  if not v_clinic.queue_after_payment or v_total = 0 then
    v := public.visit_enqueue(v.id);
  end if;

  insert into public.audit_events (clinic_id, actor_id, actor_type, action, entity_type, entity_id, new_values)
  values (p_clinic, p_actor, 'staff', 'visit_registered', 'visits', v.id::text,
          jsonb_build_object('patient_id', v_patient, 'doctor_id', p_doctor, 'charge_total', v_total, 'new_patient', p_patient is null));

  return jsonb_build_object('visit_id', v.id, 'replayed', false);
end;
$$;

-- ---------------------------------------------------------------------------
-- Kassa: collection (full payment, cash/terminal split)
-- ---------------------------------------------------------------------------

create or replace function public.record_visit_payment(
  p_clinic uuid,
  p_actor uuid,
  p_visit uuid,
  p_key uuid,
  p_lines jsonb,
  p_expected_outstanding numeric
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v public.visits;
  b record;
  v_fingerprint text;
  v_line jsonb;
  v_sum numeric := 0;
  v_methods text[] := '{}';
  v_method text;
  v_amount numeric;
  v_currency text;
begin
  perform public.ops_require_role(p_clinic, p_actor, array['owner', 'manager', 'admin', 'cashier']::public.staff_role[]);
  if p_key is null or jsonb_typeof(p_lines) <> 'array' then
    raise exception using message = 'operations: invalid payment request', errcode = '22023', hint = 'invalid_request';
  end if;
  v_fingerprint := md5(jsonb_build_array(p_actor, p_visit, p_lines, p_expected_outstanding)::text);

  select * into v from public.visits where id = p_visit and clinic_id = p_clinic for update;
  if not found then
    raise exception using message = 'operations: visit not found', errcode = '22023', hint = 'visit_not_found';
  end if;

  -- A retry of the same request returns what it recorded.
  if exists (select 1 from public.visit_transactions where clinic_id = p_clinic and request_key = p_key) then
    if exists (select 1 from public.visit_transactions where clinic_id = p_clinic and request_key = p_key
                and (request_fingerprint <> v_fingerprint or visit_id <> p_visit)) then
      raise exception using message = 'operations: request key reused for a different request', errcode = '22023', hint = 'idempotency_conflict';
    end if;
    return jsonb_build_object('visit_id', v.id, 'replayed', true);
  end if;

  if v.status = 'cancelled' then
    raise exception using message = 'operations: the visit was cancelled', errcode = '22023', hint = 'visit_cancelled';
  end if;

  select * into b from public.visit_balance(v.id);
  if p_expected_outstanding is null or b.outstanding <> p_expected_outstanding then
    raise exception using message = 'operations: the bill changed; refresh', errcode = '40001', hint = 'stale';
  end if;
  if b.outstanding <= 0 then
    raise exception using message = 'operations: nothing to pay', errcode = '22023', hint = 'nothing_due';
  end if;

  if jsonb_array_length(p_lines) not between 1 and 2 then
    raise exception using message = 'operations: one or two payment methods', errcode = '22023', hint = 'invalid_request';
  end if;
  for v_line in select * from jsonb_array_elements(p_lines) loop
    v_method := v_line ->> 'method';
    begin
      v_amount := (v_line ->> 'amount')::numeric;
    exception when others then
      v_amount := null;
    end;
    if v_method not in ('cash', 'terminal') or v_method = any (v_methods)
       or v_amount is null or v_amount <= 0 or v_amount <> round(v_amount, 2) then
      raise exception using message = 'operations: invalid payment line', errcode = '22023', hint = 'invalid_request';
    end if;
    v_methods := v_methods || v_method;
    v_sum := v_sum + v_amount;
  end loop;

  -- Full payment only (owner decision): the lines must settle the bill exactly.
  if v_sum <> b.outstanding then
    raise exception using message = 'operations: the payment must equal the amount due', errcode = '22023', hint = 'amount_mismatch';
  end if;

  select currency into v_currency from public.clinics where id = p_clinic;
  insert into public.visit_transactions (clinic_id, visit_id, patient_id, kind, method, amount, currency, executed_by, authorized_by, request_key, request_fingerprint)
  select p_clinic, v.id, v.patient_id, 'collection', l ->> 'method', (l ->> 'amount')::numeric, v_currency, p_actor, p_actor, p_key, v_fingerprint
    from jsonb_array_elements(p_lines) l;

  if v.queue_number is null then
    v := public.visit_enqueue(v.id);
  end if;

  insert into public.audit_events (clinic_id, actor_id, actor_type, action, entity_type, entity_id, new_values)
  values (p_clinic, p_actor, 'staff', 'visit_payment_recorded', 'visits', v.id::text,
          jsonb_build_object('amount', v_sum, 'methods', to_jsonb(v_methods), 'queue_number', v.queue_number));

  return jsonb_build_object('visit_id', v.id, 'replayed', false, 'queue_number', v.queue_number);
end;
$$;

-- ---------------------------------------------------------------------------
-- Kassa: refunds
-- ---------------------------------------------------------------------------

create or replace function public.refund_visit_payment(
  p_clinic uuid,
  p_actor uuid,
  p_visit uuid,
  p_key uuid,
  p_method text,
  p_amount numeric,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v public.visits;
  b record;
  v_fingerprint text;
  v_grant public.refund_grants;
  v_authorized uuid;
  v_available numeric;
  v_currency text;
begin
  perform public.ops_require_role(p_clinic, p_actor, array['owner', 'manager', 'cashier']::public.staff_role[]);
  if p_key is null then
    raise exception using message = 'operations: request key required', errcode = '22023', hint = 'invalid_request';
  end if;
  v_fingerprint := md5(jsonb_build_array(p_actor, p_visit, p_method, p_amount, p_reason)::text);

  select * into v from public.visits where id = p_visit and clinic_id = p_clinic for update;
  if not found then
    raise exception using message = 'operations: visit not found', errcode = '22023', hint = 'visit_not_found';
  end if;

  if exists (select 1 from public.visit_transactions where clinic_id = p_clinic and request_key = p_key) then
    if exists (select 1 from public.visit_transactions where clinic_id = p_clinic and request_key = p_key
                and (request_fingerprint <> v_fingerprint or visit_id <> p_visit)) then
      raise exception using message = 'operations: request key reused for a different request', errcode = '22023', hint = 'idempotency_conflict';
    end if;
    return jsonb_build_object('visit_id', v.id, 'replayed', true);
  end if;

  -- Owner and manager refund on their own authority; a cashier only under an
  -- active grant, which records who authorized it.
  if public.ops_has_role(p_clinic, p_actor, array['owner', 'manager']::public.staff_role[]) then
    v_authorized := p_actor;
  else
    select * into v_grant from public.refund_grants
     where clinic_id = p_clinic and profile_id = p_actor and revoked_at is null;
    if not found then
      raise exception using message = 'operations: refunds need a manager''s permission', errcode = '42501', hint = 'refund_not_permitted';
    end if;
    v_authorized := v_grant.granted_by;
  end if;

  if p_method not in ('cash', 'terminal') or p_amount is null or p_amount <= 0 or p_amount <> round(p_amount, 2) then
    raise exception using message = 'operations: invalid refund', errcode = '22023', hint = 'invalid_request';
  end if;
  if p_reason is null or char_length(btrim(p_reason)) not between 3 and 500 then
    raise exception using message = 'operations: a refund needs a reason', errcode = '22023', hint = 'reason_required';
  end if;

  select * into b from public.visit_balance(v.id);
  v_available := case when p_method = 'cash' then b.cash_net else b.terminal_net end;
  if p_amount > v_available then
    raise exception using message = 'operations: refund larger than what was paid by this method', errcode = '22023', hint = 'refund_exceeds_paid';
  end if;

  select currency into v_currency from public.clinics where id = p_clinic;
  insert into public.visit_transactions (clinic_id, visit_id, patient_id, kind, method, amount, currency, reason,
                                         executed_by, authorized_by, refund_grant_id, request_key, request_fingerprint)
  values (p_clinic, v.id, v.patient_id, 'refund', p_method, p_amount, v_currency, btrim(p_reason),
          p_actor, v_authorized, v_grant.id, p_key, v_fingerprint);

  insert into public.audit_events (clinic_id, actor_id, actor_type, action, entity_type, entity_id, new_values)
  values (p_clinic, p_actor, 'staff', 'visit_refund_recorded', 'visits', v.id::text,
          jsonb_build_object('amount', p_amount, 'method', p_method, 'authorized_by', v_authorized, 'refund_grant_id', v_grant.id));

  return jsonb_build_object('visit_id', v.id, 'replayed', false);
end;
$$;

create or replace function public.grant_refund_permission(p_clinic uuid, p_actor uuid, p_cashier uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  g public.refund_grants;
begin
  perform public.ops_require_role(p_clinic, p_actor, array['owner', 'manager']::public.staff_role[]);
  if not public.ops_has_role(p_clinic, p_cashier, array['cashier']::public.staff_role[]) then
    raise exception using message = 'operations: only a cashier can be given refund permission', errcode = '22023', hint = 'not_a_cashier';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('refund-grant:' || p_clinic::text || p_cashier::text, 0));
  select * into g from public.refund_grants where clinic_id = p_clinic and profile_id = p_cashier and revoked_at is null;
  if found then
    return jsonb_build_object('grant_id', g.id, 'replayed', true);
  end if;
  insert into public.refund_grants (clinic_id, profile_id, granted_by) values (p_clinic, p_cashier, p_actor) returning * into g;
  insert into public.audit_events (clinic_id, actor_id, actor_type, action, entity_type, entity_id, new_values)
  values (p_clinic, p_actor, 'staff', 'refund_grant_given', 'refund_grants', g.id::text, jsonb_build_object('profile_id', p_cashier));
  return jsonb_build_object('grant_id', g.id, 'replayed', false);
end;
$$;

create or replace function public.revoke_refund_permission(p_clinic uuid, p_actor uuid, p_cashier uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  g public.refund_grants;
begin
  perform public.ops_require_role(p_clinic, p_actor, array['owner', 'manager']::public.staff_role[]);
  if p_reason is null or char_length(btrim(p_reason)) not between 3 and 500 then
    raise exception using message = 'operations: a reason is required', errcode = '22023', hint = 'reason_required';
  end if;
  update public.refund_grants set revoked_by = p_actor, revoked_at = now(), revoke_reason = btrim(p_reason)
   where clinic_id = p_clinic and profile_id = p_cashier and revoked_at is null
  returning * into g;
  if not found then
    raise exception using message = 'operations: no active permission', errcode = '22023', hint = 'grant_not_found';
  end if;
  insert into public.audit_events (clinic_id, actor_id, actor_type, action, entity_type, entity_id, new_values)
  values (p_clinic, p_actor, 'staff', 'refund_grant_revoked', 'refund_grants', g.id::text, jsonb_build_object('profile_id', p_cashier));
  return jsonb_build_object('grant_id', g.id);
end;
$$;

-- ---------------------------------------------------------------------------
-- Charges: add / void (corrections)
-- ---------------------------------------------------------------------------

create or replace function public.add_visit_charge(p_clinic uuid, p_actor uuid, p_visit uuid, p_service uuid, p_key uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v public.visits;
  c public.visit_charges;
  v_price numeric;
  v_name text;
begin
  perform public.ops_require_role(p_clinic, p_actor, array['owner', 'manager', 'admin', 'receptionist', 'cashier']::public.staff_role[]);
  if p_key is null then
    raise exception using message = 'operations: request key required', errcode = '22023', hint = 'invalid_request';
  end if;
  select * into v from public.visits where id = p_visit and clinic_id = p_clinic for update;
  if not found then
    raise exception using message = 'operations: visit not found', errcode = '22023', hint = 'visit_not_found';
  end if;

  select * into c from public.visit_charges where clinic_id = p_clinic and idempotency_key = p_key;
  if found then
    if c.visit_id <> p_visit or c.service_id <> p_service then
      raise exception using message = 'operations: request key reused for a different request', errcode = '22023', hint = 'idempotency_conflict';
    end if;
    return jsonb_build_object('charge_id', c.id, 'replayed', true);
  end if;

  if v.status = 'cancelled' then
    raise exception using message = 'operations: the visit was cancelled', errcode = '22023', hint = 'visit_cancelled';
  end if;
  select s.name, coalesce(ds.price_override, s.price) into v_name, v_price
    from public.services s
    left join public.doctor_services ds on ds.doctor_id = v.doctor_id and ds.service_id = s.id
   where s.id = p_service and s.clinic_id = p_clinic and s.active;
  if not found then
    raise exception using message = 'operations: service unavailable', errcode = '22023', hint = 'service_not_found';
  end if;

  insert into public.visit_charges (clinic_id, visit_id, patient_id, service_id, service_name, unit_price, quantity, amount, currency, created_by, idempotency_key)
  select p_clinic, v.id, v.patient_id, p_service, v_name, v_price, 1, v_price, currency, p_actor, p_key from public.clinics where id = p_clinic
  returning * into c;

  insert into public.audit_events (clinic_id, actor_id, actor_type, action, entity_type, entity_id, new_values)
  values (p_clinic, p_actor, 'staff', 'visit_charge_added', 'visit_charges', c.id::text,
          jsonb_build_object('visit_id', v.id, 'service_id', p_service, 'amount', v_price));
  return jsonb_build_object('charge_id', c.id, 'replayed', false);
end;
$$;

create or replace function public.void_visit_charge(p_clinic uuid, p_actor uuid, p_charge uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v public.visits;
  c public.visit_charges;
  b record;
begin
  perform public.ops_require_role(p_clinic, p_actor, array['owner', 'manager', 'admin', 'receptionist', 'cashier']::public.staff_role[]);
  if p_reason is null or char_length(btrim(p_reason)) not between 3 and 500 then
    raise exception using message = 'operations: a reason is required', errcode = '22023', hint = 'reason_required';
  end if;
  select vi.* into v from public.visits vi
    join public.visit_charges ch on ch.visit_id = vi.id
   where ch.id = p_charge and ch.clinic_id = p_clinic
   for update of vi;
  if not found then
    raise exception using message = 'operations: charge not found', errcode = '22023', hint = 'charge_not_found';
  end if;
  select * into c from public.visit_charges where id = p_charge;
  if c.status = 'voided' then
    return jsonb_build_object('charge_id', c.id, 'replayed', true);
  end if;

  -- Voiding must never leave the patient having paid more than they owe:
  -- refund first, then void.
  select * into b from public.visit_balance(v.id);
  if b.charged - c.amount < b.collected - b.refunded then
    raise exception using message = 'operations: refund the payment before removing this service', errcode = '22023', hint = 'refund_first';
  end if;

  update public.visit_charges set status = 'voided', voided_by = p_actor, voided_at = now(), void_reason = btrim(p_reason)
   where id = c.id;

  -- The bill may now be settled (a wrong extra line removed after payment).
  select * into b from public.visit_balance(v.id);
  if v.queue_number is null and v.status = 'awaiting_payment' and b.outstanding = 0 and b.charged > 0 then
    perform public.visit_enqueue(v.id);
  end if;

  insert into public.audit_events (clinic_id, actor_id, actor_type, action, entity_type, entity_id, new_values)
  values (p_clinic, p_actor, 'staff', 'visit_charge_voided', 'visit_charges', c.id::text, jsonb_build_object('visit_id', v.id, 'amount', c.amount));
  return jsonb_build_object('charge_id', c.id, 'replayed', false);
end;
$$;

-- ---------------------------------------------------------------------------
-- Queue transitions
-- ---------------------------------------------------------------------------

create or replace function public.transition_visit(
  p_clinic uuid,
  p_actor uuid,
  p_visit uuid,
  p_expected text,
  p_status text,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v public.visits;
  b record;
  v_desk boolean;
  v_own_doctor boolean;
begin
  perform public.ops_require_role(p_clinic, p_actor, array['owner', 'manager', 'admin', 'receptionist', 'doctor']::public.staff_role[]);
  select * into v from public.visits where id = p_visit and clinic_id = p_clinic for update;
  if not found then
    raise exception using message = 'operations: visit not found', errcode = '22023', hint = 'visit_not_found';
  end if;

  v_desk := public.ops_has_role(p_clinic, p_actor, array['owner', 'manager', 'admin', 'receptionist']::public.staff_role[]);
  v_own_doctor := exists (
    select 1 from public.doctors d where d.id = v.doctor_id and d.clinic_id = p_clinic and d.profile_id = p_actor and d.active
  ) and public.ops_has_role(p_clinic, p_actor, array['doctor']::public.staff_role[]);
  if not v_desk and not v_own_doctor then
    raise exception using message = 'operations: not your patient', errcode = '42501', hint = 'forbidden';
  end if;

  if v.status <> p_expected then
    raise exception using message = 'operations: the queue changed; refresh', errcode = '40001', hint = 'stale';
  end if;

  if p_status = 'called' and v.status = 'waiting' then
    update public.visits set status = 'called', called_at = now(), updated_at = now() where id = v.id returning * into v;
  elsif p_status = 'waiting' and v.status = 'called' then
    update public.visits set status = 'waiting', updated_at = now() where id = v.id returning * into v;
  elsif p_status = 'completed' and v.status = 'in_progress' and v_own_doctor then
    update public.visits set status = 'completed', completed_at = now(), updated_at = now() where id = v.id returning * into v;
    update public.appointments set status = 'completed' where id = v.appointment_id and status = 'in_progress';
  elsif p_status = 'cancelled' and v.status in ('awaiting_payment', 'waiting', 'called') and v_desk then
    if p_reason is null or char_length(btrim(p_reason)) not between 3 and 500 then
      raise exception using message = 'operations: a reason is required', errcode = '22023', hint = 'reason_required';
    end if;
    select * into b from public.visit_balance(v.id);
    if b.collected - b.refunded > 0 then
      raise exception using message = 'operations: refund the payment before cancelling', errcode = '22023', hint = 'refund_first';
    end if;
    update public.visit_charges set status = 'voided', voided_by = p_actor, voided_at = now(), void_reason = 'Tashrif bekor qilindi'
     where visit_id = v.id and status = 'active';
    update public.visits set status = 'cancelled', cancelled_at = now(), cancel_reason = btrim(p_reason), updated_at = now()
     where id = v.id returning * into v;
  else
    raise exception using message = 'operations: this change is not allowed', errcode = '22023', hint = 'invalid_transition';
  end if;

  insert into public.audit_events (clinic_id, actor_id, actor_type, action, entity_type, entity_id, old_values, new_values)
  values (p_clinic, p_actor, 'staff', 'visit_status_changed', 'visits', v.id::text,
          jsonb_build_object('status', p_expected), jsonb_build_object('status', v.status));
  return jsonb_build_object('visit_id', v.id, 'status', v.status);
end;
$$;

-- The visit's own doctor starts the consultation: a walk-in appointment
-- through the booking engine (working hours, overlaps, referral linking and
-- clinical-record rules all as before). Its auto-created bill is removed —
-- the visit's charges are the bill — so nothing is charged twice.
create or replace function public.start_visit_consultation(p_clinic uuid, p_actor uuid, p_visit uuid, p_expected text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v public.visits;
  v_service uuid;
  v_result jsonb;
  v_appointment uuid;
begin
  perform public.ops_require_role(p_clinic, p_actor, array['doctor']::public.staff_role[]);
  select * into v from public.visits where id = p_visit and clinic_id = p_clinic for update;
  if not found or not exists (
    select 1 from public.doctors d where d.id = v.doctor_id and d.clinic_id = p_clinic and d.profile_id = p_actor and d.active
  ) then
    raise exception using message = 'operations: not your patient', errcode = '42501', hint = 'forbidden';
  end if;
  if v.status <> p_expected then
    raise exception using message = 'operations: the queue changed; refresh', errcode = '40001', hint = 'stale';
  end if;
  if v.status not in ('waiting', 'called') then
    raise exception using message = 'operations: this patient is not in the queue', errcode = '22023', hint = 'invalid_transition';
  end if;

  select service_id into v_service from public.visit_charges
   where visit_id = v.id and status = 'active' order by created_at, id limit 1;
  if v_service is null then
    raise exception using message = 'operations: the visit has no service', errcode = '22023', hint = 'invalid_services';
  end if;

  v_result := public.start_walk_in_consultation(
    p_clinic, v.patient_id, v.doctor_id, v_service, date_trunc('minute', now()) + interval '1 minute', p_actor
  );
  v_appointment := (v_result ->> 'appointment_id')::uuid;
  if v_appointment is null then
    raise exception using message = 'operations: the consultation could not start', errcode = '22023',
      hint = coalesce(v_result ->> 'error_code', 'booking_failed');
  end if;
  delete from public.payments where appointment_id = v_appointment and status = 'unpaid';

  update public.visits set status = 'in_progress', started_at = now(), appointment_id = v_appointment, updated_at = now()
   where id = v.id returning * into v;

  insert into public.audit_events (clinic_id, actor_id, actor_type, action, entity_type, entity_id, new_values)
  values (p_clinic, p_actor, 'staff', 'visit_consultation_started', 'visits', v.id::text, jsonb_build_object('appointment_id', v_appointment));
  return jsonb_build_object('visit_id', v.id, 'appointment_id', v_appointment, 'referral_id', v_result ->> 'referral_id');
end;
$$;

-- ---------------------------------------------------------------------------
-- Doctor access: a visit is a relationship; a referral shares history at once
-- ---------------------------------------------------------------------------

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
set search_path = public, pg_temp
as $$
  select
    d.clinic_id,
    -- Own relationship: a live appointment, a walk-in visit, or a record the doctor wrote.
    exists (
      select 1
      from public.appointments a
      where a.clinic_id = d.clinic_id
        and a.patient_id = any (g.ids)
        and a.doctor_id = d.id
        and a.status <> 'cancelled'
    )
    or exists (
      select 1
      from public.visits v
      where v.clinic_id = d.clinic_id
        and v.patient_id = any (g.ids)
        and v.doctor_id = d.id
        and v.status <> 'cancelled'
    )
    or exists (
      select 1
      from public.clinical_records cr
      where cr.clinic_id = d.clinic_id
        and cr.patient_id = any (g.ids)
        and cr.author_doctor_id = d.id
    ),
    array(
      select r.id
      from public.referrals r
      where r.clinic_id = d.clinic_id
        and r.patient_id = any (g.ids)
        and r.referred_to_doctor_id = d.id
        and r.status in ('pending', 'accepted', 'in_progress')
        and r.expires_at > now()
      order by r.created_at
    ),
    -- The referring doctor's history is shared as soon as the referral exists
    -- (pending included): no accept/start step is needed to read it.
    array(
      select distinct r.referring_doctor_id
      from public.referrals r
      where r.clinic_id = d.clinic_id
        and r.patient_id = any (g.ids)
        and r.referred_to_doctor_id = d.id
        and r.status in ('pending', 'accepted', 'in_progress')
        and r.expires_at > now()
    ),
    array(
      select r.originating_appointment_id
      from public.referrals r
      where r.clinic_id = d.clinic_id
        and r.patient_id = any (g.ids)
        and r.referred_to_doctor_id = d.id
        and r.status in ('pending', 'accepted', 'in_progress')
        and r.expires_at > now()
      union
      select r.follow_up_appointment_id
      from public.referrals r
      where r.clinic_id = d.clinic_id
        and r.patient_id = any (g.ids)
        and r.referring_doctor_id = d.id
        and r.follow_up_appointment_id is not null
        and r.status in ('accepted', 'in_progress', 'completed')
        and r.expires_at > now()
    )
  from public.doctors d
  join public.patients p
    on p.id = p_patient_id
   and p.clinic_id = d.clinic_id
  cross join lateral (select public.patient_record_group(p.id) as ids) g
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
  'What an active doctor may see of a patient (see 20260929000001; merged record group since 20261005000016; walk-in visits and immediate referral history since 20261007000002): own relationship (live appointment, walk-in visit or authored record); open, unexpired referrals to them; referring doctors whose visits open referrals share (pending included); referral-linked appointments. No row = no access. Server-only.';

-- ---------------------------------------------------------------------------
-- Grants: server only
-- ---------------------------------------------------------------------------

revoke all on function public.ops_require_role(uuid, uuid, public.staff_role[]) from public, anon, authenticated;
revoke all on function public.ops_has_role(uuid, uuid, public.staff_role[]) from public, anon, authenticated;
revoke all on function public.visit_balance(uuid) from public, anon, authenticated;
revoke all on function public.visit_enqueue(uuid) from public, anon, authenticated;
revoke all on function public.register_arrival(uuid, uuid, uuid, uuid, jsonb, uuid, uuid[]) from public, anon, authenticated;
revoke all on function public.record_visit_payment(uuid, uuid, uuid, uuid, jsonb, numeric) from public, anon, authenticated;
revoke all on function public.refund_visit_payment(uuid, uuid, uuid, uuid, text, numeric, text) from public, anon, authenticated;
revoke all on function public.grant_refund_permission(uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function public.revoke_refund_permission(uuid, uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.add_visit_charge(uuid, uuid, uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function public.void_visit_charge(uuid, uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.transition_visit(uuid, uuid, uuid, text, text, text) from public, anon, authenticated;
revoke all on function public.start_visit_consultation(uuid, uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.visit_charges_guard() from public, anon, authenticated;
revoke all on function public.visit_transactions_append_only() from public, anon, authenticated;
revoke all on function public.refund_grants_guard() from public, anon, authenticated;

grant execute on function public.visit_balance(uuid) to service_role;
grant execute on function public.register_arrival(uuid, uuid, uuid, uuid, jsonb, uuid, uuid[]) to service_role;
grant execute on function public.record_visit_payment(uuid, uuid, uuid, uuid, jsonb, numeric) to service_role;
grant execute on function public.refund_visit_payment(uuid, uuid, uuid, uuid, text, numeric, text) to service_role;
grant execute on function public.grant_refund_permission(uuid, uuid, uuid) to service_role;
grant execute on function public.revoke_refund_permission(uuid, uuid, uuid, text) to service_role;
grant execute on function public.add_visit_charge(uuid, uuid, uuid, uuid, uuid) to service_role;
grant execute on function public.void_visit_charge(uuid, uuid, uuid, text) to service_role;
grant execute on function public.transition_visit(uuid, uuid, uuid, text, text, text) to service_role;
grant execute on function public.start_visit_consultation(uuid, uuid, uuid, text) to service_role;

-- =====================================================================
-- FILE: 20261007000003_visit_actual_end.sql
-- =====================================================================
-- Outpatient pilot fix (found by e2e/outpatient-journey.mjs): completing a
-- walk-in visit left its consultation appointment occupying the full booked
-- service duration, so the doctor could not start the next queued patient
-- ("slot taken") until that time had passed. The visit's appointment now ends
-- when the doctor completes it. Only transition_visit changes.

create or replace function public.transition_visit(
  p_clinic uuid,
  p_actor uuid,
  p_visit uuid,
  p_expected text,
  p_status text,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v public.visits;
  b record;
  v_desk boolean;
  v_own_doctor boolean;
begin
  perform public.ops_require_role(p_clinic, p_actor, array['owner', 'manager', 'admin', 'receptionist', 'doctor']::public.staff_role[]);
  select * into v from public.visits where id = p_visit and clinic_id = p_clinic for update;
  if not found then
    raise exception using message = 'operations: visit not found', errcode = '22023', hint = 'visit_not_found';
  end if;

  v_desk := public.ops_has_role(p_clinic, p_actor, array['owner', 'manager', 'admin', 'receptionist']::public.staff_role[]);
  v_own_doctor := exists (
    select 1 from public.doctors d where d.id = v.doctor_id and d.clinic_id = p_clinic and d.profile_id = p_actor and d.active
  ) and public.ops_has_role(p_clinic, p_actor, array['doctor']::public.staff_role[]);
  if not v_desk and not v_own_doctor then
    raise exception using message = 'operations: not your patient', errcode = '42501', hint = 'forbidden';
  end if;

  if v.status <> p_expected then
    raise exception using message = 'operations: the queue changed; refresh', errcode = '40001', hint = 'stale';
  end if;

  if p_status = 'called' and v.status = 'waiting' then
    update public.visits set status = 'called', called_at = now(), updated_at = now() where id = v.id returning * into v;
  elsif p_status = 'waiting' and v.status = 'called' then
    update public.visits set status = 'waiting', updated_at = now() where id = v.id returning * into v;
  elsif p_status = 'completed' and v.status = 'in_progress' and v_own_doctor then
    update public.visits set status = 'completed', completed_at = now(), updated_at = now() where id = v.id returning * into v;
    -- The consultation ends now, not when its booked duration would: a
    -- completed appointment still occupies its slot (no_overlapping_active_
    -- appointments), and a walk-in queue must let the doctor start the next
    -- patient at once. Never shorter than one minute (end > start).
    update public.appointments
       set status = 'completed', end_at = greatest(now(), start_at + interval '1 minute')
     where id = v.appointment_id and status = 'in_progress';
  elsif p_status = 'cancelled' and v.status in ('awaiting_payment', 'waiting', 'called') and v_desk then
    if p_reason is null or char_length(btrim(p_reason)) not between 3 and 500 then
      raise exception using message = 'operations: a reason is required', errcode = '22023', hint = 'reason_required';
    end if;
    select * into b from public.visit_balance(v.id);
    if b.collected - b.refunded > 0 then
      raise exception using message = 'operations: refund the payment before cancelling', errcode = '22023', hint = 'refund_first';
    end if;
    update public.visit_charges set status = 'voided', voided_by = p_actor, voided_at = now(), void_reason = 'Tashrif bekor qilindi'
     where visit_id = v.id and status = 'active';
    update public.visits set status = 'cancelled', cancelled_at = now(), cancel_reason = btrim(p_reason), updated_at = now()
     where id = v.id returning * into v;
  else
    raise exception using message = 'operations: this change is not allowed', errcode = '22023', hint = 'invalid_transition';
  end if;

  insert into public.audit_events (clinic_id, actor_id, actor_type, action, entity_type, entity_id, old_values, new_values)
  values (p_clinic, p_actor, 'staff', 'visit_status_changed', 'visits', v.id::text,
          jsonb_build_object('status', p_expected), jsonb_build_object('status', v.status));
  return jsonb_build_object('visit_id', v.id, 'status', v.status);
end;
$$;

-- =====================================================================
-- FILE: 20261008000001_lab_visits.sql
-- =====================================================================
-- Outpatient pilot, Phase 3: laboratory tests on the visit bill and a walk-in
-- lab queue (owner decisions 2026-10-08: walk-in lab queue first; tests are
-- paid before the sample is taken — the clinic's lab setting
-- paymentPolicy = "before_collection" holds the tests until the bill is paid).
--
--   * A lab walk-in (register_lab_arrival) is a visit of kind 'lab': the order
--     is created with create_lab_order() as before and its tests become lines
--     of the visit's bill — one bill, one kassa. The order's own lab payment
--     row is not created for visit-billed orders (no double bill).
--   * Tests a doctor orders during a walk-in consultation are billed to that
--     visit the same way (the order's appointment is the visit's consultation).
--   * Full payment releases the visit's tests for collection.
--   * Cancelling a test in the laboratory voids its line; money already paid
--     for it shows as due back (a refund at the kassa), like a cancelled paid
--     lab order today. A lab line cannot be removed at the desk.
--   * Lab staff call, start and complete lab visits; samples use the existing
--     collection flow. Lab visits share the clinic-day queue numbers.
--   * Cancelling a lab walk-in at the desk (nothing paid, no sample taken)
--     cancels its lab order, so the tests leave the lab's work queue.

-- ---------------------------------------------------------------------------
-- Schema
-- ---------------------------------------------------------------------------

alter table public.visits
  add column kind text not null default 'doctor' check (kind in ('doctor', 'lab')),
  add column lab_order_id uuid;
alter table public.visits alter column doctor_id drop not null;
alter table public.visits
  add constraint visits_kind_doctor_check check ((kind = 'doctor') = (doctor_id is not null)),
  add constraint visits_lab_order_fkey foreign key (lab_order_id, clinic_id) references public.lab_orders (id, clinic_id) on delete restrict;
create unique index visits_lab_order_key on public.visits (lab_order_id) where lab_order_id is not null;

alter table public.lab_orders add column visit_id uuid;
alter table public.lab_orders
  add constraint lab_orders_visit_fkey foreign key (visit_id, clinic_id, patient_id) references public.visits (id, clinic_id, patient_id) on delete restrict;
create index lab_orders_visit_idx on public.lab_orders (visit_id) where visit_id is not null;
comment on column public.lab_orders.visit_id is 'Set when the order is billed on a walk-in visit (lab walk-in, or ordered in that visit''s consultation): its tests are lines of the visit''s bill and it has no lab payment row of its own.';

alter table public.visit_charges alter column service_id drop not null;
alter table public.visit_charges add column lab_order_item_id uuid;
alter table public.visit_charges
  add constraint visit_charges_lab_item_fkey foreign key (lab_order_item_id, clinic_id) references public.lab_order_items (id, clinic_id) on delete restrict,
  add constraint visit_charges_subject_check check (num_nonnulls(service_id, lab_order_item_id) = 1);
create unique index visit_charges_lab_item_key on public.visit_charges (lab_order_item_id) where lab_order_item_id is not null;

-- The charge guard also keeps the lab item fixed.
create or replace function public.visit_charges_guard()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'visit charges are never deleted; void them' using errcode = '42501';
  end if;
  if old.status = 'active' and new.status = 'voided'
     and (new.id, new.clinic_id, new.visit_id, new.patient_id, new.service_id, new.lab_order_item_id, new.service_name, new.unit_price,
          new.quantity, new.amount, new.currency, new.created_by, new.created_at, new.idempotency_key)
         is not distinct from
         (old.id, old.clinic_id, old.visit_id, old.patient_id, old.service_id, old.lab_order_item_id, old.service_name, old.unit_price,
          old.quantity, old.amount, old.currency, old.created_by, old.created_at, old.idempotency_key) then
    return new;
  end if;
  raise exception 'visit charges cannot be changed; void and add a new line' using errcode = '42501';
end;
$$;

-- ---------------------------------------------------------------------------
-- Billing lab orders on a visit
-- ---------------------------------------------------------------------------

-- Which visit an order is billed on: the lab walk-in being registered (set
-- for this transaction by register_lab_arrival), or the walk-in visit whose
-- consultation the order was placed in.
create or replace function public.lab_orders_bill_to_visit()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_lab_visit uuid := nullif(current_setting('health_ai.lab_visit_id', true), '')::uuid;
begin
  if new.visit_id is null then
    if v_lab_visit is not null then
      new.visit_id := v_lab_visit;
    elsif new.appointment_id is not null then
      select v.id into new.visit_id
        from public.visits v
       where v.appointment_id = new.appointment_id and v.clinic_id = new.clinic_id and v.status <> 'cancelled';
    end if;
  end if;
  return new;
end;
$$;

create trigger lab_orders_bill_to_visit
  before insert on public.lab_orders
  for each row execute function public.lab_orders_bill_to_visit();

-- Each test of a visit-billed order becomes a line of the visit's bill,
-- priced from the item's own stored price.
create or replace function public.lab_items_charge_visit()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.visit_charges (clinic_id, visit_id, patient_id, lab_order_item_id, service_name, unit_price, quantity, amount, currency, created_by)
  select new.clinic_id, o.visit_id, new.patient_id, new.id, new.test_name_snapshot, new.price_snapshot, 1, new.price_snapshot, c.currency, o.ordered_by
    from public.lab_orders o
    join public.clinics c on c.id = o.clinic_id
   where o.id = new.order_id and o.visit_id is not null;
  return null;
end;
$$;

create trigger lab_order_items_charge_visit
  after insert on public.lab_order_items
  for each row execute function public.lab_items_charge_visit();

-- No separate lab bill for a visit-billed order (no double charge).
create or replace function public.payments_skip_visit_billed_lab_order()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.lab_order_id is not null
     and exists (select 1 from public.lab_orders o where o.id = new.lab_order_id and o.visit_id is not null) then
    return null;
  end if;
  return new;
end;
$$;

-- Named to run before payments_lab_amount_guard (triggers fire in name order).
create trigger payments_a_skip_visit_billed_lab
  before insert on public.payments
  for each row execute function public.payments_skip_visit_billed_lab_order();

-- A test cancelled in the laboratory leaves the bill: its line is voided.
-- Money already paid for it then shows as due back at the kassa.
create or replace function public.lab_items_void_visit_charge()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.visit_charges ch
     set status = 'voided',
         voided_at = now(),
         void_reason = 'Tahlil bekor qilindi',
         voided_by = coalesce(new.status_changed_by, o.cancelled_by, o.ordered_by)
    from public.lab_orders o
   where ch.lab_order_item_id = new.id and ch.status = 'active' and o.id = new.order_id;
  return null;
end;
$$;

create trigger lab_order_items_void_visit_charge
  after update of status on public.lab_order_items
  for each row when (new.status = 'cancelled' and old.status is distinct from new.status)
  execute function public.lab_items_void_visit_charge();

-- ---------------------------------------------------------------------------
-- Lab walk-in registration
-- ---------------------------------------------------------------------------

create or replace function public.register_lab_arrival(
  p_clinic uuid,
  p_actor uuid,
  p_key uuid,
  p_patient uuid,
  p_new_patient jsonb,
  p_test_ids uuid[],
  p_panel_ids uuid[]
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v public.visits;
  v_patient uuid := p_patient;
  v_fingerprint text;
  v_clinic public.clinics;
  v_name text;
  v_phone text;
  v_dob date;
  v_doc text;
  v_pinfl text;
  v_match uuid;
  v_order uuid;
  v_total numeric;
begin
  perform public.ops_require_role(p_clinic, p_actor, array['owner', 'manager', 'admin', 'receptionist']::public.staff_role[]);
  if p_key is null then
    raise exception using message = 'operations: request key required', errcode = '22023', hint = 'invalid_request';
  end if;
  v_fingerprint := md5(jsonb_build_array(
    p_actor, p_patient, p_new_patient, 'lab',
    (select coalesce(jsonb_agg(x order by x), '[]'::jsonb) from unnest(coalesce(p_test_ids, '{}')) x),
    (select coalesce(jsonb_agg(x order by x), '[]'::jsonb) from unnest(coalesce(p_panel_ids, '{}')) x)
  )::text);

  perform pg_advisory_xact_lock(hashtextextended('visit-register:' || p_clinic::text, 0));

  select * into v from public.visits where clinic_id = p_clinic and idempotency_key = p_key;
  if found then
    if v.request_fingerprint <> v_fingerprint then
      raise exception using message = 'operations: request key reused for a different request', errcode = '22023', hint = 'idempotency_conflict';
    end if;
    return jsonb_build_object('visit_id', v.id, 'replayed', true);
  end if;

  select * into v_clinic from public.clinics where id = p_clinic;

  if (v_patient is null) = (p_new_patient is null) then
    raise exception using message = 'operations: choose an existing patient or describe a new one', errcode = '22023', hint = 'invalid_patient';
  end if;
  if v_patient is not null then
    if not exists (select 1 from public.patients where id = v_patient and clinic_id = p_clinic) then
      raise exception using message = 'operations: patient not found', errcode = '22023', hint = 'patient_not_found';
    end if;
    if exists (select 1 from public.patients where id = v_patient and merged_into_patient_id is not null) then
      raise exception using message = 'operations: this record was merged; use the main record', errcode = '22023', hint = 'patient_merged';
    end if;
  else
    v_name := btrim(p_new_patient ->> 'full_name');
    v_phone := nullif(btrim(p_new_patient ->> 'phone'), '');
    v_doc := public.normalize_identity_document(p_new_patient ->> 'document_number');
    v_pinfl := public.normalize_identity_document(p_new_patient ->> 'pinfl');
    begin
      v_dob := nullif(p_new_patient ->> 'date_of_birth', '')::date;
    exception when others then
      raise exception using message = 'operations: invalid date of birth', errcode = '22023', hint = 'invalid_patient';
    end;
    if v_name is null or char_length(v_name) not between 2 and 120 or v_dob is null then
      raise exception using message = 'operations: patient name and date of birth required', errcode = '22023', hint = 'invalid_patient';
    end if;
    if v_phone is not null and v_phone !~ '^\+?[0-9 ()-]{7,24}$' then
      raise exception using message = 'operations: invalid phone', errcode = '22023', hint = 'invalid_patient';
    end if;
    select id into v_match from public.patients
     where clinic_id = p_clinic and merged_into_patient_id is null
       and ((v_pinfl is not null and pinfl = v_pinfl)
         or (v_doc is not null and document_number = v_doc)
         or (date_of_birth = v_dob and lower(btrim(full_name)) = lower(v_name)))
     order by created_at limit 1;
    if v_match is not null then
      raise exception using message = 'operations: this patient is already registered', errcode = '22023',
        hint = 'patient_exists', detail = v_match::text;
    end if;
    insert into public.patients (clinic_id, full_name, phone, date_of_birth, sex, document_number, pinfl)
    values (p_clinic, v_name, v_phone, v_dob, nullif(p_new_patient ->> 'sex', '')::public.patient_sex, v_doc, v_pinfl)
    returning id into v_patient;
  end if;

  if exists (
    select 1 from public.visits
     where clinic_id = p_clinic and patient_id = v_patient and kind = 'lab'
       and status in ('awaiting_payment', 'waiting', 'called', 'in_progress')
  ) then
    raise exception using message = 'operations: this patient is already registered for the laboratory', errcode = '22023', hint = 'already_registered_lab';
  end if;

  insert into public.visits (clinic_id, patient_id, doctor_id, kind, created_by, idempotency_key, request_fingerprint)
  values (p_clinic, v_patient, null, 'lab', p_actor, p_key, v_fingerprint)
  returning * into v;

  -- The order is billed on this visit (lab_orders_bill_to_visit reads this).
  perform set_config('health_ai.lab_visit_id', v.id::text, true);
  select o.lab_order_id into v_order
    from public.create_lab_order(p_clinic, v_patient, p_actor, 'walk_in'::public.lab_order_source,
                                 coalesce(p_test_ids, '{}'), coalesce(p_panel_ids, '{}'), p_key, null, null) o;
  perform set_config('health_ai.lab_visit_id', '', true);

  update public.visits set lab_order_id = v_order where id = v.id returning * into v;

  select coalesce(sum(amount), 0) into v_total from public.visit_charges where visit_id = v.id and status = 'active';
  if not v_clinic.queue_after_payment or v_total = 0 then
    v := public.visit_enqueue(v.id);
  end if;

  insert into public.audit_events (clinic_id, actor_id, actor_type, action, entity_type, entity_id, new_values)
  values (p_clinic, p_actor, 'staff', 'lab_visit_registered', 'visits', v.id::text,
          jsonb_build_object('patient_id', v_patient, 'lab_order_id', v_order, 'charge_total', v_total, 'new_patient', p_patient is null));

  return jsonb_build_object('visit_id', v.id, 'lab_order_id', v_order, 'replayed', false);
end;
$$;

-- ---------------------------------------------------------------------------
-- Redefined: payment releases lab tests; lab lines are not voided at the desk;
-- lab staff run lab visits
-- ---------------------------------------------------------------------------

create or replace function public.record_visit_payment(
  p_clinic uuid,
  p_actor uuid,
  p_visit uuid,
  p_key uuid,
  p_lines jsonb,
  p_expected_outstanding numeric
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v public.visits;
  b record;
  v_fingerprint text;
  v_line jsonb;
  v_sum numeric := 0;
  v_methods text[] := '{}';
  v_method text;
  v_amount numeric;
  v_currency text;
begin
  perform public.ops_require_role(p_clinic, p_actor, array['owner', 'manager', 'admin', 'cashier']::public.staff_role[]);
  if p_key is null or jsonb_typeof(p_lines) <> 'array' then
    raise exception using message = 'operations: invalid payment request', errcode = '22023', hint = 'invalid_request';
  end if;
  v_fingerprint := md5(jsonb_build_array(p_actor, p_visit, p_lines, p_expected_outstanding)::text);

  select * into v from public.visits where id = p_visit and clinic_id = p_clinic for update;
  if not found then
    raise exception using message = 'operations: visit not found', errcode = '22023', hint = 'visit_not_found';
  end if;

  -- A retry of the same request returns what it recorded.
  if exists (select 1 from public.visit_transactions where clinic_id = p_clinic and request_key = p_key) then
    if exists (select 1 from public.visit_transactions where clinic_id = p_clinic and request_key = p_key
                and (request_fingerprint <> v_fingerprint or visit_id <> p_visit)) then
      raise exception using message = 'operations: request key reused for a different request', errcode = '22023', hint = 'idempotency_conflict';
    end if;
    return jsonb_build_object('visit_id', v.id, 'replayed', true);
  end if;

  if v.status = 'cancelled' then
    raise exception using message = 'operations: the visit was cancelled', errcode = '22023', hint = 'visit_cancelled';
  end if;

  select * into b from public.visit_balance(v.id);
  if p_expected_outstanding is null or b.outstanding <> p_expected_outstanding then
    raise exception using message = 'operations: the bill changed; refresh', errcode = '40001', hint = 'stale';
  end if;
  if b.outstanding <= 0 then
    raise exception using message = 'operations: nothing to pay', errcode = '22023', hint = 'nothing_due';
  end if;

  if jsonb_array_length(p_lines) not between 1 and 2 then
    raise exception using message = 'operations: one or two payment methods', errcode = '22023', hint = 'invalid_request';
  end if;
  for v_line in select * from jsonb_array_elements(p_lines) loop
    v_method := v_line ->> 'method';
    begin
      v_amount := (v_line ->> 'amount')::numeric;
    exception when others then
      v_amount := null;
    end;
    if v_method not in ('cash', 'terminal') or v_method = any (v_methods)
       or v_amount is null or v_amount <= 0 or v_amount <> round(v_amount, 2) then
      raise exception using message = 'operations: invalid payment line', errcode = '22023', hint = 'invalid_request';
    end if;
    v_methods := v_methods || v_method;
    v_sum := v_sum + v_amount;
  end loop;

  -- Full payment only (owner decision): the lines must settle the bill exactly.
  if v_sum <> b.outstanding then
    raise exception using message = 'operations: the payment must equal the amount due', errcode = '22023', hint = 'amount_mismatch';
  end if;

  select currency into v_currency from public.clinics where id = p_clinic;
  insert into public.visit_transactions (clinic_id, visit_id, patient_id, kind, method, amount, currency, executed_by, authorized_by, request_key, request_fingerprint)
  select p_clinic, v.id, v.patient_id, 'collection', l ->> 'method', (l ->> 'amount')::numeric, v_currency, p_actor, p_actor, p_key, v_fingerprint
    from jsonb_array_elements(p_lines) l;

  if v.queue_number is null then
    v := public.visit_enqueue(v.id);
  end if;

  -- Paid in full (the only kind of payment): the visit's lab tests that were
  -- waiting for payment (clinic lab setting "before_collection") can now be
  -- collected — the same release payments_release_lab_items does for a lab
  -- order's own bill.
  update public.lab_order_items i
     set status = 'ready_for_collection', status_changed_by = p_actor
    from public.lab_orders o
   where o.id = i.order_id and o.visit_id = v.id and o.clinic_id = p_clinic and i.status = 'ordered';

  insert into public.audit_events (clinic_id, actor_id, actor_type, action, entity_type, entity_id, new_values)
  values (p_clinic, p_actor, 'staff', 'visit_payment_recorded', 'visits', v.id::text,
          jsonb_build_object('amount', v_sum, 'methods', to_jsonb(v_methods), 'queue_number', v.queue_number));

  return jsonb_build_object('visit_id', v.id, 'replayed', false, 'queue_number', v.queue_number);
end;
$$;

create or replace function public.void_visit_charge(p_clinic uuid, p_actor uuid, p_charge uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v public.visits;
  c public.visit_charges;
  b record;
begin
  perform public.ops_require_role(p_clinic, p_actor, array['owner', 'manager', 'admin', 'receptionist', 'cashier']::public.staff_role[]);
  if p_reason is null or char_length(btrim(p_reason)) not between 3 and 500 then
    raise exception using message = 'operations: a reason is required', errcode = '22023', hint = 'reason_required';
  end if;
  select vi.* into v from public.visits vi
    join public.visit_charges ch on ch.visit_id = vi.id
   where ch.id = p_charge and ch.clinic_id = p_clinic
   for update of vi;
  if not found then
    raise exception using message = 'operations: charge not found', errcode = '22023', hint = 'charge_not_found';
  end if;
  select * into c from public.visit_charges where id = p_charge;
  if c.status = 'voided' then
    return jsonb_build_object('charge_id', c.id, 'replayed', true);
  end if;
  -- A lab test is cancelled in the laboratory (its line is then voided
  -- automatically); removing only the money line would leave a test the lab
  -- could still collect unpaid.
  if c.lab_order_item_id is not null then
    raise exception using message = 'operations: cancel the lab test in the laboratory', errcode = '22023', hint = 'cancel_lab_test';
  end if;

  -- Voiding must never leave the patient having paid more than they owe:
  -- refund first, then void.
  select * into b from public.visit_balance(v.id);
  if b.charged - c.amount < b.collected - b.refunded then
    raise exception using message = 'operations: refund the payment before removing this service', errcode = '22023', hint = 'refund_first';
  end if;

  update public.visit_charges set status = 'voided', voided_by = p_actor, voided_at = now(), void_reason = btrim(p_reason)
   where id = c.id;

  -- The bill may now be settled (a wrong extra line removed after payment).
  select * into b from public.visit_balance(v.id);
  if v.queue_number is null and v.status = 'awaiting_payment' and b.outstanding = 0 and b.charged > 0 then
    perform public.visit_enqueue(v.id);
  end if;

  insert into public.audit_events (clinic_id, actor_id, actor_type, action, entity_type, entity_id, new_values)
  values (p_clinic, p_actor, 'staff', 'visit_charge_voided', 'visit_charges', c.id::text, jsonb_build_object('visit_id', v.id, 'amount', c.amount));
  return jsonb_build_object('charge_id', c.id, 'replayed', false);
end;
$$;

create or replace function public.transition_visit(
  p_clinic uuid,
  p_actor uuid,
  p_visit uuid,
  p_expected text,
  p_status text,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v public.visits;
  b record;
  v_desk boolean;
  v_own_doctor boolean;
  v_lab boolean;
begin
  perform public.ops_require_role(p_clinic, p_actor, array['owner', 'manager', 'admin', 'receptionist', 'doctor', 'lab']::public.staff_role[]);
  select * into v from public.visits where id = p_visit and clinic_id = p_clinic for update;
  if not found then
    raise exception using message = 'operations: visit not found', errcode = '22023', hint = 'visit_not_found';
  end if;

  v_desk := public.ops_has_role(p_clinic, p_actor, array['owner', 'manager', 'admin', 'receptionist']::public.staff_role[]);
  v_own_doctor := exists (
    select 1 from public.doctors d where d.id = v.doctor_id and d.clinic_id = p_clinic and d.profile_id = p_actor and d.active
  ) and public.ops_has_role(p_clinic, p_actor, array['doctor']::public.staff_role[]);
  -- Laboratory staff run the lab queue (lab visits only).
  v_lab := v.kind = 'lab' and public.ops_has_role(p_clinic, p_actor, array['lab']::public.staff_role[]);
  if not v_desk and not v_own_doctor and not v_lab then
    raise exception using message = 'operations: not your patient', errcode = '42501', hint = 'forbidden';
  end if;

  if v.status <> p_expected then
    raise exception using message = 'operations: the queue changed; refresh', errcode = '40001', hint = 'stale';
  end if;

  if p_status = 'called' and v.status = 'waiting' then
    update public.visits set status = 'called', called_at = now(), updated_at = now() where id = v.id returning * into v;
  elsif p_status = 'waiting' and v.status = 'called' then
    update public.visits set status = 'waiting', updated_at = now() where id = v.id returning * into v;
  elsif p_status = 'in_progress' and v.status in ('waiting', 'called') and v_lab then
    -- Sample collection begins (the samples themselves go through the lab's own flow).
    update public.visits set status = 'in_progress', started_at = now(), updated_at = now() where id = v.id returning * into v;
  elsif p_status = 'completed' and v.status = 'in_progress' and v_lab then
    update public.visits set status = 'completed', completed_at = now(), updated_at = now() where id = v.id returning * into v;
  elsif p_status = 'completed' and v.status = 'in_progress' and v_own_doctor then
    update public.visits set status = 'completed', completed_at = now(), updated_at = now() where id = v.id returning * into v;
    -- The consultation ends now, not when its booked duration would: a
    -- completed appointment still occupies its slot (no_overlapping_active_
    -- appointments), and a walk-in queue must let the doctor start the next
    -- patient at once. Never shorter than one minute (end > start).
    update public.appointments
       set status = 'completed', end_at = greatest(now(), start_at + interval '1 minute')
     where id = v.appointment_id and status = 'in_progress';
  elsif p_status = 'cancelled' and v.status in ('awaiting_payment', 'waiting', 'called') and v_desk then
    if p_reason is null or char_length(btrim(p_reason)) not between 3 and 500 then
      raise exception using message = 'operations: a reason is required', errcode = '22023', hint = 'reason_required';
    end if;
    select * into b from public.visit_balance(v.id);
    if b.collected - b.refunded > 0 then
      raise exception using message = 'operations: refund the payment before cancelling', errcode = '22023', hint = 'refund_first';
    end if;
    -- A cancelled lab walk-in takes its tests out of the laboratory's work
    -- too; once a sample is taken the lab decides (reject or result) instead.
    if v.lab_order_id is not null and exists (
      select 1 from public.lab_order_items i
       where i.order_id = v.lab_order_id and i.status not in ('ordered', 'ready_for_collection', 'cancelled')
    ) then
      raise exception using message = 'operations: a sample was already taken', errcode = '22023', hint = 'lab_sample_taken';
    end if;
    update public.visit_charges set status = 'voided', voided_by = p_actor, voided_at = now(), void_reason = 'Tashrif bekor qilindi'
     where visit_id = v.id and status = 'active';
    update public.lab_orders set status = 'cancelled', cancelled_by = p_actor, cancel_reason = 'Tashrif bekor qilindi'
     where id = v.lab_order_id and clinic_id = p_clinic and status = 'active';
    update public.visits set status = 'cancelled', cancelled_at = now(), cancel_reason = btrim(p_reason), updated_at = now()
     where id = v.id returning * into v;
  else
    raise exception using message = 'operations: this change is not allowed', errcode = '22023', hint = 'invalid_transition';
  end if;

  insert into public.audit_events (clinic_id, actor_id, actor_type, action, entity_type, entity_id, old_values, new_values)
  values (p_clinic, p_actor, 'staff', 'visit_status_changed', 'visits', v.id::text,
          jsonb_build_object('status', p_expected), jsonb_build_object('status', v.status));
  return jsonb_build_object('visit_id', v.id, 'status', v.status);
end;
$$;

revoke all on function public.lab_orders_bill_to_visit() from public, anon, authenticated;
revoke all on function public.lab_items_charge_visit() from public, anon, authenticated;
revoke all on function public.payments_skip_visit_billed_lab_order() from public, anon, authenticated;
revoke all on function public.lab_items_void_visit_charge() from public, anon, authenticated;
revoke all on function public.register_lab_arrival(uuid, uuid, uuid, uuid, jsonb, uuid[], uuid[]) from public, anon, authenticated;
grant execute on function public.register_lab_arrival(uuid, uuid, uuid, uuid, jsonb, uuid[], uuid[]) to service_role;

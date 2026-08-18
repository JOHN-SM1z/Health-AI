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
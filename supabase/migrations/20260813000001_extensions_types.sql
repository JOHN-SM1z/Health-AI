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

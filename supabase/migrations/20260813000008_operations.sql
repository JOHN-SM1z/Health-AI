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
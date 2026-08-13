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
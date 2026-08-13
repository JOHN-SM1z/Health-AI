-- 0012: Conversation state persistence for multi-step bot flows.

alter table public.conversations
  add column if not exists state jsonb not null default '{}'::jsonb;
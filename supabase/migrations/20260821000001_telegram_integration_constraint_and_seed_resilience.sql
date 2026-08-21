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

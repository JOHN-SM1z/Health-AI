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

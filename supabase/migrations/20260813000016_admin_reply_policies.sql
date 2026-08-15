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

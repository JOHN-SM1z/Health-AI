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

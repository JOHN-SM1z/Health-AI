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

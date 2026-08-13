-- 0011: Private storage for voice messages.
-- The bucket is PRIVATE. Files are stored under <clinic_id>/<voice_message_id>.
-- Only the service role (server-side code) can upload; clinic staff can read
-- files belonging to their own clinic (for authorized admin review).

insert into storage.buckets (id, name, public)
values ('voice-messages', 'voice-messages', false)
on conflict (id) do nothing;

drop policy if exists "voice-messages service role access" on storage.objects;
create policy "voice-messages service role access"
  on storage.objects
  for all
  to service_role
  using (bucket_id = 'voice-messages')
  with check (bucket_id = 'voice-messages');

drop policy if exists "voice-messages staff read" on storage.objects;
create policy "voice-messages staff read"
  on storage.objects
  for select
  to authenticated
  using (
    bucket_id = 'voice-messages'
    and exists (
      select 1
      from public.staff_roles sr
      where sr.profile_id = auth.uid()
        and sr.clinic_id::text = (storage.foldername(name))[1]
    )
  );
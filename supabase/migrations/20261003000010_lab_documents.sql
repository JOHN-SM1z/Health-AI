-- Laboratory module, phase 7: result documents (a PDF report, a scan, a photo, an imported report) in the EXISTING private storage.
--
-- Same architecture as the voice-messages bucket (20260813000011): a PRIVATE bucket, objects under <clinic_id>/..., access only through
-- the server. Unlike voice files there is NO staff read policy and no signed or public URL of any kind: a laboratory document is
-- clinical, so every download goes through a server route that re-checks the clinic, the patient, the caller's authorisation and the
-- document-to-result relationship for that request (see src/lib/labs/documents.ts). Nothing here makes a document reachable by
-- knowing, guessing or forging a URL.
--
--   * bucket `lab-documents`: private, 10 MiB, PDF/PNG/JPEG only (the server also checks the file's real signature).
--   * lab_result_attachments gains `kind` (report, scan, image, imported) and a validation trigger: uploaded by an ACTIVE laboratory
--     user, the path is <clinic>/<patient>/<result>/<file> of THIS result (a row cannot point at another patient's object), at most 20
--     per result, nothing for a cancelled order or test, and no document is added to a result that is verified and not under
--     correction - a finalised result is not silently changed (start a correction first). Rows are never updated or deleted by the
--     application roles; the database audit trigger records every addition (ids and the content type only).
--   * Doctors see a document only through the longitudinal route, and only when its result has a verified version that was verified
--     after the document was added (a document of work in progress is never shown as part of a result).
--
-- Reversible: drop the trigger and column; the bucket (and any object in it) is removed by hand.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('lab-documents', 'lab-documents', false, 10485760, array['application/pdf', 'image/png', 'image/jpeg'])
on conflict (id) do update set public = false, file_size_limit = 10485760, allowed_mime_types = array['application/pdf', 'image/png', 'image/jpeg'];

drop policy if exists "lab-documents service role access" on storage.objects;
create policy "lab-documents service role access"
  on storage.objects
  for all
  to service_role
  using (bucket_id = 'lab-documents')
  with check (bucket_id = 'lab-documents');

-- Phase 2's path check used a repetition count of 300, which PostgreSQL's regex engine rejects (the limit is 255): no row could ever
-- be inserted. The same rule, written so that it can be evaluated.
alter table public.lab_result_attachments drop constraint lab_result_attachments_storage_path_check;
alter table public.lab_result_attachments add constraint lab_result_attachments_storage_path_check
  check (storage_path ~ '^[A-Za-z0-9/_.-]+$' and char_length(storage_path) <= 300);

alter table public.lab_result_attachments add column kind text not null default 'report'
  check (kind in ('report', 'scan', 'image', 'imported'));
grant select (kind) on public.lab_result_attachments to service_role;
grant insert (kind) on public.lab_result_attachments to service_role;

create or replace function public.lab_attachments_validate()
returns trigger
-- SECURITY INVOKER on purpose: the immutability rule below depends on who is calling (current_user).
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_patient uuid;
  v_count int;
begin
  if tg_op <> 'INSERT' then
    if current_user in ('service_role', 'authenticated', 'anon') then
      raise exception 'lab document: a document is never edited or removed';
    end if;
    return case tg_op when 'DELETE' then old else new end;
  end if;

  select r.patient_id into v_patient from public.lab_results r where r.id = new.result_id and r.clinic_id = new.clinic_id;
  if not found then
    return new; -- the foreign key reports it
  end if;
  if not public.lab_staff_is_active(new.uploaded_by, new.clinic_id) then
    raise exception 'lab document: only active lab staff of the clinic add documents';
  end if;
  if not public.lab_result_work_open(new.result_id) then
    raise exception 'lab document: the order or the test is cancelled';
  end if;
  if new.storage_path not like new.clinic_id::text || '/' || v_patient::text || '/' || new.result_id::text || '/%' then
    raise exception 'lab document: the path must lie under this result''s own folder';
  end if;
  if exists (select 1 from public.lab_result_versions v where v.result_id = new.result_id and v.status = 'verified')
     and not exists (select 1 from public.lab_result_versions v where v.result_id = new.result_id and v.status in ('draft', 'pending_verification')) then
    raise exception 'lab document: the result is verified; start a correction to add a document';
  end if;
  select count(*) into v_count from public.lab_result_attachments a where a.result_id = new.result_id;
  if v_count >= 20 then
    raise exception 'lab document: a result holds at most 20 documents';
  end if;
  new.created_at := now();
  return new;
end;
$$;

create trigger lab_result_attachments_validate before insert or update or delete on public.lab_result_attachments
  for each row execute function public.lab_attachments_validate();

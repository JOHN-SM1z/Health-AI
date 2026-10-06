-- Laboratory (Phase 11): result documents in the existing private storage.
--
-- Files live in the private bucket lab-documents (Phase 2, same pattern as
-- voice-messages): <clinic_id>/<document id>, no policy for anon or
-- authenticated — bytes are delivered only through short-lived signed URLs the
-- server issues after authorization. lab_documents keeps clinic, patient,
-- order, result, kind, type, size, SHA-256, uploader and time; documents are
-- withdrawn with a reason, never deleted, and their bytes are retained.
--
-- Two rules added here:
--   * a document is attached to a result only while that result is a draft
--     or awaiting review — a verified version's evidence is final, and a
--     corrected report goes with its correction (a new version);
--   * a draft with attached documents cannot be discarded.

create or replace function public.lab_documents_validate()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    if public.lab_clinic_is_being_erased(old.clinic_id) then
      return old;
    end if;
    raise exception 'lab document: documents are withdrawn, never deleted';
  end if;

  if tg_op = 'INSERT' then
    new.created_at := now();
    if new.withdrawn_at is not null then
      raise exception 'lab document: a new document cannot be withdrawn';
    end if;
    if not public.lab_is_clinic_member(new.clinic_id, new.uploaded_by) then
      raise exception 'lab document: uploaded_by must be a staff member of the clinic';
    end if;
    if new.result_id is not null and not exists (
      select 1
      from public.lab_results r
      join public.lab_order_items i on i.id = r.order_item_id
      where r.id = new.result_id and i.order_id = new.order_id
    ) then
      raise exception 'lab document: the result belongs to another order';
    end if;
    -- Evidence is attached while the result is being entered or reviewed. A
    -- verified (or superseded) version is final: a corrected report belongs
    -- to its correction.
    if new.result_id is not null and not exists (
      select 1 from public.lab_results r where r.id = new.result_id and r.status in ('draft', 'submitted')
    ) then
      raise exception 'lab_document_result_final: documents are attached to a result before it is verified';
    end if;
    return new;
  end if;

  perform public.lab_assert_only_changed(
    to_jsonb(old), to_jsonb(new), array['withdrawn_at', 'withdrawn_by', 'withdraw_reason'], 'lab document');
  if old.withdrawn_at is not null then
    raise exception 'lab document: already withdrawn';
  end if;
  if new.withdrawn_by is null or not public.lab_is_clinic_member(new.clinic_id, new.withdrawn_by) then
    raise exception 'lab document: withdrawn_by must be a staff member of the clinic';
  end if;
  new.withdrawn_at := now();
  return new;
end;
$$;

create or replace function public.discard_lab_result_draft(p_clinic_id uuid, p_result_id uuid, p_by uuid)
returns boolean
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_result public.lab_results;
begin
  if not public.lab_is_clinic_member(p_clinic_id, p_by) then
    raise exception 'lab_result_not_found: the result is not in this clinic';
  end if;
  perform set_config('app.lab_actor', p_by::text, true);

  select * into v_result from public.lab_results r
  where r.id = p_result_id and r.clinic_id = p_clinic_id
  for update;
  if not found then
    raise exception 'lab_result_not_found: the result is not in this clinic (or was already discarded)';
  end if;
  if v_result.status <> 'draft' then
    raise exception 'lab_result_submitted: only a draft can be discarded (the result is %)', v_result.status;
  end if;
  -- Attached documents are retained clinical records (withdrawn, never
  -- deleted), so a draft that has any cannot disappear under them.
  if exists (select 1 from public.lab_documents d where d.result_id = v_result.id) then
    raise exception 'lab_result_has_documents: a draft with attached documents cannot be discarded';
  end if;
  delete from public.lab_results where id = v_result.id;
  return true;
end;
$$;

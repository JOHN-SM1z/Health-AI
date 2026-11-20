-- Laboratory (Phase 9): verification, return for rework, corrections as
-- new versions.
--
-- Lifecycle of one version (lab_result_status, unchanged):
--   draft → submitted ("review") → verified → superseded
--            ↖ returned ↙
-- RESULT_READY in the prompt is a verified result that the clinic releases
-- to the patient (settings.releaseToPatient, Phase 12) — not another status.
--
--   verify_lab_result          a second person (never who entered or
--                              submitted it — O4, also a CHECK constraint)
--                              verifies a submitted version. The row is
--                              locked: of two verifiers, one wins; the other
--                              is told it is no longer awaiting review.
--                              Verifying a correction retires the version it
--                              corrects in the same statement (existing
--                              trigger). When every test of the order is
--                              verified or cancelled, the order completes.
--   return_lab_result          a reviewer (or the author) sends a submitted
--                              version back to its author as a draft.
--   start_lab_result_correction a verified result is never edited: a
--                              correction is version n+1 (supersedes the
--                              current verified version, reason required),
--                              starting from its values; it is entered,
--                              submitted and verified like any result. Until
--                              then the earlier version stays the verified
--                              one. Every version keeps its author, times,
--                              submitter and verifier.
--
-- save_lab_result_draft now edits the version in progress, first result or
-- correction alike. Trigger-written audit rows name the acting staff member
-- (lab_current_actor) for order, item, sample and result changes.

create or replace function public.lab_workflow_audit()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_action text;
  v_actor uuid;
  v_values jsonb;
begin
  if tg_table_name = 'lab_orders' then
    if tg_op = 'INSERT' then
      v_action := 'lab_order_created';
      v_actor := new.ordered_by;
    elsif new.status is distinct from old.status then
      v_action := 'lab_order_' || new.status::text;
      v_actor := coalesce(new.cancelled_by, public.lab_current_actor());
    else
      return null;
    end if;
    v_values := jsonb_build_object('status', new.status, 'source', new.source,
                                   'ordering_doctor_id', new.ordering_doctor_id, 'appointment_id', new.appointment_id);
  elsif tg_table_name = 'lab_order_items' then
    if tg_op = 'INSERT' then
      v_action := 'lab_order_item_created';
    elsif new.status is distinct from old.status then
      v_action := 'lab_order_item_status_changed';
    else
      return null;
    end if;
    v_actor := coalesce(new.status_changed_by, public.lab_current_actor());
    v_values := jsonb_build_object('order_id', new.order_id, 'test_id', new.test_id, 'status', new.status,
                                   'previous_status', case when tg_op = 'UPDATE' then old.status end);
  elsif tg_table_name = 'lab_samples' then
    if tg_op = 'INSERT' then
      v_action := 'lab_sample_collected';
      v_actor := new.collected_by;
    elsif new.status is distinct from old.status then
      v_action := 'lab_sample_' || new.status::text;
      v_actor := coalesce(new.rejected_by, new.received_by, public.lab_current_actor());
    else
      return null;
    end if;
    v_values := jsonb_build_object('order_id', new.order_id, 'status', new.status);
  else
    return null;
  end if;

  insert into public.audit_events (clinic_id, actor_id, actor_type, action, entity_type, entity_id, patient_id, new_values)
  values (
    new.clinic_id,
    v_actor,
    case when v_actor is null then 'system'::public.actor_type else 'staff'::public.actor_type end,
    v_action,
    tg_table_name,
    new.id::text,
    new.patient_id,
    v_values
  );
  return null;
end;
$$;

create or replace function public.lab_results_sync_item()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_item public.lab_order_items;
  v_target public.lab_item_status;
  v_actor uuid;
begin
  if new.supersedes_result_id is not null then
    return null;
  end if;
  select * into v_item from public.lab_order_items where id = new.order_item_id;

  if tg_op = 'INSERT' then
    v_target := case when v_item.status = 'collected' then 'processing'::public.lab_item_status end;
    v_actor := new.entered_by;
  elsif new.status = 'submitted' and old.status = 'draft' then
    v_target := 'resulted';
    v_actor := new.submitted_by;
  elsif new.status = 'draft' and old.status = 'submitted' then
    v_target := 'processing';
    v_actor := public.lab_current_actor();
  elsif new.status = 'verified' and old.status = 'submitted' then
    v_target := 'verified';
    v_actor := new.verified_by;
  end if;

  if v_target is not null and v_target is distinct from v_item.status then
    update public.lab_order_items
    set status = v_target, status_changed_by = v_actor
    where id = new.order_item_id;
  end if;
  return null;
end;
$$;

create or replace function public.save_lab_result_draft(
  p_clinic_id uuid,
  p_order_item_id uuid,
  p_entered_by uuid,
  p_values jsonb,
  p_lab_comment text default null,
  p_performed_at timestamptz default null
)
returns table (lab_result_id uuid, created boolean)
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_item public.lab_order_items;
  v_source public.lab_order_source;
  v_result public.lab_results;
  v_created boolean := false;
  v_entry jsonb;
  v_param uuid;
begin
  if p_values is null or jsonb_typeof(p_values) <> 'array' then
    raise exception 'lab_result_bad_values: values must be a list';
  end if;
  if jsonb_array_length(p_values) > 200 then
    raise exception 'lab_result_bad_values: too many values';
  end if;
  if (select count(distinct e->>'parameter_id') from jsonb_array_elements(p_values) e) <> jsonb_array_length(p_values) then
    raise exception 'lab_result_bad_values: a parameter is given twice';
  end if;

  perform set_config('app.lab_actor', p_entered_by::text, true);

  -- One writer per item at a time.
  select * into v_item from public.lab_order_items i
  where i.id = p_order_item_id and i.clinic_id = p_clinic_id
  for update;
  if not found then
    raise exception 'lab_result_unknown_item: the test is not in this clinic';
  end if;
  select o.source into v_source from public.lab_orders o where o.id = v_item.order_id;
  if v_source = 'external_import' then
    raise exception 'lab_result_imported: results of imported orders are recorded by the import';
  end if;

  -- The version in progress (a first result or a correction), if any.
  select * into v_result from public.lab_results r
  where r.order_item_id = v_item.id and r.status in ('draft', 'submitted')
  for update;

  if found then
    if v_result.status = 'submitted' then
      raise exception 'lab_result_submitted: the result was submitted for verification';
    elsif v_result.entered_by <> p_entered_by then
      raise exception 'lab_result_draft_owned: another staff member is entering this result';
    end if;
  elsif exists (select 1 from public.lab_results r where r.order_item_id = v_item.id and r.status = 'verified') then
    raise exception 'lab_result_verified: the result is verified; a change is a correction';
  else
    if v_item.status <> 'processing' then
      raise exception 'lab_result_item_not_ready: results are entered once the lab has received the sample (the test is %)', v_item.status;
    end if;
    insert into public.lab_results (clinic_id, patient_id, order_item_id, entered_by, source)
    values (p_clinic_id, v_item.patient_id, v_item.id, p_entered_by, 'manual')
    returning * into v_result;
    v_created := true;
  end if;

  if v_result.lab_comment is distinct from nullif(btrim(coalesce(p_lab_comment, '')), '')
     or v_result.performed_at is distinct from p_performed_at then
    update public.lab_results
    set lab_comment = nullif(btrim(coalesce(p_lab_comment, '')), ''), performed_at = p_performed_at
    where id = v_result.id;
  end if;

  for v_entry in select * from jsonb_array_elements(p_values) loop
    begin
      v_param := (v_entry->>'parameter_id')::uuid;
    exception when others then
      raise exception 'lab_result_bad_values: unknown parameter';
    end;
    if v_param is null then
      raise exception 'lab_result_bad_values: unknown parameter';
    end if;
    if not exists (
      select 1 from public.lab_test_parameters p
      where p.id = v_param and p.clinic_id = p_clinic_id and p.test_id = v_item.test_id
    ) then
      raise exception 'lab_result_bad_values: a parameter does not belong to this test';
    end if;

    if coalesce((v_entry->>'clear')::boolean, false) then
      delete from public.lab_result_values v where v.result_id = v_result.id and v.parameter_id = v_param;
    else
      insert into public.lab_result_values (clinic_id, result_id, parameter_id, value_numeric, value_text, value_boolean)
      values (
        p_clinic_id, v_result.id, v_param,
        (v_entry->>'value_numeric')::numeric,
        nullif(btrim(v_entry->>'value_text'), ''),
        (v_entry->>'value_boolean')::boolean
      )
      on conflict (result_id, parameter_id) do update
      set value_numeric = excluded.value_numeric,
          value_text = excluded.value_text,
          value_boolean = excluded.value_boolean;
    end if;
  end loop;

  return query select v_result.id, v_created;
end;
$$;

-- ---------------------------------------------------------------------------
-- verify / return
-- ---------------------------------------------------------------------------

create or replace function public.verify_lab_result(p_clinic_id uuid, p_result_id uuid, p_verified_by uuid)
returns boolean
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_result public.lab_results;
  v_order uuid;
begin
  perform set_config('app.lab_actor', p_verified_by::text, true);

  select * into v_result from public.lab_results r
  where r.id = p_result_id and r.clinic_id = p_clinic_id
  for update;
  if not found then
    raise exception 'lab_result_not_found: the result is not in this clinic';
  end if;
  if v_result.status = 'verified' and v_result.verified_by = p_verified_by then
    return false; -- already verified by this person: nothing to do
  end if;
  if v_result.status <> 'submitted' then
    raise exception 'lab_result_not_submitted: the result is % (not awaiting review)', v_result.status;
  end if;
  if p_verified_by = v_result.entered_by or p_verified_by = v_result.submitted_by then
    raise exception 'lab_result_second_person: a second person must verify the result';
  end if;

  update public.lab_results set status = 'verified', verified_by = p_verified_by where id = v_result.id;

  -- The order is complete once every test is verified or cancelled.
  select i.order_id into v_order from public.lab_order_items i where i.id = v_result.order_item_id;
  perform 1 from public.lab_orders o where o.id = v_order for update;
  if exists (select 1 from public.lab_orders o where o.id = v_order and o.status = 'active')
     and not exists (
       select 1 from public.lab_order_items i
       where i.order_id = v_order and i.status not in ('verified', 'cancelled')
     ) then
    update public.lab_orders set status = 'completed' where id = v_order;
  end if;
  return true;
end;
$$;

create or replace function public.return_lab_result(p_clinic_id uuid, p_result_id uuid, p_by uuid)
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
    raise exception 'lab_result_not_found: the result is not in this clinic';
  end if;
  if v_result.status <> 'submitted' then
    raise exception 'lab_result_not_submitted: the result is % (not awaiting review)', v_result.status;
  end if;
  update public.lab_results set status = 'draft' where id = v_result.id;
  return true;
end;
$$;

-- ---------------------------------------------------------------------------
-- start_lab_result_correction
-- ---------------------------------------------------------------------------

create or replace function public.start_lab_result_correction(
  p_clinic_id uuid,
  p_result_id uuid,
  p_by uuid,
  p_reason text
)
returns table (lab_result_id uuid, created boolean)
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_target public.lab_results;
  v_existing public.lab_results;
  v_new uuid;
begin
  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'lab_result_reason_required: a correction needs a reason';
  end if;
  perform set_config('app.lab_actor', p_by::text, true);

  -- Lock the item first (the same order as entry), then the version.
  perform 1 from public.lab_order_items i
  join public.lab_results r on r.order_item_id = i.id
  where r.id = p_result_id and r.clinic_id = p_clinic_id
  for update of i;

  select * into v_target from public.lab_results r
  where r.id = p_result_id and r.clinic_id = p_clinic_id
  for update;
  if not found then
    raise exception 'lab_result_not_found: the result is not in this clinic';
  end if;

  select * into v_existing from public.lab_results r
  where r.order_item_id = v_target.order_item_id and r.status in ('draft', 'submitted');
  if found then
    if v_existing.supersedes_result_id = v_target.id and v_existing.entered_by = p_by and v_existing.status = 'draft' then
      return query select v_existing.id, false; -- the same person's correction in progress
      return;
    end if;
    raise exception 'lab_result_correction_exists: a correction of this result is already in progress';
  end if;
  if v_target.status <> 'verified' then
    raise exception 'lab_result_not_current: only the current verified result can be corrected (this one is %)', v_target.status;
  end if;

  insert into public.lab_results (
    clinic_id, patient_id, order_item_id, version, supersedes_result_id, source,
    entered_by, correction_reason, lab_comment, performed_at)
  values (
    p_clinic_id, v_target.patient_id, v_target.order_item_id, v_target.version + 1, v_target.id, 'manual',
    p_by, btrim(p_reason), v_target.lab_comment, v_target.performed_at)
  returning id into v_new;

  -- Start from the verified values (active parameters); unit, range and flag
  -- are set again by the value trigger from the current configuration.
  insert into public.lab_result_values (clinic_id, result_id, parameter_id, value_numeric, value_text, value_boolean)
  select v.clinic_id, v_new, v.parameter_id, v.value_numeric, v.value_text, v.value_boolean
  from public.lab_result_values v
  join public.lab_test_parameters p on p.id = v.parameter_id
  where v.result_id = v_target.id and p.active;

  return query select v_new, true;
end;
$$;

revoke all on function public.verify_lab_result(uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function public.return_lab_result(uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function public.start_lab_result_correction(uuid, uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.verify_lab_result(uuid, uuid, uuid) to service_role;
grant execute on function public.return_lab_result(uuid, uuid, uuid) to service_role;
grant execute on function public.start_lab_result_correction(uuid, uuid, uuid, text) to service_role;

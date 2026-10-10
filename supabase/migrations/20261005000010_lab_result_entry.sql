-- Laboratory (Phase 8): structured result entry.
--
-- Lab staff enter one draft result per order item, parameter by parameter,
-- and submit it for second-person verification (Phase 9). Three server-only
-- functions do each step in one transaction:
--
--   save_lab_result_draft   creates the item's first draft if there is none
--                           (the sample must have been received: item
--                           status processing) and sets or clears values,
--                           the lab comment and the performed time. Only the
--                           person who started a draft changes it: a value
--                           silently added by someone else would let that
--                           person verify a result they partly entered (O4).
--   submit_lab_result       the person who entered the draft submits it,
--                           once every active parameter has a value; the
--                           item becomes resulted. A submitted result is not
--                           edited — it is verified or returned (Phase 9).
--   discard_lab_result_draft  any lab staff member may discard a draft (for
--                           example one left by a colleague); audited.
--
-- Values are validated by type in lab_result_values_validate (numeric /
-- text / boolean / choice, configured choices, now also the configured
-- number of decimal places). The unit, the reference range used and the flag
-- are still set by the database from the clinic's configuration: the flag
-- only places a value against the configured range, never interprets it.
--
-- lab_applicable_range() is the single choice of reference range, used both
-- when a value is stored and when the entry screen shows the range before a
-- value is typed, so the two can never disagree.
--
-- Corrections of verified results are Phase 9 and are refused here.

-- ---------------------------------------------------------------------------
-- The acting staff member for audit rows written by triggers. The server
-- runs as service_role (auth.uid() is null), so the entry functions name the
-- actor for the transaction.
-- ---------------------------------------------------------------------------

create or replace function public.lab_current_actor()
returns uuid
language sql
stable
set search_path = public, pg_temp
as $$
  select coalesce(nullif(current_setting('app.lab_actor', true), '')::uuid, auth.uid());
$$;

revoke all on function public.lab_current_actor() from public, anon, authenticated;
grant execute on function public.lab_current_actor() to service_role;

create or replace function public.lab_results_audit()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_action text;
  v_actor uuid;
  v_row public.lab_results;
begin
  if tg_op = 'DELETE' then
    v_row := old;
    v_action := 'lab_result_draft_discarded';
    v_actor := public.lab_current_actor();
  else
    v_row := new;
    if tg_op = 'INSERT' then
      v_action := case when new.supersedes_result_id is null then 'lab_result_entered' else 'lab_result_correction_started' end;
      v_actor := new.entered_by;
    elsif new.status = old.status then
      return null;
    elsif new.status = 'submitted' then
      v_action := 'lab_result_submitted';
      v_actor := new.submitted_by;
    elsif new.status = 'draft' then
      v_action := 'lab_result_returned';
      v_actor := public.lab_current_actor();
    elsif new.status = 'verified' then
      v_action := case when new.supersedes_result_id is null then 'lab_result_verified' else 'lab_result_corrected' end;
      v_actor := new.verified_by;
    else
      v_action := 'lab_result_superseded';
      v_actor := public.lab_current_actor();
    end if;
  end if;

  if public.lab_clinic_is_being_erased(v_row.clinic_id) then
    return null;
  end if;

  insert into public.audit_events (clinic_id, actor_id, actor_type, action, entity_type, entity_id, patient_id, new_values)
  values (
    v_row.clinic_id,
    v_actor,
    case when v_actor is null then 'system'::public.actor_type else 'staff'::public.actor_type end,
    v_action,
    'lab_results',
    v_row.id::text,
    v_row.patient_id,
    jsonb_build_object('order_item_id', v_row.order_item_id, 'version', v_row.version, 'status', v_row.status,
                       'source', v_row.source, 'supersedes_result_id', v_row.supersedes_result_id)
  );
  return null;
end;
$$;

-- ---------------------------------------------------------------------------
-- Reference range choice
-- ---------------------------------------------------------------------------

-- The most specific active range for a patient: a sex-specific range before
-- an any-sex one, an age band before an open one, the narrowest band first.
-- Unknown sex only matches any-sex ranges; unknown age only matches ranges
-- without an age band.
create or replace function public.lab_applicable_range(
  p_parameter_id uuid,
  p_sex public.patient_sex,
  p_age_days integer
)
returns setof public.lab_reference_ranges
language sql
stable
set search_path = public, pg_temp
as $$
  select r.*
  from public.lab_reference_ranges r
  where r.parameter_id = p_parameter_id
    and r.active
    and (r.sex is null or r.sex = p_sex)
    and (
      (r.age_min_days is null and r.age_max_days is null)
      or (p_age_days is not null
          and p_age_days >= coalesce(r.age_min_days, 0)
          and p_age_days <= coalesce(r.age_max_days, 2147483647))
    )
  order by (r.sex is not null) desc,
           num_nonnulls(r.age_min_days, r.age_max_days) desc,
           coalesce(r.age_max_days, 2147483647)::bigint - coalesce(r.age_min_days, 0) asc
  limit 1;
$$;

revoke all on function public.lab_applicable_range(uuid, public.patient_sex, integer) from public, anon, authenticated;

create or replace function public.lab_result_values_validate()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_result public.lab_results;
  v_param public.lab_test_parameters;
  v_test_id uuid;
  v_sex public.patient_sex;
  v_dob date;
  v_age integer;
  v_range public.lab_reference_ranges;
  v_actual text;
begin
  if tg_op = 'DELETE' then
    select * into v_result from public.lab_results r where r.id = old.result_id;
    -- Gone (a discarded draft cascading), still a draft, or the clinic is
    -- being erased.
    if v_result.id is null or v_result.status = 'draft' or public.lab_clinic_is_being_erased(old.clinic_id) then
      return old;
    end if;
    raise exception 'lab result value: values of a % result cannot be removed', v_result.status;
  end if;

  select * into v_result from public.lab_results r
  where r.id = new.result_id and r.clinic_id = new.clinic_id;
  if v_result.status is distinct from 'draft' then
    raise exception 'lab result value: only a draft result accepts values';
  end if;
  if tg_op = 'UPDATE' and (new.result_id <> old.result_id or new.parameter_id <> old.parameter_id or new.clinic_id <> old.clinic_id) then
    raise exception 'lab result value: result and parameter cannot change';
  end if;

  select * into v_param from public.lab_test_parameters p
  where p.id = new.parameter_id and p.clinic_id = new.clinic_id;
  select i.test_id into v_test_id from public.lab_order_items i where i.id = v_result.order_item_id;
  if v_param.test_id is distinct from v_test_id then
    raise exception 'lab result value: the parameter does not belong to the ordered test';
  end if;
  if not v_param.active and v_result.source = 'manual' then
    raise exception 'lab result value: parameter % is inactive', v_param.code;
  end if;

  -- The value must match the parameter's type.
  if (v_param.value_type = 'numeric' and new.value_numeric is null)
     or (v_param.value_type = 'boolean' and new.value_boolean is null)
     or (v_param.value_type in ('text', 'choice') and new.value_text is null) then
    raise exception 'lab result value: % expects a % value', v_param.code, v_param.value_type;
  end if;
  if v_param.value_type = 'choice' and not (new.value_text = any (v_param.choices)) then
    raise exception 'lab result value: % is not one of the configured choices of %', new.value_text, v_param.code;
  end if;

  if v_param.value_type = 'numeric' and v_param.decimals is not null
     and new.value_numeric <> round(new.value_numeric, v_param.decimals) then
    raise exception 'lab result value: % takes at most % decimal places', v_param.code, v_param.decimals;
  end if;

  -- Configuration, not the caller, sets everything below.
  new.unit_snapshot := v_param.unit;
  new.reference_range_id := null;
  new.range_low := null;
  new.range_high := null;
  new.range_text := null;
  new.critical_low := null;
  new.critical_high := null;
  new.flag := 'not_evaluated';
  if tg_op = 'INSERT' then
    new.created_at := now();
  else
    new.created_at := old.created_at;
  end if;
  new.updated_at := now();

  select p.sex, p.date_of_birth into v_sex, v_dob
  from public.patients p
  where p.id = v_result.patient_id;
  if v_dob is not null then
    v_age := (coalesce(v_result.performed_at, now()) at time zone 'UTC')::date - v_dob;
  end if;

  -- The most specific active range for this patient (lab_applicable_range).
  select * into v_range from public.lab_applicable_range(new.parameter_id, v_sex, v_age);

  if v_range.id is not null then
    new.reference_range_id := v_range.id;
    new.range_low := v_range.low;
    new.range_high := v_range.high;
    new.range_text := v_range.normal_text;
    new.critical_low := v_range.critical_low;
    new.critical_high := v_range.critical_high;

    if v_param.value_type = 'numeric' then
      new.flag := case
        when v_range.critical_low is not null and new.value_numeric < v_range.critical_low then 'critical_low'
        when v_range.critical_high is not null and new.value_numeric > v_range.critical_high then 'critical_high'
        when v_range.low is not null and new.value_numeric < v_range.low then 'low'
        when v_range.high is not null and new.value_numeric > v_range.high then 'high'
        when v_range.low is null and v_range.high is null then 'not_evaluated'
        else 'normal'
      end::public.lab_value_flag;
    elsif v_range.normal_text is not null then
      v_actual := case when v_param.value_type = 'boolean' then new.value_boolean::text else new.value_text end;
      new.flag := case
        when lower(btrim(v_actual)) = lower(btrim(v_range.normal_text)) then 'normal'
        else 'abnormal'
      end::public.lab_value_flag;
    end if;
  end if;
  return new;
end;
$$;


-- The range each parameter of an item's test would use for its patient now.
create or replace function public.lab_entry_ranges(p_clinic_id uuid, p_order_item_id uuid)
returns table (
  parameter_id uuid,
  range_low numeric,
  range_high numeric,
  range_text text,
  critical_low numeric,
  critical_high numeric
)
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select p.id, r.low, r.high, r.normal_text, r.critical_low, r.critical_high
  from public.lab_order_items i
  join public.patients pt on pt.id = i.patient_id and pt.clinic_id = i.clinic_id
  join public.lab_test_parameters p on p.test_id = i.test_id and p.clinic_id = i.clinic_id
  left join lateral public.lab_applicable_range(
    p.id, pt.sex,
    case when pt.date_of_birth is not null then (now() at time zone 'UTC')::date - pt.date_of_birth end
  ) r on true
  where i.id = p_order_item_id and i.clinic_id = p_clinic_id;
$$;

-- ---------------------------------------------------------------------------
-- save_lab_result_draft
-- ---------------------------------------------------------------------------

-- p_values: [{"parameter_id": uuid, "value_numeric"|"value_text"|"value_boolean": …}]
-- or {"parameter_id": uuid, "clear": true} to remove a value from the draft.
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

  select * into v_result from public.lab_results r
  where r.order_item_id = v_item.id and r.supersedes_result_id is null and r.status <> 'superseded'
  for update;

  if found then
    if v_result.status = 'submitted' then
      raise exception 'lab_result_submitted: the result was submitted for verification';
    elsif v_result.status = 'verified' then
      raise exception 'lab_result_verified: the result is verified; a change is a correction';
    elsif v_result.entered_by <> p_entered_by then
      raise exception 'lab_result_draft_owned: another staff member is entering this result';
    end if;
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
-- submit_lab_result / discard_lab_result_draft
-- ---------------------------------------------------------------------------

create or replace function public.submit_lab_result(p_clinic_id uuid, p_result_id uuid, p_submitted_by uuid)
returns boolean
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_result public.lab_results;
  v_test uuid;
  v_missing integer;
begin
  perform set_config('app.lab_actor', p_submitted_by::text, true);

  select * into v_result from public.lab_results r
  where r.id = p_result_id and r.clinic_id = p_clinic_id
  for update;
  if not found then
    raise exception 'lab_result_not_found: the result is not in this clinic';
  end if;
  if v_result.status = 'submitted' and v_result.submitted_by = p_submitted_by then
    return false; -- already submitted by this person: nothing to do
  end if;
  if v_result.status <> 'draft' then
    raise exception 'lab_result_submitted: the result is %', v_result.status;
  end if;
  if v_result.entered_by <> p_submitted_by then
    raise exception 'lab_result_draft_owned: only the person who entered the result submits it';
  end if;

  select i.test_id into v_test from public.lab_order_items i where i.id = v_result.order_item_id;
  select count(*) into v_missing
  from public.lab_test_parameters p
  where p.test_id = v_test and p.clinic_id = p_clinic_id and p.active
    and not exists (select 1 from public.lab_result_values v where v.result_id = v_result.id and v.parameter_id = p.id);
  if v_missing > 0 then
    raise exception 'lab_result_incomplete: % parameter(s) have no value', v_missing;
  end if;

  update public.lab_results set status = 'submitted', submitted_by = p_submitted_by where id = v_result.id;
  return true;
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
  delete from public.lab_results where id = v_result.id;
  return true;
end;
$$;

revoke all on function public.lab_entry_ranges(uuid, uuid) from public, anon, authenticated;
revoke all on function public.save_lab_result_draft(uuid, uuid, uuid, jsonb, text, timestamptz) from public, anon, authenticated;
revoke all on function public.submit_lab_result(uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function public.discard_lab_result_draft(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.lab_applicable_range(uuid, public.patient_sex, integer) to service_role;
grant execute on function public.lab_entry_ranges(uuid, uuid) to service_role;
grant execute on function public.save_lab_result_draft(uuid, uuid, uuid, jsonb, text, timestamptz) to service_role;
grant execute on function public.submit_lab_result(uuid, uuid, uuid) to service_role;
grant execute on function public.discard_lab_result_draft(uuid, uuid, uuid) to service_role;

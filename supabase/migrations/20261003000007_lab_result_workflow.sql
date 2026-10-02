-- Laboratory module, phase 6: result entry, verification and correction as ONE transaction per step.
--
-- The phase-2 triggers already make results safe to store: values follow the configured parameters, the
-- reference bounds and the flag are copied/computed by the database, a version is append-only, one open and one
-- verified version per result, a correction names the current verified version, and the result header follows
-- the latest version. What a trigger cannot do — and these functions do — is the WORKFLOW:
--
--   * lab_result_save      — the author's draft of an item whose sample was collected; the values are replaced as one
--                            unit (all or nothing); each value gets the one generic active reference range of its
--                            parameter (lab_pick_range). Nobody but the author edits a draft; a draft awaiting
--                            verification is not edited (it is returned to draft first).
--   * lab_result_submit    — draft → pending_verification, only by the author and only when EVERY active parameter of
--                            the test has a value. When the clinic does not require verification
--                            (verification.required = false) the same step also verifies it, by the submitter — the
--                            verification is still recorded (who, when), never skipped.
--   * lab_result_verify    — pending → verified. When the clinic requires a separate verifier
--                            (verification.separateVerifier = true) the verifier cannot be the person who entered it.
--                            Two people verifying at once: the version row is locked; the second is told it is already
--                            verified (the same person repeating it is a no-op).
--   * lab_result_return    — pending → draft (a reviewer sends it back for rework).
--   * lab_result_correct   — a NEW draft version that corrects the current verified one, with a reason, copying its
--                            values. It names the version number the caller saw: a stale number (someone corrected in the
--                            meantime) or a correction already open is refused. The old version stays verified (and
--                            readable) until the correction is itself verified, when it is superseded.
--
-- Both clinic settings are read here (app_settings key `lab`): only an explicit JSON false switches verification off,
-- only an explicit JSON true requires a separate verifier — the same defaults as the settings screen.
--
-- Callable by the server only. The server has authorised the caller as lab staff of the clinic; the functions and the
-- phase-2 triggers re-check it. Reversible: drop the functions.

create or replace function public.lab_setting_bool(p_clinic uuid, p_path text[], p_default boolean)
returns boolean
language sql
stable
set search_path = public, pg_temp
as $$
  select coalesce(
    (select case when jsonb_typeof(s.value #> p_path) = 'boolean' then (s.value #>> p_path)::boolean end
       from public.app_settings s where s.clinic_id = p_clinic and s.key = 'lab'),
    p_default);
$$;

revoke all on function public.lab_setting_bool(uuid, text[], boolean) from public, anon, authenticated;
grant execute on function public.lab_setting_bool(uuid, text[], boolean) to service_role;

-- The range that applies to a parameter: its single generic (no age bounds) active range. Age-specific ranges need the
-- patient's age, which the record does not hold yet (the identity layer adds it): with none or several generic ranges the
-- value is stored without a range and shows as "no configured range" — never a guess.
create or replace function public.lab_pick_range(p_parameter uuid)
returns uuid
language sql
stable
set search_path = public, pg_temp
as $$
  select case when count(*) = 1 then (array_agg(r.id))[1] end
    from public.lab_reference_ranges r
   where r.parameter_id = p_parameter and r.active and r.age_min_years is null and r.age_max_years is null;
$$;

revoke all on function public.lab_pick_range(uuid) from public, anon, authenticated;
grant execute on function public.lab_pick_range(uuid) to service_role;

create or replace function public.lab_result_save(p_clinic uuid, p_actor uuid, p_item uuid, p_values jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_item record;
  v_result uuid;
  v_version record;
  v_val jsonb;
begin
  if not public.lab_is_lab_staff(p_actor, p_clinic) then
    raise exception 'lab result: only lab staff of the clinic enter results';
  end if;
  if p_values is null or jsonb_typeof(p_values) <> 'array' or jsonb_array_length(p_values) = 0 then
    raise exception 'lab result: a result needs at least one value';
  end if;

  select i.id, i.order_id into v_item from public.lab_order_items i where i.id = p_item and i.clinic_id = p_clinic;
  if not found then
    raise exception 'lab result: not found';
  end if;
  if not exists (
    select 1 from public.lab_sample_items si
      join public.lab_samples s on s.id = si.sample_id
     where si.order_item_id = p_item and s.clinic_id = p_clinic and s.status in ('collected', 'processing')
  ) then
    raise exception 'lab result: the sample has not been collected';
  end if;

  -- The header is created once, with the first draft. It is looked up first: an INSERT ... ON CONFLICT would still
  -- run the insert trigger, which refuses a new result for a completed order — and the draft of a CORRECTION of a
  -- completed order must stay editable.
  select r.id into v_result from public.lab_results r where r.order_item_id = p_item and r.clinic_id = p_clinic for update;
  if not found then
    insert into public.lab_results (clinic_id, order_item_id, order_id, patient_id)
    select p_clinic, p_item, v_item.order_id, o.patient_id from public.lab_orders o where o.id = v_item.order_id and o.clinic_id = p_clinic
    returning id into v_result;
  end if;

  select v.* into v_version from public.lab_result_versions v
   where v.result_id = v_result and v.status in ('draft', 'pending_verification');
  if not found then
    if exists (select 1 from public.lab_result_versions v where v.result_id = v_result) then
      raise exception 'lab result: it is already verified; start a correction to change it';
    end if;
    insert into public.lab_result_versions (clinic_id, result_id, entered_by) values (p_clinic, v_result, p_actor)
    returning * into v_version;
  elsif v_version.status = 'pending_verification' then
    raise exception 'lab result: it is awaiting verification; return it to draft to change it';
  elsif v_version.entered_by is distinct from p_actor then
    raise exception 'lab result: this draft belongs to another member of staff';
  end if;

  delete from public.lab_result_values where version_id = v_version.id;
  for v_val in select * from jsonb_array_elements(p_values) loop
    insert into public.lab_result_values (clinic_id, version_id, parameter_id, parameter_code, parameter_name, value_numeric, value_text, reference_range_id)
    values (
      p_clinic, v_version.id, (v_val ->> 'parameter_id')::uuid, '', '',
      (v_val ->> 'value_numeric')::numeric, nullif(btrim(v_val ->> 'value_text'), ''),
      public.lab_pick_range((v_val ->> 'parameter_id')::uuid)
    );
  end loop;

  return jsonb_build_object('result_id', v_result, 'version_id', v_version.id, 'version', v_version.version);
end;
$$;

create or replace function public.lab_result_submit(p_clinic uuid, p_actor uuid, p_version uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v record;
  v_missing int;
begin
  if not public.lab_is_lab_staff(p_actor, p_clinic) then
    raise exception 'lab result: only lab staff of the clinic submit results';
  end if;
  select * into v from public.lab_result_versions x where x.id = p_version and x.clinic_id = p_clinic for update;
  if not found then
    raise exception 'lab result: not found';
  end if;
  if v.entered_by is distinct from p_actor then
    raise exception 'lab result: only the author submits a draft';
  end if;
  if v.status in ('pending_verification', 'verified') then
    return jsonb_build_object('version_id', p_version, 'status', v.status, 'unchanged', true);
  end if;
  if v.status <> 'draft' then
    raise exception 'lab result: invalid version transition % -> pending_verification', v.status;
  end if;

  select count(*) into v_missing
    from public.lab_results r
    join public.lab_order_items i on i.id = r.order_item_id
    join public.lab_test_parameters p on p.test_id = i.test_id and p.clinic_id = i.clinic_id and p.active
   where r.id = v.result_id
     and not exists (select 1 from public.lab_result_values x where x.version_id = p_version and x.parameter_id = p.id);
  if v_missing > 0 then
    raise exception 'lab result: every active parameter of the test needs a value (% missing)', v_missing;
  end if;

  update public.lab_result_versions set status = 'pending_verification' where id = p_version;
  if not public.lab_setting_bool(p_clinic, array['verification', 'required'], true) then
    -- The clinic does not require a second step: the submission is recorded as verified, by the same person.
    update public.lab_result_versions set status = 'verified', verified_by = p_actor where id = p_version;
    return jsonb_build_object('version_id', p_version, 'status', 'verified', 'unchanged', false);
  end if;
  return jsonb_build_object('version_id', p_version, 'status', 'pending_verification', 'unchanged', false);
end;
$$;

create or replace function public.lab_result_verify(p_clinic uuid, p_actor uuid, p_version uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v record;
begin
  if not public.lab_is_lab_staff(p_actor, p_clinic) then
    raise exception 'lab result: only lab staff of the clinic verify results';
  end if;
  select * into v from public.lab_result_versions x where x.id = p_version and x.clinic_id = p_clinic for update;
  if not found then
    raise exception 'lab result: not found';
  end if;
  if v.status = 'verified' then
    if v.verified_by is not distinct from p_actor then
      return jsonb_build_object('version_id', p_version, 'status', 'verified', 'unchanged', true);
    end if;
    raise exception 'lab result: already verified by another member of staff';
  end if;
  if v.status <> 'pending_verification' then
    raise exception 'lab result: only a submitted version is verified (it is %)', v.status;
  end if;
  if public.lab_setting_bool(p_clinic, array['verification', 'separateVerifier'], false) and v.entered_by = p_actor then
    raise exception 'lab result: the verifier must be a different person from the one who entered it';
  end if;
  update public.lab_result_versions set status = 'verified', verified_by = p_actor where id = p_version;
  return jsonb_build_object('version_id', p_version, 'status', 'verified', 'unchanged', false);
end;
$$;

create or replace function public.lab_result_return(p_clinic uuid, p_actor uuid, p_version uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v record;
begin
  if not public.lab_is_lab_staff(p_actor, p_clinic) then
    raise exception 'lab result: only lab staff of the clinic return results';
  end if;
  select * into v from public.lab_result_versions x where x.id = p_version and x.clinic_id = p_clinic for update;
  if not found then
    raise exception 'lab result: not found';
  end if;
  if v.status = 'draft' then
    return jsonb_build_object('version_id', p_version, 'status', 'draft', 'unchanged', true);
  end if;
  if v.status <> 'pending_verification' then
    raise exception 'lab result: only a submitted version is returned to draft (it is %)', v.status;
  end if;
  update public.lab_result_versions set status = 'draft' where id = p_version;
  return jsonb_build_object('version_id', p_version, 'status', 'draft', 'unchanged', false);
end;
$$;

create or replace function public.lab_result_correct(p_clinic uuid, p_actor uuid, p_result uuid, p_expected_version int, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_current record;
  v_new record;
begin
  if not public.lab_is_lab_staff(p_actor, p_clinic) then
    raise exception 'lab result: only lab staff of the clinic correct results';
  end if;
  if p_reason is null or char_length(btrim(p_reason)) < 3 then
    raise exception 'lab result: a correction needs a reason';
  end if;

  -- Serialises corrections of one result: the second of two simultaneous corrections sees the first one's draft.
  perform 1 from public.lab_results r where r.id = p_result and r.clinic_id = p_clinic for update;
  if not found then
    raise exception 'lab result: not found';
  end if;
  if exists (select 1 from public.lab_result_versions v where v.result_id = p_result and v.status in ('draft', 'pending_verification')) then
    raise exception 'lab result: a correction is already in progress';
  end if;
  select v.* into v_current from public.lab_result_versions v where v.result_id = p_result and v.status = 'verified';
  if not found then
    raise exception 'lab result: only a verified result is corrected';
  end if;
  if v_current.version is distinct from p_expected_version then
    raise exception 'lab result: stale version (the current verified version is %)', v_current.version;
  end if;

  insert into public.lab_result_versions (clinic_id, result_id, entered_by, corrects_version_id, correction_reason)
  values (p_clinic, p_result, p_actor, v_current.id, btrim(p_reason))
  returning * into v_new;

  -- The corrected version starts from the verified one (retired parameters are left out; ranges are re-picked).
  insert into public.lab_result_values (clinic_id, version_id, parameter_id, parameter_code, parameter_name, value_numeric, value_text, reference_range_id)
  select p_clinic, v_new.id, x.parameter_id, '', '', x.value_numeric, x.value_text, public.lab_pick_range(x.parameter_id)
    from public.lab_result_values x
    join public.lab_test_parameters p on p.id = x.parameter_id and p.active
   where x.version_id = v_current.id;

  return jsonb_build_object('result_id', p_result, 'version_id', v_new.id, 'version', v_new.version, 'corrects_version', v_current.version);
end;
$$;

do $$
declare
  f text;
begin
  foreach f in array array[
    'lab_result_save(uuid, uuid, uuid, jsonb)',
    'lab_result_submit(uuid, uuid, uuid)',
    'lab_result_verify(uuid, uuid, uuid)',
    'lab_result_return(uuid, uuid, uuid)',
    'lab_result_correct(uuid, uuid, uuid, int, text)'
  ] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end $$;

-- Laboratory module, phase 6 amendment (2/2): orphaned drafts, abandonment, comparator values, honest result headers.
--
-- Decisions (docs/labs/DECISIONS.md D6-D8):
--
--   * A DRAFT IS NEVER STRANDED. Every version now has a holder (working_by, the author at first). When the holder is no longer
--     an ACTIVE laboratory user of the clinic (role removed, account banned or deleted) the draft is "orphaned" and another
--     laboratory user may take it over (lab_result_take_over): the original author (entered_by) and the creation time
--     (entered_at) are never touched, the new holder and the takeover time are recorded in an append-only event table, and the
--     takeover is audited. Nobody can take over a draft whose holder is still active.
--   * A DRAFT IS NEVER DELETED. Discarding is an audited abandonment (lab_result_abandon): status 'cancelled', who, when, why,
--     and whose draft it was. The holder abandons their own draft; an orphaned draft may be abandoned by laboratory staff or by
--     owner/admin/manager (who see no result values - results stay clinical and are not theirs to read or write). A cancelled
--     version keeps its values for reconstruction, can never be finalised, and frees the result for a fresh draft.
--   * COMPARATOR VALUES ("<0.5", ">200") are stored as a number plus a comparator and are never compared with the range (flag
--     unclassified). Zero, negative numbers, a configured choice such as "not detected" and free text are values; only an
--     absent parameter is missing (lab_result_submit refuses a result with a missing active parameter).
--   * The result HEADER says 'verified' whenever a verified version exists, also while a correction is being prepared (it used to
--     follow the latest version, so a result under correction looked unverified). It never follows a cancelled version.
--
-- Callable by the server only. Reversible: drop the new functions, table and columns; restore the four trigger functions from
-- 20261003000002 / 20261003000007 (the correction check is replaced below).

-- ---------------------------------------------------------------------------------------------- columns and checks
alter table public.lab_result_versions add column working_by uuid references public.profiles (id);
update public.lab_result_versions set working_by = entered_by;
alter table public.lab_result_versions alter column working_by set not null;
alter table public.lab_result_versions add column cancelled_by uuid references public.profiles (id);
alter table public.lab_result_versions add column cancelled_at timestamptz;
alter table public.lab_result_versions add column cancellation_reason text;

alter table public.lab_result_versions add constraint lab_result_versions_cancelled_fields check (
  (status = 'cancelled') = (cancelled_by is not null and cancelled_at is not null and cancellation_reason is not null)
  and (cancellation_reason is null or (cancellation_reason ~ '\S' and char_length(cancellation_reason) <= 300))
);

-- A version after an abandoned first draft is version 2 without correcting anything: "correction" is decided by the
-- existence of a verified version (the insert trigger), no longer by the version number.
alter table public.lab_result_versions drop constraint lab_result_versions_correction_fields;
alter table public.lab_result_versions add constraint lab_result_versions_correction_fields
  check ((corrects_version_id is null) = (correction_reason is null));

alter table public.lab_result_values add column comparator text;
alter table public.lab_result_values add constraint lab_result_values_comparator_check
  check (comparator is null or (comparator in ('<', '<=', '>', '>=') and value_numeric is not null));

grant select (working_by, cancelled_by, cancelled_at, cancellation_reason) on public.lab_result_versions to service_role;
grant select (comparator) on public.lab_result_values to service_role;

create table public.lab_result_version_events (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics (id) on delete restrict,
  version_id uuid not null,
  kind text not null check (kind in ('takeover', 'abandon')),
  actor_id uuid not null references public.profiles (id),
  previous_holder uuid references public.profiles (id),
  reason text check (reason is null or (reason ~ '\S' and char_length(reason) <= 300)),
  created_at timestamptz not null default now(),
  constraint lab_result_version_events_version_fkey foreign key (version_id, clinic_id) references public.lab_result_versions (id, clinic_id)
);
create index lab_result_version_events_version_idx on public.lab_result_version_events (version_id, created_at);
alter table public.lab_result_version_events enable row level security;
revoke all on public.lab_result_version_events from public, anon, authenticated, service_role;
grant select, insert on public.lab_result_version_events to service_role;
comment on table public.lab_result_version_events is
  'Append-only history of draft takeovers and abandonments (who, when, from whom, why). Server-only; ids and a short reason, no result values.';

-- Append-only for the application roles (they also have no UPDATE/DELETE grant). The table owner - migrations, maintenance, and
-- the local test cleanup - is not bound, like the other laboratory tables.
create or replace function public.lab_events_immutable() returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  if current_user in ('service_role', 'authenticated', 'anon') then
    raise exception 'lab result events are append-only';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;
create trigger lab_result_version_events_immutable before update or delete on public.lab_result_version_events
  for each row execute function public.lab_events_immutable();

-- ---------------------------------------------------------------------------------------------- who is still active
create or replace function public.lab_staff_is_active(p_profile uuid, p_clinic uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select p_profile is not null
    and exists (select 1 from public.staff_roles sr where sr.profile_id = p_profile and sr.clinic_id = p_clinic and sr.role = 'lab_staff')
    and exists (select 1 from auth.users u where u.id = p_profile and u.deleted_at is null and (u.banned_until is null or u.banned_until <= now()));
$$;
revoke all on function public.lab_staff_is_active(uuid, uuid) from public, anon, authenticated;
grant execute on function public.lab_staff_is_active(uuid, uuid) to service_role;

create or replace function public.lab_is_management(p_profile uuid, p_clinic uuid)
returns boolean
language sql
stable
set search_path = public, pg_temp
as $$
  select p_profile is not null and exists (
    select 1 from public.staff_roles sr where sr.profile_id = p_profile and sr.clinic_id = p_clinic and sr.role in ('owner', 'admin', 'manager'));
$$;
revoke all on function public.lab_is_management(uuid, uuid) from public, anon, authenticated;
grant execute on function public.lab_is_management(uuid, uuid) to service_role;

-- ---------------------------------------------------------------------------------------------- trigger functions
create or replace function public.lab_result_versions_validate()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_result public.lab_results%rowtype;
  v_corrected record;
  v_has_values boolean;
begin
  if tg_op = 'INSERT' then
    -- Serialises the numbering of one result's versions.
    select * into v_result from public.lab_results r where r.id = new.result_id and r.clinic_id = new.clinic_id for update;
    if not found then
      return new; -- the foreign key reports it
    end if;
    if not public.lab_result_work_open(new.result_id) then
      raise exception 'lab result: the order or the test is cancelled';
    end if;
    if new.status is distinct from 'draft' then
      raise exception 'lab result: a version is created as a draft';
    end if;
    if not public.lab_is_lab_staff(new.entered_by, new.clinic_id) then
      raise exception 'lab result: entered_by must be lab staff of the clinic';
    end if;
    new.version := coalesce((select max(v.version) from public.lab_result_versions v where v.result_id = new.result_id), 0) + 1;
    new.entered_at := now();
    new.created_at := now();
    new.updated_at := now();
    new.working_by := new.entered_by;
    new.verified_by := null;
    new.verified_at := null;
    new.cancelled_by := null;
    new.cancelled_at := null;
    new.cancellation_reason := null;
    if exists (select 1 from public.lab_result_versions v where v.result_id = new.result_id and v.status = 'verified') then
      -- Once a version is verified, a new version is a correction of THAT version, with a reason; nothing is overwritten.
      select v.id, v.result_id, v.status into v_corrected
        from public.lab_result_versions v where v.id = new.corrects_version_id and v.clinic_id = new.clinic_id;
      if not found or v_corrected.result_id <> new.result_id or v_corrected.status <> 'verified' then
        raise exception 'lab result: a correction must name the current verified version of the same result';
      end if;
    else
      new.corrects_version_id := null;
      new.correction_reason := null;
    end if;
    return new;
  end if;

  if new.id is distinct from old.id or new.clinic_id is distinct from old.clinic_id or new.result_id is distinct from old.result_id
     or new.version is distinct from old.version or new.entered_by is distinct from old.entered_by
     or new.entered_at is distinct from old.entered_at or new.corrects_version_id is distinct from old.corrects_version_id
     or new.correction_reason is distinct from old.correction_reason or new.created_at is distinct from old.created_at then
    raise exception 'lab result: a version cannot be edited; add a correction instead';
  end if;
  -- The holder changes only while the version is a draft (a takeover); never the author, never after.
  if new.working_by is distinct from old.working_by and not (old.status = 'draft' and new.status = 'draft') then
    raise exception 'lab result: only a draft changes hands';
  end if;
  if new.status = old.status then
    if new.verified_by is distinct from old.verified_by or new.verified_at is distinct from old.verified_at
       or new.cancelled_by is distinct from old.cancelled_by or new.cancelled_at is distinct from old.cancelled_at
       or new.cancellation_reason is distinct from old.cancellation_reason then
      raise exception 'lab result: a version cannot be edited; add a correction instead';
    end if;
    return new;
  end if;
  new.updated_at := now();
  -- A cancelled order or test cannot be worked on any further (the system's supersede step and an abandonment are exempt).
  if not (old.status = 'verified' and new.status = 'superseded')
     and not (old.status = 'draft' and new.status = 'cancelled')
     and not public.lab_result_work_open(new.result_id) then
    raise exception 'lab result: the order or the test is cancelled';
  end if;
  if old.status = 'draft' and new.status = 'pending_verification' then
    select exists (select 1 from public.lab_result_values x where x.version_id = new.id) into v_has_values;
    if not v_has_values then
      raise exception 'lab result: a version without values cannot be submitted for verification';
    end if;
    new.verified_by := null;
    new.verified_at := null;
  elsif old.status = 'pending_verification' and new.status = 'draft' then
    new.verified_by := null;
    new.verified_at := null;
  elsif old.status = 'pending_verification' and new.status = 'verified' then
    if new.verified_by is null or not public.lab_is_lab_staff(new.verified_by, new.clinic_id) then
      raise exception 'lab result: verified_by must be lab staff of the clinic';
    end if;
    new.verified_at := now();
    -- The previous verified version steps aside in the same statement (system transition).
    update public.lab_result_versions set status = 'superseded'
     where result_id = new.result_id and status = 'verified' and id <> new.id;
  elsif old.status = 'verified' and new.status = 'superseded' then
    if pg_trigger_depth() < 2 then
      raise exception 'lab result: a verified version is superseded only by a newer verified version';
    end if;
    new.verified_by := old.verified_by;
    new.verified_at := old.verified_at;
  elsif old.status = 'draft' and new.status = 'cancelled' then
    -- An abandonment: who, when and why are required (the table check) and the actor must be staff of the clinic.
    if new.cancelled_by is null or not public.lab_is_clinic_staff(new.cancelled_by, new.clinic_id) then
      raise exception 'lab result: only staff of the clinic abandon a draft';
    end if;
    new.cancelled_at := now();
  else
    raise exception 'lab result: invalid version transition % -> %', old.status, new.status;
  end if;
  return new;
end;
$$;

create or replace function public.lab_result_versions_sync()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_status public.lab_result_status;
  v_order uuid;
begin
  -- The header says verified whenever a verified version stands (also while a correction is a draft); otherwise it follows
  -- the latest version that was not abandoned.
  select case
           when exists (select 1 from public.lab_result_versions v where v.result_id = new.result_id and v.status = 'verified') then 'verified'::public.lab_result_status
           else coalesce((
             select case v.status when 'pending_verification' then 'pending_verification'::public.lab_result_status else 'draft'::public.lab_result_status end
               from public.lab_result_versions v where v.result_id = new.result_id and v.status in ('draft', 'pending_verification', 'superseded')
              order by v.version desc limit 1), 'draft'::public.lab_result_status)
         end into v_status;
  update public.lab_results set status = v_status where id = new.result_id;
  if tg_op = 'INSERT' or new.status is distinct from old.status then
    select r.order_id into v_order from public.lab_results r where r.id = new.result_id;
    -- A result being worked on puts a fresh order in progress.
    update public.lab_orders set status = 'in_progress' where id = v_order and status = 'ordered';
    if new.status = 'verified' then
      -- Completes the order once every active item has a verified result (the order trigger checks).
      if not exists (
        select 1 from public.lab_order_items i
         where i.order_id = v_order and i.status = 'active'
           and not exists (
             select 1 from public.lab_results r2 join public.lab_result_versions v2 on v2.result_id = r2.id and v2.status = 'verified'
              where r2.order_item_id = i.id
           )
      ) then
        update public.lab_orders set status = 'completed' where id = v_order and status = 'in_progress';
      end if;
    end if;
  end if;
  return null;
end;
$$;


-- the audit trigger (adds the abandonment action) and the value trigger (comparators)
CREATE OR REPLACE FUNCTION public.lab_workflow_audit()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_action text;
  v_actor uuid;
  v_patient uuid;
  v_entity text := tg_table_name;
  v_new jsonb;
begin
  if tg_table_name = 'lab_orders' then
    v_patient := new.patient_id;
    if tg_op = 'INSERT' then
      v_action := 'lab_order_created'; v_actor := new.created_by;
      v_new := jsonb_build_object('status', new.status, 'priority', new.priority);
    elsif new.status is distinct from old.status then
      v_action := 'lab_order_' || new.status::text;
      v_actor := case new.status when 'cancelled' then new.cancelled_by else null end;
      v_new := jsonb_build_object('status', new.status, 'from', old.status);
    else
      return null;
    end if;
  elsif tg_table_name = 'lab_order_items' then
    select o.patient_id, o.created_by into v_patient, v_actor from public.lab_orders o where o.id = new.order_id;
    if tg_op = 'INSERT' then
      v_action := 'lab_order_item_added'; v_new := jsonb_build_object('order_id', new.order_id, 'test_id', new.test_id);
    elsif new.status is distinct from old.status then
      v_action := 'lab_order_item_cancelled'; v_actor := null; v_new := jsonb_build_object('order_id', new.order_id, 'test_id', new.test_id);
    else
      return null;
    end if;
  elsif tg_table_name = 'lab_samples' then
    v_patient := new.patient_id;
    if tg_op = 'INSERT' then
      v_action := 'lab_sample_created'; v_actor := new.created_by;
      v_new := jsonb_build_object('order_id', new.order_id, 'status', new.status);
    elsif new.status is distinct from old.status then
      v_action := 'lab_sample_' || new.status::text;
      v_actor := case new.status when 'collected' then new.collected_by else null end;
      v_new := jsonb_build_object('order_id', new.order_id, 'status', new.status, 'from', old.status);
    else
      return null;
    end if;
  elsif tg_table_name = 'lab_result_versions' then
    select r.patient_id into v_patient from public.lab_results r where r.id = new.result_id;
    v_new := jsonb_build_object('result_id', new.result_id, 'version', new.version, 'status', new.status);
    if tg_op = 'INSERT' then
      v_action := case when new.version = 1 then 'lab_result_entered' else 'lab_result_version_created' end;
      v_actor := new.entered_by;
    elsif new.status is distinct from old.status then
      v_action := case new.status
        when 'pending_verification' then 'lab_result_submitted'
        when 'verified' then 'lab_result_verified'
        when 'superseded' then 'lab_result_version_superseded'
        when 'cancelled' then 'lab_result_draft_cancelled'
        else 'lab_result_returned_to_draft' end;
      v_actor := case new.status when 'verified' then new.verified_by when 'pending_verification' then new.entered_by when 'cancelled' then new.cancelled_by else null end;
      v_new := v_new || jsonb_build_object('from', old.status);
    else
      return null;
    end if;
  elsif tg_table_name = 'lab_result_attachments' then
    select r.patient_id into v_patient from public.lab_results r where r.id = new.result_id;
    v_action := 'lab_attachment_added'; v_actor := new.uploaded_by;
    v_new := jsonb_build_object('result_id', new.result_id, 'content_type', new.content_type);
  else
    return null;
  end if;

  -- Ids and statuses only: never a value, a unit, a note, a reason or a file name.
  insert into public.audit_events (clinic_id, actor_id, actor_type, action, entity_type, entity_id, patient_id, new_values)
  values (
    new.clinic_id, v_actor,
    case when v_actor is null then 'system'::public.actor_type else 'staff'::public.actor_type end,
    v_action, v_entity, new.id::text, v_patient, v_new
  );
  return null;
end;
$function$;

CREATE OR REPLACE FUNCTION public.lab_result_values_validate()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_version_status public.lab_version_status;
  v_version_id uuid;
  v_param public.lab_test_parameters%rowtype;
  v_range public.lab_reference_ranges%rowtype;
  v_test_id uuid;
begin
  v_version_id := case tg_op when 'DELETE' then old.version_id else new.version_id end;
  select v.status into v_version_status from public.lab_result_versions v where v.id = v_version_id;
  -- Values of a submitted, verified or superseded version never change. Only the application roles are
  -- bound here by trigger (the table owner — migrations, maintenance — is not); they also have no grants.
  if tg_op = 'DELETE' then
    if v_version_status is distinct from 'draft' and current_user in ('service_role', 'authenticated', 'anon') then
      raise exception 'lab result: values of a version that is not a draft cannot be removed';
    end if;
    return old;
  end if;
  if found and v_version_status <> 'draft' then
    raise exception 'lab result: values of a version that is not a draft cannot be changed (add a correction)';
  end if;
  if tg_op = 'UPDATE' and (new.version_id is distinct from old.version_id or new.parameter_id is distinct from old.parameter_id
                           or new.clinic_id is distinct from old.clinic_id) then
    raise exception 'lab result: a value cannot move to another version or parameter';
  end if;

  if not public.lab_result_work_open((select v.result_id from public.lab_result_versions v where v.id = new.version_id)) then
    raise exception 'lab result: the order or the test is cancelled';
  end if;
  select * into v_param from public.lab_test_parameters p where p.id = new.parameter_id and p.clinic_id = new.clinic_id;
  if not found then
    return new; -- the foreign key reports it
  end if;
  -- The parameter must belong to the test this result is for, and be active.
  select i.test_id into v_test_id
    from public.lab_result_versions v
    join public.lab_results r on r.id = v.result_id
    join public.lab_order_items i on i.id = r.order_item_id
   where v.id = new.version_id;
  if v_test_id is distinct from v_param.test_id then
    raise exception 'lab result: the parameter does not belong to the ordered test';
  end if;
  if not v_param.active then
    raise exception 'lab result: the parameter is inactive';
  end if;

  new.parameter_code := v_param.code;
  new.parameter_name := v_param.name;
  new.unit := v_param.unit;
  if new.comparator is not null and v_param.data_type <> 'numeric' then
    raise exception 'lab result: a comparator applies to numeric values only';
  end if;
  if v_param.data_type = 'numeric' then
    if new.value_numeric is null or new.value_text is not null then
      raise exception 'lab result: % needs a numeric value', v_param.code;
    end if;
  elsif v_param.data_type = 'choice' then
    if new.value_text is null or new.value_numeric is not null or not (new.value_text = any (v_param.choices)) then
      raise exception 'lab result: % must be one of its configured choices', v_param.code;
    end if;
  else
    if new.value_text is null or new.value_numeric is not null then
      raise exception 'lab result: % needs a text value', v_param.code;
    end if;
  end if;

  -- The bounds come from the configured range, copied here (the client cannot supply them): later edits of
  -- the range never re-flag a stored result.
  new.ref_low := null; new.ref_high := null; new.critical_low := null; new.critical_high := null;
  if new.reference_range_id is not null then
    select * into v_range from public.lab_reference_ranges rr
     where rr.id = new.reference_range_id and rr.clinic_id = new.clinic_id and rr.parameter_id = new.parameter_id;
    if not found then
      raise exception 'lab result: the reference range does not belong to the parameter';
    end if;
    if not v_range.active then
      raise exception 'lab result: the reference range is inactive';
    end if;
    new.ref_low := v_range.low; new.ref_high := v_range.high;
    new.critical_low := v_range.critical_low; new.critical_high := v_range.critical_high;
  end if;
  -- A value with a comparator ("<0.5", ">200") is a bound, not a measurement: it is never compared with the range, so it
  -- is never called normal or abnormal by the system.
  if new.comparator is not null then
    new.flag := 'unclassified'::public.lab_flag;
  else
    new.flag := public.lab_flag_for(new.value_numeric, new.ref_low, new.ref_high, new.critical_low, new.critical_high);
  end if;
  return new;
end;
$function$;

-- ---------------------------------------------------------------------------------------------- workflow functions
-- save / submit now bind the draft to its HOLDER (working_by), and a value may carry a comparator.
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
  if not public.lab_staff_is_active(p_actor, p_clinic) then
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
  -- run the insert trigger, which refuses a new result for a completed order - and the draft of a CORRECTION of a
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
    if exists (select 1 from public.lab_result_versions v where v.result_id = v_result and v.status in ('verified', 'superseded')) then
      raise exception 'lab result: it is already verified; start a correction to change it';
    end if;
    -- Nothing open and nothing verified: a first draft, or a fresh one after an abandoned draft.
    insert into public.lab_result_versions (clinic_id, result_id, entered_by) values (p_clinic, v_result, p_actor)
    returning * into v_version;
  elsif v_version.status = 'pending_verification' then
    raise exception 'lab result: it is awaiting verification; return it to draft to change it';
  elsif v_version.working_by is distinct from p_actor then
    raise exception 'lab result: this draft belongs to another member of staff';
  end if;

  delete from public.lab_result_values where version_id = v_version.id;
  for v_val in select * from jsonb_array_elements(p_values) loop
    insert into public.lab_result_values (clinic_id, version_id, parameter_id, parameter_code, parameter_name, value_numeric, comparator, value_text, reference_range_id)
    values (
      p_clinic, v_version.id, (v_val ->> 'parameter_id')::uuid, '', '',
      (v_val ->> 'value_numeric')::numeric, nullif(v_val ->> 'comparator', ''), nullif(btrim(v_val ->> 'value_text'), ''),
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
  if not public.lab_staff_is_active(p_actor, p_clinic) then
    raise exception 'lab result: only lab staff of the clinic submit results';
  end if;
  select * into v from public.lab_result_versions x where x.id = p_version and x.clinic_id = p_clinic for update;
  if not found then
    raise exception 'lab result: not found';
  end if;
  if v.status in ('pending_verification', 'verified') then
    if v.working_by is distinct from p_actor then
      raise exception 'lab result: only the author submits a draft';
    end if;
    return jsonb_build_object('version_id', p_version, 'status', v.status, 'unchanged', true);
  end if;
  if v.status <> 'draft' then
    raise exception 'lab result: invalid version transition % -> pending_verification', v.status;
  end if;
  if v.working_by is distinct from p_actor then
    raise exception 'lab result: only the author submits a draft';
  end if;

  -- Every ACTIVE parameter of the test needs a value. A value is present when its row exists: zero, a negative number, a
  -- comparator, a configured choice ("not detected") and free text all count; only an absent parameter is missing.
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
  if not public.lab_staff_is_active(p_actor, p_clinic) then
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
  insert into public.lab_result_values (clinic_id, version_id, parameter_id, parameter_code, parameter_name, value_numeric, comparator, value_text, reference_range_id)
  select p_clinic, v_new.id, x.parameter_id, '', '', x.value_numeric, x.comparator, x.value_text, public.lab_pick_range(x.parameter_id)
    from public.lab_result_values x
    join public.lab_test_parameters p on p.id = x.parameter_id and p.active
   where x.version_id = v_current.id;

  return jsonb_build_object('result_id', p_result, 'version_id', v_new.id, 'version', v_new.version, 'corrects_version', v_current.version);
end;
$$;

-- An orphaned draft changes hands. The author and the creation time stay; the new holder and the time are recorded.
create or replace function public.lab_result_take_over(p_clinic uuid, p_actor uuid, p_version uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v record;
  v_patient uuid;
begin
  if not public.lab_staff_is_active(p_actor, p_clinic) then
    raise exception 'lab result: only lab staff of the clinic take over a draft';
  end if;
  select * into v from public.lab_result_versions x where x.id = p_version and x.clinic_id = p_clinic for update;
  if not found then
    raise exception 'lab result: not found';
  end if;
  if v.status <> 'draft' then
    raise exception 'lab result: only a draft is taken over (it is %)', v.status;
  end if;
  if v.working_by = p_actor then
    return jsonb_build_object('version_id', p_version, 'holder', p_actor, 'unchanged', true);
  end if;
  if public.lab_staff_is_active(v.working_by, p_clinic) then
    raise exception 'lab result: the draft is not orphaned - its holder is still active';
  end if;

  update public.lab_result_versions set working_by = p_actor where id = p_version;
  insert into public.lab_result_version_events (clinic_id, version_id, kind, actor_id, previous_holder)
  values (p_clinic, p_version, 'takeover', p_actor, v.working_by);
  select r.patient_id into v_patient from public.lab_results r where r.id = v.result_id;
  insert into public.audit_events (clinic_id, actor_id, actor_type, action, entity_type, entity_id, patient_id, new_values)
  values (p_clinic, p_actor, 'staff', 'lab_result_draft_taken_over', 'lab_result_versions', p_version::text, v_patient,
          jsonb_build_object('result_id', v.result_id, 'version', v.version, 'from', v.working_by, 'to', p_actor, 'author', v.entered_by));
  return jsonb_build_object('version_id', p_version, 'holder', p_actor, 'unchanged', false);
end;
$$;

-- A draft is abandoned, never deleted: who, when, why - and whose draft it was.
create or replace function public.lab_result_abandon(p_clinic uuid, p_actor uuid, p_version uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v record;
  v_holder_active boolean;
begin
  if p_reason is null or char_length(btrim(p_reason)) < 3 then
    raise exception 'lab result: an abandonment needs a reason';
  end if;
  select * into v from public.lab_result_versions x where x.id = p_version and x.clinic_id = p_clinic for update;
  if not found then
    raise exception 'lab result: not found';
  end if;
  if v.status = 'cancelled' then
    return jsonb_build_object('version_id', p_version, 'status', 'cancelled', 'unchanged', true);
  end if;
  if v.status <> 'draft' then
    raise exception 'lab result: only a draft is abandoned (it is %)', v.status;
  end if;
  v_holder_active := public.lab_staff_is_active(v.working_by, p_clinic);
  if not (
    (v_holder_active and v.working_by = p_actor)
    or (not v_holder_active and (public.lab_staff_is_active(p_actor, p_clinic) or public.lab_is_management(p_actor, p_clinic)))
  ) then
    raise exception 'lab result: only the holder abandons an active draft';
  end if;

  update public.lab_result_versions
     set status = 'cancelled', cancelled_by = p_actor, cancellation_reason = btrim(p_reason)
   where id = p_version;
  insert into public.lab_result_version_events (clinic_id, version_id, kind, actor_id, previous_holder, reason)
  values (p_clinic, p_version, 'abandon', p_actor, v.working_by, btrim(p_reason));
  return jsonb_build_object('version_id', p_version, 'status', 'cancelled', 'unchanged', false);
end;
$$;

-- Drafts whose holder is no longer an active laboratory user: what management and the bench need to unblock work. No patient,
-- no value.
create or replace function public.lab_orphaned_drafts(p_clinic uuid)
returns table (version_id uuid, item_id uuid, test_code text, test_name text, version int, holder uuid, holder_name text, author uuid, entered_at timestamptz)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select v.id, i.id, i.test_code, i.test_name, v.version, v.working_by, p.full_name, v.entered_by, v.entered_at
    from public.lab_result_versions v
    join public.lab_results r on r.id = v.result_id
    join public.lab_order_items i on i.id = r.order_item_id
    left join public.profiles p on p.id = v.working_by
   where v.clinic_id = p_clinic and v.status = 'draft' and not public.lab_staff_is_active(v.working_by, p_clinic)
   order by v.entered_at;
$$;

do $$
declare
  f text;
begin
  foreach f in array array[
    'lab_result_save(uuid, uuid, uuid, jsonb)',
    'lab_result_submit(uuid, uuid, uuid)',
    'lab_result_correct(uuid, uuid, uuid, int, text)',
    'lab_result_take_over(uuid, uuid, uuid)',
    'lab_result_abandon(uuid, uuid, uuid, text)',
    'lab_orphaned_drafts(uuid)'
  ] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end $$;

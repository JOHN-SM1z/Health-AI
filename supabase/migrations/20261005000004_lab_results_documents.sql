-- Laboratory (Phase 2, 4 of 4): results, versions, verification, documents.
--
-- docs/labs/PHASE_1_DOMAIN_MODEL.md §3.4–3.5, §4–§7, owner decisions
-- 2026-10-05.
--
--   lab_results        one VERSION of the result of one order item.
--                      draft → submitted → verified → superseded
--                      A verified result is never changed. A correction is a
--                      new version (supersedes_result_id + reason); when the
--                      correction is verified, the previous version becomes
--                      superseded in the same statement. One verified version
--                      and at most one version in progress per item.
--   lab_result_values  one parameter value of a version. Only drafts accept
--                      values. The unit, the reference range used and the flag
--                      are set by the database from the clinic's configuration
--                      and the patient's sex and age — never by the caller —
--                      and frozen with the value. The flag only places the
--                      value against the configured range; nothing here
--                      interprets it clinically.
--   lab_documents      report / scan / image metadata; the bytes live in the
--                      private bucket lab-documents at <clinic_id>/<id>.
--                      Documents are withdrawn, never deleted.
--
-- O4: every result needs a second person. Whoever entered or submitted a
-- version can never verify it (CHECK constraint + trigger). Doctors may verify.
--
-- Access: result data is server-only (AGENTS.md). No signed-in role has any
-- privilege on these tables and RLS is enabled without policies, so even a
-- stray grant exposes nothing. The server authorizes and audits every read.

create type public.lab_result_status as enum ('draft', 'submitted', 'verified', 'superseded');
create type public.lab_result_source as enum ('manual', 'import', 'external');
create type public.lab_value_flag as enum (
  'normal',
  'low',
  'high',
  'critical_low',
  'critical_high',
  'abnormal',
  'not_evaluated'
);
create type public.lab_document_kind as enum ('report', 'scan', 'image', 'import_source');

comment on type public.lab_value_flag is
  'Position of a value against the CONFIGURED reference range (low/high/critical bounds or expected text). not_evaluated when no configured range applies. Not a clinical interpretation.';

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table public.lab_results (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete cascade,
  patient_id uuid not null,
  order_item_id uuid not null,
  version integer not null default 1,
  supersedes_result_id uuid,
  status public.lab_result_status not null default 'draft',
  source public.lab_result_source not null default 'manual',
  entered_by uuid not null references public.profiles(id),
  entered_at timestamptz not null default now(),
  submitted_by uuid references public.profiles(id),
  submitted_at timestamptz,
  verified_by uuid references public.profiles(id),
  verified_at timestamptz,
  -- Why a verified result is being corrected (version > 1).
  correction_reason text,
  -- Laboratory-technical remark (lab data, not a doctor's note).
  lab_comment text,
  -- When the test was performed; for imports, the historical date.
  performed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint lab_results_id_clinic_id_key unique (id, clinic_id),
  constraint lab_results_item_version_key unique (order_item_id, version),
  constraint lab_results_item_fkey
    foreign key (order_item_id, clinic_id, patient_id) references public.lab_order_items (id, clinic_id, patient_id),
  constraint lab_results_supersedes_fkey
    foreign key (supersedes_result_id, clinic_id) references public.lab_results (id, clinic_id),
  constraint lab_results_version_check
    check (version >= 1 and (version = 1) = (supersedes_result_id is null)),
  constraint lab_results_correction_reason_check
    check ((version > 1) = (correction_reason is not null)
           and (correction_reason is null or (correction_reason ~ '\S' and char_length(correction_reason) <= 300))),
  constraint lab_results_comment_check
    check (lab_comment is null or (lab_comment ~ '\S' and char_length(lab_comment) <= 1000)),
  constraint lab_results_submitted_check
    check ((submitted_by is null) = (submitted_at is null)
           and (status = 'draft' or submitted_by is not null)),
  constraint lab_results_verified_check
    check ((verified_by is null) = (verified_at is null)
           and (status in ('verified', 'superseded')) = (verified_by is not null)),
  -- O4: a second person verifies.
  constraint lab_results_second_person_check
    check (verified_by is null or (verified_by <> entered_by and verified_by <> submitted_by))
);

create table public.lab_result_values (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete cascade,
  result_id uuid not null,
  parameter_id uuid not null,
  value_numeric numeric,
  value_text text,
  value_boolean boolean,
  -- Frozen from configuration when the value was recorded.
  unit_snapshot text,
  reference_range_id uuid,
  range_low numeric,
  range_high numeric,
  range_text text,
  critical_low numeric,
  critical_high numeric,
  flag public.lab_value_flag not null default 'not_evaluated',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint lab_result_values_id_clinic_id_key unique (id, clinic_id),
  constraint lab_result_values_result_parameter_key unique (result_id, parameter_id),
  constraint lab_result_values_result_fkey
    foreign key (result_id, clinic_id) references public.lab_results (id, clinic_id) on delete cascade,
  constraint lab_result_values_parameter_fkey
    foreign key (parameter_id, clinic_id) references public.lab_test_parameters (id, clinic_id),
  constraint lab_result_values_range_fkey
    foreign key (reference_range_id, clinic_id) references public.lab_reference_ranges (id, clinic_id),
  constraint lab_result_values_one_value_check
    check (num_nonnulls(value_numeric, value_text, value_boolean) = 1),
  constraint lab_result_values_text_check
    check (value_text is null or (value_text ~ '\S' and char_length(value_text) <= 500))
);

create table public.lab_documents (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete cascade,
  patient_id uuid not null,
  order_id uuid not null,
  result_id uuid,
  kind public.lab_document_kind not null,
  storage_path text not null,
  mime_type text not null,
  size_bytes bigint not null,
  sha256 text not null,
  uploaded_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now(),
  withdrawn_at timestamptz,
  withdrawn_by uuid references public.profiles(id),
  withdraw_reason text,

  constraint lab_documents_id_clinic_id_key unique (id, clinic_id),
  constraint lab_documents_storage_path_key unique (storage_path),
  constraint lab_documents_order_fkey
    foreign key (order_id, clinic_id, patient_id) references public.lab_orders (id, clinic_id, patient_id),
  constraint lab_documents_result_fkey
    foreign key (result_id, clinic_id) references public.lab_results (id, clinic_id),
  constraint lab_documents_path_check
    check (storage_path = clinic_id::text || '/' || id::text),
  constraint lab_documents_mime_check
    check (mime_type in ('application/pdf', 'image/jpeg', 'image/png', 'image/webp')),
  constraint lab_documents_size_check
    check (size_bytes > 0 and size_bytes <= 20971520),
  constraint lab_documents_sha256_check
    check (sha256 ~ '^[0-9a-f]{64}$'),
  constraint lab_documents_withdrawn_check
    check ((withdrawn_at is null) = (withdrawn_by is null)
           and (withdrawn_at is null) = (withdraw_reason is null)
           and (withdraw_reason is null or (withdraw_reason ~ '\S' and char_length(withdraw_reason) <= 300)))
);

comment on table public.lab_results is 'Versioned result of one lab order item. Verified versions are immutable; corrections are new versions. Second-person verification. Server-only.';
comment on table public.lab_result_values is 'Parameter values of a lab result version with the unit, reference range and flag frozen by the database. Server-only.';
comment on table public.lab_documents is 'Lab report / scan / image metadata; bytes in private bucket lab-documents. Withdrawn, never deleted. Server-only.';

create unique index lab_results_one_verified_key on public.lab_results (order_item_id) where status = 'verified';
create unique index lab_results_one_in_progress_key on public.lab_results (order_item_id) where status in ('draft', 'submitted');
create unique index lab_results_one_correction_key on public.lab_results (supersedes_result_id) where supersedes_result_id is not null;
create index lab_results_patient_idx on public.lab_results (clinic_id, patient_id, created_at desc);
create index lab_results_queue_idx on public.lab_results (clinic_id, status, updated_at) where status in ('draft', 'submitted');
create index lab_result_values_parameter_idx on public.lab_result_values (parameter_id);
create index lab_documents_order_idx on public.lab_documents (clinic_id, order_id);
create index lab_documents_result_idx on public.lab_documents (result_id) where result_id is not null;

-- ---------------------------------------------------------------------------
-- lab_results: versions, second-person verification, immutability
-- ---------------------------------------------------------------------------

create or replace function public.lab_results_validate()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_item public.lab_order_items;
  v_source public.lab_order_source;
  v_target public.lab_results;
begin
  if tg_op = 'DELETE' then
    if old.status = 'draft' or public.lab_clinic_is_being_erased(old.clinic_id) then
      return old;
    end if;
    raise exception 'lab result: only a draft can be discarded';
  end if;

  if tg_op = 'INSERT' then
    new.created_at := now();
    new.updated_at := now();
    new.entered_at := now();
    if new.status <> 'draft' or new.submitted_by is not null or new.verified_by is not null then
      raise exception 'lab result: a new result starts as a draft';
    end if;
    if not public.lab_is_clinic_member(new.clinic_id, new.entered_by) then
      raise exception 'lab result: entered_by must be a staff member of the clinic';
    end if;
    if new.performed_at is not null and new.performed_at > now() + interval '5 minutes' then
      raise exception 'lab result: performed_at cannot be in the future';
    end if;

    -- One writer per item at a time.
    select * into v_item from public.lab_order_items i
    where i.id = new.order_item_id and i.clinic_id = new.clinic_id
    for update;
    if not found then
      raise exception 'lab result: unknown order item';
    end if;
    select o.source into v_source from public.lab_orders o where o.id = v_item.order_id;

    if new.supersedes_result_id is null then
      if exists (select 1 from public.lab_results r where r.order_item_id = new.order_item_id) then
        raise exception 'lab result: the item already has a result; a change to a verified result is a correction';
      end if;
      if new.source = 'manual' and v_source = 'external_import' then
        raise exception 'lab result: results of an imported order are recorded with source import or external';
      end if;
      if v_source = 'external_import' then
        if v_item.status not in ('ordered', 'processing') then
          raise exception 'lab result: the imported item is %', v_item.status;
        end if;
      elsif v_item.status not in ('collected', 'processing') then
        raise exception 'lab result: results are entered after the sample is collected (the item is %)', v_item.status;
      end if;
    else
      select * into v_target from public.lab_results r
      where r.id = new.supersedes_result_id and r.clinic_id = new.clinic_id;
      if v_target.order_item_id is distinct from new.order_item_id or v_target.status <> 'verified' then
        raise exception 'lab result: a correction supersedes the current verified result of the same item';
      end if;
      if new.version <> v_target.version + 1 then
        raise exception 'lab result: a correction of version % is version %', v_target.version, v_target.version + 1;
      end if;
    end if;
    return new;
  end if;

  -- UPDATE
  perform public.lab_assert_only_changed(
    to_jsonb(old), to_jsonb(new),
    array['status', 'submitted_by', 'submitted_at', 'verified_by', 'verified_at', 'lab_comment', 'performed_at', 'updated_at'],
    'lab result');
  new.updated_at := now();

  if old.status = new.status then
    if old.status <> 'draft' then
      raise exception 'lab result: a % result cannot be edited', old.status;
    end if;
    if new.submitted_by is distinct from old.submitted_by or new.verified_by is distinct from old.verified_by
       or new.submitted_at is distinct from old.submitted_at or new.verified_at is distinct from old.verified_at then
      raise exception 'lab result: submission and verification details change only with the status';
    end if;
    if new.performed_at is not null and new.performed_at > now() + interval '5 minutes' then
      raise exception 'lab result: performed_at cannot be in the future';
    end if;
    return new;
  end if;

  if (old.status, new.status) = ('draft', 'submitted') then
    if new.submitted_by is null or not public.lab_is_clinic_member(new.clinic_id, new.submitted_by) then
      raise exception 'lab result: submitted_by must be a staff member of the clinic';
    end if;
    if not exists (select 1 from public.lab_result_values v where v.result_id = new.id) then
      raise exception 'lab result: a result without values cannot be submitted';
    end if;
    new.submitted_at := now();
    if new.lab_comment is distinct from old.lab_comment or new.performed_at is distinct from old.performed_at then
      raise exception 'lab result: save the draft before submitting it';
    end if;
  elsif (old.status, new.status) = ('submitted', 'draft') then
    -- Returned for correction by the reviewer.
    new.submitted_by := null;
    new.submitted_at := null;
  elsif (old.status, new.status) = ('submitted', 'verified') then
    if new.verified_by is null or not public.lab_is_clinic_member(new.clinic_id, new.verified_by) then
      raise exception 'lab result: verified_by must be a staff member of the clinic';
    end if;
    if new.verified_by = new.entered_by or new.verified_by = new.submitted_by then
      raise exception 'lab result: a second person must verify the result';
    end if;
    new.verified_at := now();
    -- A verified correction retires the version it corrects, first, so the
    -- one-verified-version index holds.
    if new.supersedes_result_id is not null then
      perform set_config('app.lab_superseding_result', new.supersedes_result_id::text, true);
      update public.lab_results set status = 'superseded' where id = new.supersedes_result_id;
      perform set_config('app.lab_superseding_result', '', true);
    end if;
  elsif (old.status, new.status) = ('verified', 'superseded') then
    if coalesce(current_setting('app.lab_superseding_result', true), '') <> old.id::text then
      raise exception 'lab result: a verified result is superseded only by verifying its correction';
    end if;
  else
    raise exception 'lab result: % → % is not allowed', old.status, new.status;
  end if;

  if new.status <> 'draft' and (new.lab_comment is distinct from old.lab_comment or new.performed_at is distinct from old.performed_at) then
    raise exception 'lab result: only a draft can be edited';
  end if;
  return new;
end;
$$;

revoke all on function public.lab_results_validate() from public, anon, authenticated;

create trigger lab_results_validate
  before insert or update or delete on public.lab_results
  for each row execute function public.lab_results_validate();

-- The order item follows its first result version: collected → processing on
-- entry, → resulted on submission, back to processing when returned, →
-- verified on verification. Corrections leave a verified item verified.
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
    v_actor := auth.uid();
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

revoke all on function public.lab_results_sync_item() from public, anon, authenticated;

create trigger lab_results_sync_item
  after insert or update of status on public.lab_results
  for each row execute function public.lab_results_sync_item();

-- An item is resulted / verified only when its result says so.
create or replace function public.lab_order_items_result_consistency()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.status = 'resulted' and not exists (
    select 1 from public.lab_results r
    where r.order_item_id = new.id and r.status = 'submitted' and r.supersedes_result_id is null
  ) then
    raise exception 'lab order item: resulted requires a submitted result';
  end if;
  if new.status = 'verified' and not exists (
    select 1 from public.lab_results r where r.order_item_id = new.id and r.status = 'verified'
  ) then
    raise exception 'lab order item: verified requires a verified result';
  end if;
  return new;
end;
$$;

revoke all on function public.lab_order_items_result_consistency() from public, anon, authenticated;

create trigger lab_order_items_result_consistency
  before update of status on public.lab_order_items
  for each row when (new.status is distinct from old.status and new.status in ('resulted', 'verified'))
  execute function public.lab_order_items_result_consistency();

-- ---------------------------------------------------------------------------
-- lab_result_values: drafts only; unit, range and flag from configuration
-- ---------------------------------------------------------------------------

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

  -- The most specific active range for this patient: a sex-specific range
  -- before an any-sex one, an age band before an open one, the narrowest
  -- band first. Unknown sex only matches any-sex ranges; unknown age only
  -- matches ranges without an age band.
  select * into v_range
  from public.lab_reference_ranges r
  where r.parameter_id = new.parameter_id
    and r.active
    and (r.sex is null or r.sex = v_sex)
    and (
      (r.age_min_days is null and r.age_max_days is null)
      or (v_age is not null
          and v_age >= coalesce(r.age_min_days, 0)
          and v_age <= coalesce(r.age_max_days, 2147483647))
    )
  order by (r.sex is not null) desc,
           num_nonnulls(r.age_min_days, r.age_max_days) desc,
           coalesce(r.age_max_days, 2147483647)::bigint - coalesce(r.age_min_days, 0) asc
  limit 1;

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

revoke all on function public.lab_result_values_validate() from public, anon, authenticated;

create trigger lab_result_values_validate
  before insert or update or delete on public.lab_result_values
  for each row execute function public.lab_result_values_validate();

-- ---------------------------------------------------------------------------
-- lab_documents: provenance; withdrawn, never deleted
-- ---------------------------------------------------------------------------

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

revoke all on function public.lab_documents_validate() from public, anon, authenticated;

create trigger lab_documents_validate
  before insert or update or delete on public.lab_documents
  for each row execute function public.lab_documents_validate();

-- ---------------------------------------------------------------------------
-- Audit: ids and states only — never values, comments or file names
-- ---------------------------------------------------------------------------

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
    v_actor := auth.uid();
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
      v_actor := auth.uid();
    elsif new.status = 'verified' then
      v_action := case when new.supersedes_result_id is null then 'lab_result_verified' else 'lab_result_corrected' end;
      v_actor := new.verified_by;
    else
      v_action := 'lab_result_superseded';
      v_actor := auth.uid();
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

revoke all on function public.lab_results_audit() from public, anon, authenticated;

create trigger lab_results_audit
  after insert or update or delete on public.lab_results
  for each row execute function public.lab_results_audit();

create or replace function public.lab_documents_audit()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.audit_events (clinic_id, actor_id, actor_type, action, entity_type, entity_id, patient_id, new_values)
  values (
    new.clinic_id,
    case when tg_op = 'INSERT' then new.uploaded_by else new.withdrawn_by end,
    'staff'::public.actor_type,
    case when tg_op = 'INSERT' then 'lab_document_uploaded' else 'lab_document_withdrawn' end,
    'lab_documents',
    new.id::text,
    new.patient_id,
    jsonb_build_object('order_id', new.order_id, 'result_id', new.result_id, 'kind', new.kind)
  );
  return null;
end;
$$;

revoke all on function public.lab_documents_audit() from public, anon, authenticated;

create trigger lab_documents_audit
  after insert or update on public.lab_documents
  for each row execute function public.lab_documents_audit();

-- ---------------------------------------------------------------------------
-- Access: server only
-- ---------------------------------------------------------------------------

alter table public.lab_results enable row level security;
alter table public.lab_result_values enable row level security;
alter table public.lab_documents enable row level security;

-- No policies: RLS denies every signed-in role even if a privilege is
-- granted by mistake. Reads go through the server, which authorizes by role
-- and purpose and audits each read.

revoke all on table public.lab_results from public, anon, authenticated, service_role;
revoke all on table public.lab_result_values from public, anon, authenticated, service_role;
revoke all on table public.lab_documents from public, anon, authenticated, service_role;
grant select, insert, update, delete on table public.lab_results to service_role;
grant select, insert, update, delete on table public.lab_result_values to service_role;
grant select, insert, update on table public.lab_documents to service_role;

-- ---------------------------------------------------------------------------
-- Storage: private bucket, server only
-- ---------------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('lab-documents', 'lab-documents', false, 20971520,
        array['application/pdf', 'image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do nothing;

drop policy if exists "lab-documents service role access" on storage.objects;
create policy "lab-documents service role access"
  on storage.objects
  for all
  to service_role
  using (bucket_id = 'lab-documents')
  with check (bucket_id = 'lab-documents');

-- No policy for anon or authenticated: lab files are delivered only through
-- short-lived signed URLs the server issues after authorization (Phase 11).

-- Laboratory (Phase 13): historical lab-result import engine.
--
-- A migration tool, not a patient workflow. External data (a CSV exported
-- from MedPlus, Excel or another laboratory system — no provider API is
-- assumed) goes through:
--
--   upload → schema detection → field mapping → validation → patient
--   matching → duplicate detection → preview (+ dry run) → confirmation by a
--   SECOND staff member → import (partial, retryable) → import report
--
--   lab_import_batches  one uploaded file: who prepared it, the mapping, the
--                       state, who confirmed it. The same file (sha256) can
--                       be in only one non-cancelled batch per clinic.
--   lab_import_rows     one data row of the file: its cells, the server's
--                       reading of them (patient, test, parameter, typed
--                       value, date), its status and error codes, and the
--                       result it became.
--
-- Both tables are server-only (service_role), like the result tables: the
-- cells hold patient identifiers and result values. Audit rows carry ids,
-- counts and codes only.
--
-- run_lab_import() imports "groups" — one patient, one test, one date (and
-- source accession): one result. Each group is its own subtransaction, so a
-- failure affects that group only (partial import); failed groups can be
-- retried. Each imported group becomes an external_import order (reference
-- import:<group key>, unique per clinic — the same data is never imported
-- twice), one item, and one result version with source = import:
-- entered and submitted by the preparer, verified by the confirming second
-- person (O4 holds: the CHECK constraint on lab_results still applies). A
-- group is never imported over an existing result of the same patient,
-- test and day: nothing existing is replaced or merged.
--
-- Dry run: the same function with p_dry_run = true performs every insert
-- up to submission and then rolls the group back, reporting whether it
-- would import.
--
-- Imported (historical) results never notify the patient: the
-- lab_result_ready trigger now skips source = import.

create type public.lab_import_status as enum ('uploaded', 'analysed', 'confirmed', 'completed', 'cancelled');

create type public.lab_import_row_status as enum (
  'pending',         -- uploaded, not analysed yet
  'ready',           -- valid, exact (or staff-confirmed) patient match, no duplicate
  'invalid',         -- validation errors (see errors)
  'unmatched',       -- no patient found
  'possible_match',  -- weak identifiers match one patient: a staff member must confirm
  'conflict',        -- identifiers contradict each other or point to several patients,
                     -- or an existing result differs
  'duplicate',       -- repeated in the file, or already in the clinic's records
  'imported',
  'failed',          -- the import of its group failed (retryable)
  'skipped'          -- left out when the batch was finished or cancelled
);

create table public.lab_import_batches (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete cascade,
  -- Free label of the origin system, e.g. "MedPlus", "Excel".
  source_system text not null,
  file_name text not null,
  file_sha256 text not null,
  status public.lab_import_status not null default 'uploaded',
  headers jsonb not null,
  mapping jsonb,
  row_count integer not null,
  summary jsonb not null default '{}'::jsonb,
  created_by uuid not null references public.profiles(id),
  analysed_by uuid references public.profiles(id),
  analysed_at timestamptz,
  confirmed_by uuid references public.profiles(id),
  confirmed_at timestamptz,
  completed_at timestamptz,
  cancelled_by uuid references public.profiles(id),
  cancelled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint lab_import_batches_id_clinic_id_key unique (id, clinic_id),
  constraint lab_import_batches_source_check
    check (source_system ~ '\S' and char_length(source_system) <= 80),
  constraint lab_import_batches_file_name_check
    check (file_name ~ '\S' and char_length(file_name) <= 200),
  constraint lab_import_batches_sha_check check (file_sha256 ~ '^[0-9a-f]{64}$'),
  constraint lab_import_batches_headers_check
    check (jsonb_typeof(headers) = 'array' and jsonb_array_length(headers) between 1 and 50),
  constraint lab_import_batches_rows_check check (row_count between 1 and 5000),
  constraint lab_import_batches_analysed_check
    check ((analysed_at is null) = (analysed_by is null)
           and (status in ('uploaded', 'cancelled') or analysed_at is not null)),
  -- A second person confirms (O4, as for results).
  constraint lab_import_batches_confirm_check
    check ((confirmed_at is null) = (confirmed_by is null)
           and (confirmed_by is null or confirmed_by <> created_by)
           and (status not in ('confirmed', 'completed') or confirmed_by is not null)),
  constraint lab_import_batches_cancel_check
    check ((status = 'cancelled') = (cancelled_at is not null)
           and (cancelled_at is null) = (cancelled_by is null)),
  constraint lab_import_batches_completed_check
    check ((status = 'completed') = (completed_at is not null))
);

-- One live batch per file: an imported or in-progress file cannot be uploaded again.
create unique index lab_import_batches_file_key
  on public.lab_import_batches (clinic_id, file_sha256) where status <> 'cancelled';
create index lab_import_batches_clinic_idx on public.lab_import_batches (clinic_id, created_at desc);

create table public.lab_import_rows (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete cascade,
  batch_id uuid not null,
  -- 1-based data row number in the file (the header is row 0).
  row_number integer not null,
  -- The row's cells, aligned with lab_import_batches.headers.
  raw jsonb not null,
  status public.lab_import_row_status not null default 'pending',
  errors text[] not null default '{}',
  -- The server's reading of the row (set by analysis).
  patient_key text,
  patient_id uuid,
  match_kind text,
  match_confirmed_by uuid references public.profiles(id),
  candidate_patient_ids uuid[] not null default '{}',
  test_id uuid,
  parameter_id uuid,
  value_numeric numeric,
  value_text text,
  value_boolean boolean,
  performed_at timestamptz,
  accession text,
  group_key text,
  lab_result_id uuid,
  attempts integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint lab_import_rows_batch_row_key unique (batch_id, row_number),
  constraint lab_import_rows_batch_fkey
    foreign key (batch_id, clinic_id) references public.lab_import_batches (id, clinic_id) on delete cascade,
  constraint lab_import_rows_patient_fkey
    foreign key (patient_id, clinic_id) references public.patients (id, clinic_id) on delete set null (patient_id),
  constraint lab_import_rows_test_fkey
    foreign key (test_id, clinic_id) references public.lab_tests (id, clinic_id),
  constraint lab_import_rows_parameter_fkey
    foreign key (parameter_id, clinic_id) references public.lab_test_parameters (id, clinic_id),
  constraint lab_import_rows_result_fkey
    foreign key (lab_result_id, clinic_id) references public.lab_results (id, clinic_id),
  constraint lab_import_rows_row_number_check check (row_number between 1 and 5000),
  constraint lab_import_rows_raw_check check (jsonb_typeof(raw) = 'array'),
  constraint lab_import_rows_match_kind_check
    check (match_kind is null or match_kind in ('patient_id', 'pinfl', 'document_number', 'staff_confirmed')),
  constraint lab_import_rows_accession_check
    check (accession is null or (accession ~ '\S' and char_length(accession) <= 80)),
  constraint lab_import_rows_group_key_check check (group_key is null or group_key ~ '^[0-9a-f]{64}$'),
  constraint lab_import_rows_text_check check (value_text is null or char_length(value_text) <= 500),
  -- What an importable row must carry.
  constraint lab_import_rows_ready_check
    check (status not in ('ready', 'failed', 'imported')
           or (patient_id is not null and test_id is not null and parameter_id is not null
               and performed_at is not null and group_key is not null
               and num_nonnulls(value_numeric, value_text, value_boolean) = 1)),
  constraint lab_import_rows_imported_check
    check ((status = 'imported') = (lab_result_id is not null)),
  constraint lab_import_rows_confirmed_match_check
    check ((match_kind = 'staff_confirmed') = (match_confirmed_by is not null))
);

create index lab_import_rows_status_idx on public.lab_import_rows (batch_id, status, row_number);
create index lab_import_rows_group_idx on public.lab_import_rows (batch_id, group_key) where group_key is not null;
create index lab_import_rows_patient_idx on public.lab_import_rows (patient_id) where patient_id is not null;

create or replace function public.lab_import_touch()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'INSERT' then
    new.created_at := now();
  else
    new.created_at := old.created_at;
    if new.clinic_id <> old.clinic_id then
      raise exception 'lab import: the clinic cannot change';
    end if;
  end if;
  new.updated_at := now();
  return new;
end;
$$;

revoke all on function public.lab_import_touch() from public, anon, authenticated;

create trigger lab_import_batches_touch
  before insert or update on public.lab_import_batches
  for each row execute function public.lab_import_touch();
create trigger lab_import_rows_touch
  before insert or update on public.lab_import_rows
  for each row execute function public.lab_import_touch();

-- A batch's file, preparer and cells never change after upload; a finished
-- batch never changes at all.
create or replace function public.lab_import_batches_guard()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.created_by <> old.created_by or new.file_sha256 <> old.file_sha256
     or new.headers <> old.headers or new.row_count <> old.row_count or new.file_name <> old.file_name then
    raise exception 'lab import: the uploaded file and its preparer cannot change';
  end if;
  if old.status in ('completed', 'cancelled') then
    raise exception 'lab import: a % batch cannot change', old.status;
  end if;
  if new.status is distinct from old.status and not (
    (old.status, new.status) in (('uploaded', 'analysed'), ('analysed', 'confirmed'), ('confirmed', 'completed'),
                                 ('uploaded', 'cancelled'), ('analysed', 'cancelled'), ('confirmed', 'cancelled'))
  ) then
    raise exception 'lab import: % → % is not allowed', old.status, new.status;
  end if;
  if old.status in ('confirmed') and new.mapping is distinct from old.mapping then
    raise exception 'lab import: the mapping of a confirmed batch cannot change';
  end if;
  return new;
end;
$$;

revoke all on function public.lab_import_batches_guard() from public, anon, authenticated;

create trigger lab_import_batches_guard
  before update on public.lab_import_batches
  for each row execute function public.lab_import_batches_guard();

create or replace function public.lab_import_rows_guard()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.batch_id <> old.batch_id or new.row_number <> old.row_number or new.raw <> old.raw then
    raise exception 'lab import row: the uploaded cells cannot change';
  end if;
  if old.status = 'imported' then
    raise exception 'lab import row: an imported row cannot change';
  end if;
  return new;
end;
$$;

revoke all on function public.lab_import_rows_guard() from public, anon, authenticated;

create trigger lab_import_rows_guard
  before update on public.lab_import_rows
  for each row execute function public.lab_import_rows_guard();

alter table public.lab_import_batches enable row level security;
alter table public.lab_import_rows enable row level security;
-- No policies: no signed-in or anonymous access. The server (service_role)
-- authorizes every request (lab staff holding import.manage) and audits it.
revoke all on table public.lab_import_batches from public, anon, authenticated, service_role;
revoke all on table public.lab_import_rows from public, anon, authenticated, service_role;
grant select, insert, update on table public.lab_import_batches to service_role;
grant select, insert, update on table public.lab_import_rows to service_role;

-- ---------------------------------------------------------------------------
-- store_lab_import_analysis: the server's analysis of every row and the
-- batch's new state, in one locked transaction (a confirmation can never
-- land between them). Only the preparer, only before confirmation.
-- ---------------------------------------------------------------------------

create or replace function public.store_lab_import_analysis(
  p_clinic_id uuid,
  p_batch_id uuid,
  p_actor uuid,
  p_mapping jsonb,
  p_summary jsonb,
  p_rows jsonb
)
returns void
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_batch public.lab_import_batches;
  v_count integer;
begin
  select * into v_batch from public.lab_import_batches b
  where b.id = p_batch_id and b.clinic_id = p_clinic_id
  for update;
  if not found then
    raise exception 'lab_import_not_found: the import is not in this clinic';
  end if;
  if v_batch.status not in ('uploaded', 'analysed') then
    raise exception 'lab_import_not_editable: the import is %', v_batch.status;
  end if;
  if v_batch.created_by <> p_actor then
    raise exception 'lab_import_not_preparer: only the preparer maps and analyses the file';
  end if;

  update public.lab_import_rows r
  set status = x.status,
      errors = coalesce(x.errors, '{}'),
      patient_key = x.patient_key,
      patient_id = x.patient_id,
      match_kind = x.match_kind,
      match_confirmed_by = x.match_confirmed_by,
      candidate_patient_ids = coalesce(x.candidate_patient_ids, '{}'),
      test_id = x.test_id,
      parameter_id = x.parameter_id,
      value_numeric = x.value_numeric,
      value_text = x.value_text,
      value_boolean = x.value_boolean,
      performed_at = x.performed_at,
      accession = x.accession,
      group_key = x.group_key
  from jsonb_to_recordset(p_rows) as x(
    row_number integer, status public.lab_import_row_status, errors text[], patient_key text, patient_id uuid,
    match_kind text, match_confirmed_by uuid, candidate_patient_ids uuid[], test_id uuid, parameter_id uuid,
    value_numeric numeric, value_text text, value_boolean boolean, performed_at timestamptz, accession text, group_key text)
  where r.batch_id = v_batch.id and r.row_number = x.row_number;
  get diagnostics v_count = row_count;
  if v_count <> v_batch.row_count then
    raise exception 'lab_import_rows_mismatch: % of % rows analysed', v_count, v_batch.row_count;
  end if;

  update public.lab_import_batches
  set status = 'analysed', mapping = p_mapping, summary = p_summary, analysed_by = p_actor, analysed_at = now()
  where id = v_batch.id;
end;
$$;

revoke all on function public.store_lab_import_analysis(uuid, uuid, uuid, jsonb, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.store_lab_import_analysis(uuid, uuid, uuid, jsonb, jsonb, jsonb) to service_role;

-- ---------------------------------------------------------------------------
-- run_lab_import
-- ---------------------------------------------------------------------------

create or replace function public.run_lab_import(
  p_clinic_id uuid,
  p_batch_id uuid,
  p_actor uuid,
  p_dry_run boolean,
  p_after_row integer default 0,
  p_max_groups integer default 100
)
returns table (group_key text, first_row integer, outcome text, error_code text, lab_result_id uuid)
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
#variable_conflict use_column
declare
  v_batch public.lab_import_batches;
  v_tz text;
  v_group record;
  v_first public.lab_import_rows;
  v_ref text;
  v_order uuid;
  v_item uuid;
  v_result uuid;
  v_outcome text;
  v_code text;
  v_day date;
  v_status public.lab_import_row_status;
begin
  perform set_config('app.lab_actor', p_actor::text, true);

  select * into v_batch from public.lab_import_batches b
  where b.id = p_batch_id and b.clinic_id = p_clinic_id
  for update;
  if not found then
    raise exception 'lab_import_not_found: the import is not in this clinic';
  end if;
  if not public.lab_is_clinic_member(p_clinic_id, p_actor) then
    raise exception 'lab_import_not_staff: the actor is not a staff member of the clinic';
  end if;
  if p_dry_run then
    if v_batch.status <> 'analysed' then
      raise exception 'lab_import_not_analysed: the import is %', v_batch.status;
    end if;
  else
    if v_batch.status <> 'confirmed' then
      raise exception 'lab_import_not_confirmed: the import is %', v_batch.status;
    end if;
    if p_actor = v_batch.created_by then
      raise exception 'lab_import_second_person: the preparer cannot run the import';
    end if;
  end if;

  select c.timezone into v_tz from public.clinics c where c.id = p_clinic_id;

  for v_group in
    select r.group_key as key, min(r.row_number) as first_row
    from public.lab_import_rows r
    where r.batch_id = v_batch.id and r.group_key is not null
    group by r.group_key
    -- A group is imported whole or not at all: every row must be ready.
    having bool_and(r.status = 'ready') and min(r.row_number) > coalesce(p_after_row, 0)
    order by min(r.row_number)
    limit greatest(1, least(coalesce(p_max_groups, 100), 500))
  loop
    v_outcome := null;
    v_code := null;
    v_result := null;
    select * into v_first from public.lab_import_rows r
    where r.batch_id = v_batch.id and r.group_key = v_group.key
    order by r.row_number
    limit 1;
    v_ref := 'import:' || v_group.key;

    begin
      if exists (
        select 1 from public.lab_orders o
        where o.clinic_id = p_clinic_id and o.source = 'external_import' and o.external_reference = v_ref
      ) then
        raise exception 'lab_import_duplicate: this group was already imported';
      end if;
      -- Never alongside an existing result of the same patient, test and day.
      v_day := (v_first.performed_at at time zone v_tz)::date;
      if exists (
        select 1
        from public.lab_results lr
        join public.lab_order_items i on i.id = lr.order_item_id
        where lr.clinic_id = p_clinic_id
          and lr.patient_id = v_first.patient_id
          and i.test_id = v_first.test_id
          and lr.status <> 'superseded'
          and (coalesce(lr.performed_at, lr.verified_at, lr.entered_at) at time zone v_tz)::date = v_day
      ) then
        raise exception 'lab_import_existing_result: the patient already has this test on this day';
      end if;

      insert into public.lab_orders (clinic_id, patient_id, source, ordered_by, external_reference)
      values (p_clinic_id, v_first.patient_id, 'external_import', v_batch.created_by, v_ref)
      returning id into v_order;

      insert into public.lab_order_items (clinic_id, order_id, patient_id, test_id, test_code_snapshot, test_name_snapshot, list_price_snapshot, price_snapshot)
      values (p_clinic_id, v_order, v_first.patient_id, v_first.test_id, '', '', 0, 0)
      returning id into v_item;

      insert into public.lab_results (clinic_id, order_item_id, patient_id, source, entered_by, performed_at)
      values (p_clinic_id, v_item, v_first.patient_id, 'import', v_batch.created_by, v_first.performed_at)
      returning id into v_result;

      insert into public.lab_result_values (clinic_id, result_id, parameter_id, value_numeric, value_text, value_boolean)
      select p_clinic_id, v_result, r.parameter_id, r.value_numeric, r.value_text, r.value_boolean
      from public.lab_import_rows r
      where r.batch_id = v_batch.id and r.group_key = v_group.key;

      update public.lab_results set status = 'submitted', submitted_by = v_batch.created_by where id = v_result;

      if p_dry_run then
        raise exception 'lab_import_dry_run_ok';
      end if;

      update public.lab_results set status = 'verified', verified_by = p_actor where id = v_result;
      update public.lab_orders set status = 'completed' where id = v_order;
      v_outcome := 'imported';
    exception when others then
      v_result := null;
      if sqlerrm = 'lab_import_dry_run_ok' then
        v_outcome := 'would_import';
      else
        -- Codes only: database messages can quote a value.
        v_code := case
          when sqlerrm like 'lab_import_duplicate%' or sqlstate = '23505' then 'already_imported'
          when sqlerrm like 'lab_import_existing_result%' then 'existing_result'
          when sqlerrm like '%expects a%' or sqlerrm like '%configured choices%' or sqlerrm like '%decimal places%'
               or sqlerrm like '%does not belong to the ordered test%' then 'value_rejected'
          when sqlerrm like '%cannot be in the future%' then 'invalid_date'
          when sqlerrm like '%must be a staff member%' then 'preparer_not_staff'
          when sqlerrm like '%unknown test%' or sqlstate = '23503' then 'reference_missing'
          else 'import_failed'
        end;
        v_outcome := case when v_code in ('already_imported', 'existing_result') then 'duplicate' else 'failed' end;
      end if;
    end;

    if not p_dry_run then
      v_status := case v_outcome when 'imported' then 'imported' when 'duplicate' then 'duplicate' else 'failed' end;
      update public.lab_import_rows r
      set status = v_status,
          errors = case when v_code is null then '{}'::text[] else array[v_code] end,
          lab_result_id = v_result,
          attempts = r.attempts + 1
      where r.batch_id = v_batch.id and r.group_key = v_group.key;
    end if;

    group_key := v_group.key;
    first_row := v_group.first_row;
    outcome := v_outcome;
    error_code := v_code;
    lab_result_id := v_result;
    return next;
  end loop;

  if not p_dry_run and not exists (
    select 1 from public.lab_import_rows r where r.batch_id = v_batch.id and r.status in ('ready', 'failed')
  ) then
    update public.lab_import_batches set status = 'completed', completed_at = now() where id = v_batch.id;
  end if;
end;
$$;

revoke all on function public.run_lab_import(uuid, uuid, uuid, boolean, integer, integer) from public, anon, authenticated;
grant execute on function public.run_lab_import(uuid, uuid, uuid, boolean, integer, integer) to service_role;

-- ---------------------------------------------------------------------------
-- Historical results never notify the patient.
-- ---------------------------------------------------------------------------

create or replace function public.lab_results_notify_patient()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_telegram bigint;
begin
  if new.source = 'import' then
    return null; -- historical data brought in by an import: not news to the patient
  end if;
  if not public.lab_release_to_patient(new.clinic_id) then
    return null;
  end if;
  select p.telegram_user_id into v_telegram
  from public.patients p
  where p.id = new.patient_id and p.clinic_id = new.clinic_id;
  if v_telegram is null then
    return null; -- no Telegram identity: the result is still in the Mini App once linked
  end if;

  insert into public.notification_jobs (clinic_id, type, lab_result_id, patient_telegram_user_id, scheduled_for, idempotency_key)
  values (new.clinic_id, 'lab_result_ready', new.id, v_telegram, now(), 'lab_result_ready:' || new.id::text)
  on conflict (idempotency_key) do nothing;
  return null;
end;
$$;

revoke all on function public.lab_results_notify_patient() from public, anon, authenticated;

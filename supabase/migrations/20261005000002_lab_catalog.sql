-- Laboratory (Phase 2, 2 of 4): the clinic-configured lab catalog.
--
-- docs/labs/PHASE_1_DOMAIN_MODEL.md §3.1. Configuration is data: each clinic
-- defines its own categories, tests, measured parameters, units, reference
-- ranges, panels and prices. Nothing here interprets a value clinically; a
-- reference range is a configured bound, and critical bounds are only
-- configured and displayed (critical-result alerts are deferred).
--
--   lab_test_categories  grouping of tests (not a department, not specialties —
--                        specialties feed the public catalog and AI navigation)
--   lab_tests            one orderable test, with its price
--   lab_test_parameters  the measured fields of a test (CBC → Hemoglobin, WBC …)
--   lab_reference_ranges configured bounds per parameter, optionally per sex
--                        and age band; overlapping active ranges are refused
--   lab_panels           a named set of tests ordered together, with its price
--   lab_panel_tests      panel membership
--
-- Every table is clinic-owned; every reference is a composite foreign key
-- (x_id, clinic_id) so a row can never point into another clinic. Rows that
-- history references cannot be deleted (no cascade from a test to its
-- parameters or ranges); clinics deactivate them instead.
--
-- Access: clinic staff may read the catalog (it holds no patient data);
-- nobody signed in may write it — configuration goes through the server
-- (Phase 4), like services and specialties.

create type public.lab_value_type as enum ('numeric', 'text', 'boolean', 'choice');

comment on type public.lab_value_type is
  'How a lab parameter is recorded: numeric (with unit), free text, yes/no, or one of configured choices.';

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table public.lab_test_categories (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete cascade,
  name text not null,
  sort_order integer not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint lab_test_categories_id_clinic_id_key unique (id, clinic_id),
  constraint lab_test_categories_clinic_name_key unique (clinic_id, name),
  constraint lab_test_categories_name_check check (name ~ '\S' and char_length(name) <= 120)
);

create table public.lab_tests (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete cascade,
  category_id uuid,
  code text not null,
  name text not null,
  sample_type text not null,
  preparation_text text,
  turnaround_hours integer,
  price numeric(12, 2) not null default 0,
  sort_order integer not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint lab_tests_id_clinic_id_key unique (id, clinic_id),
  constraint lab_tests_clinic_code_key unique (clinic_id, code),
  constraint lab_tests_clinic_name_key unique (clinic_id, name),
  constraint lab_tests_category_fkey
    foreign key (category_id, clinic_id) references public.lab_test_categories (id, clinic_id)
    on delete set null (category_id),
  constraint lab_tests_code_check check (code ~ '^[A-Za-z0-9._-]{1,32}$'),
  constraint lab_tests_name_check check (name ~ '\S' and char_length(name) <= 200),
  constraint lab_tests_sample_type_check check (sample_type ~ '\S' and char_length(sample_type) <= 80),
  constraint lab_tests_preparation_check check (preparation_text is null or char_length(preparation_text) <= 2000),
  constraint lab_tests_turnaround_check check (turnaround_hours is null or turnaround_hours between 1 and 8760),
  constraint lab_tests_price_check check (price >= 0)
);

create table public.lab_test_parameters (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete cascade,
  test_id uuid not null,
  code text not null,
  name text not null,
  value_type public.lab_value_type not null,
  unit text,
  decimals smallint,
  choices text[],
  sort_order integer not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint lab_test_parameters_id_clinic_id_key unique (id, clinic_id),
  constraint lab_test_parameters_test_code_key unique (test_id, code),
  constraint lab_test_parameters_test_fkey
    foreign key (test_id, clinic_id) references public.lab_tests (id, clinic_id),
  constraint lab_test_parameters_code_check check (code ~ '^[A-Za-z0-9._-]{1,32}$'),
  constraint lab_test_parameters_name_check check (name ~ '\S' and char_length(name) <= 200),
  constraint lab_test_parameters_unit_check
    check (unit is null or (value_type = 'numeric' and unit ~ '\S' and char_length(unit) <= 40)),
  constraint lab_test_parameters_decimals_check
    check (decimals is null or (value_type = 'numeric' and decimals between 0 and 6)),
  constraint lab_test_parameters_choices_check
    check ((value_type = 'choice') = (choices is not null)
           and (choices is null or (cardinality(choices) between 2 and 50 and array_position(choices, null) is null)))
);

create table public.lab_reference_ranges (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete cascade,
  parameter_id uuid not null,
  -- NULL = applies to any sex.
  sex public.patient_sex,
  -- Age band in days, inclusive; NULL bound = open.
  age_min_days integer,
  age_max_days integer,
  low numeric,
  high numeric,
  critical_low numeric,
  critical_high numeric,
  -- Expected value for text / boolean / choice parameters.
  normal_text text,
  -- Free label for the laboratory, method or equipment the range belongs to.
  method_label text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint lab_reference_ranges_id_clinic_id_key unique (id, clinic_id),
  constraint lab_reference_ranges_parameter_fkey
    foreign key (parameter_id, clinic_id) references public.lab_test_parameters (id, clinic_id),
  constraint lab_reference_ranges_age_check
    check ((age_min_days is null or age_min_days >= 0)
           and (age_max_days is null or age_max_days >= 0)
           and (age_min_days is null or age_max_days is null or age_min_days <= age_max_days)),
  constraint lab_reference_ranges_bounds_check
    check ((low is null or high is null or low <= high)
           and (critical_low is null or low is null or critical_low <= low)
           and (critical_high is null or high is null or critical_high >= high)
           and (critical_low is null or critical_high is null or critical_low < critical_high)),
  constraint lab_reference_ranges_something_check
    check (num_nonnulls(low, high, normal_text) > 0),
  constraint lab_reference_ranges_normal_text_check
    check (normal_text is null or (normal_text ~ '\S' and char_length(normal_text) <= 200)),
  constraint lab_reference_ranges_method_check
    check (method_label is null or (method_label ~ '\S' and char_length(method_label) <= 120))
);

create table public.lab_panels (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete cascade,
  code text not null,
  name text not null,
  price numeric(12, 2) not null default 0,
  sort_order integer not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint lab_panels_id_clinic_id_key unique (id, clinic_id),
  constraint lab_panels_clinic_code_key unique (clinic_id, code),
  constraint lab_panels_clinic_name_key unique (clinic_id, name),
  constraint lab_panels_code_check check (code ~ '^[A-Za-z0-9._-]{1,32}$'),
  constraint lab_panels_name_check check (name ~ '\S' and char_length(name) <= 200),
  constraint lab_panels_price_check check (price >= 0)
);

create table public.lab_panel_tests (
  panel_id uuid not null,
  test_id uuid not null,
  clinic_id uuid not null references public.clinics(id) on delete cascade,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  primary key (panel_id, test_id),
  constraint lab_panel_tests_panel_fkey
    foreign key (panel_id, clinic_id) references public.lab_panels (id, clinic_id) on delete cascade,
  constraint lab_panel_tests_test_fkey
    foreign key (test_id, clinic_id) references public.lab_tests (id, clinic_id)
);

comment on table public.lab_test_categories is 'Clinic-defined grouping of lab tests (configuration; not a department, not specialties).';
comment on table public.lab_tests is 'Clinic-configured orderable lab test. Deactivate instead of deleting once ordered.';
comment on table public.lab_test_parameters is 'A measured field of a lab test with its value type and unit.';
comment on table public.lab_reference_ranges is 'Configured reference (and optional critical) bounds per parameter, optionally per sex and age band. Configuration only — no clinical interpretation.';
comment on table public.lab_panels is 'A named set of lab tests ordered together at the panel price.';
comment on table public.lab_panel_tests is 'Membership of lab tests in a panel.';

create index lab_tests_clinic_active_idx on public.lab_tests (clinic_id, active, sort_order);
create index lab_tests_category_idx on public.lab_tests (category_id) where category_id is not null;
create index lab_test_parameters_test_idx on public.lab_test_parameters (test_id, sort_order);
create index lab_reference_ranges_parameter_idx on public.lab_reference_ranges (parameter_id) where active;
create index lab_panel_tests_test_idx on public.lab_panel_tests (test_id);

-- ---------------------------------------------------------------------------
-- Validation
-- ---------------------------------------------------------------------------

-- Server-stamped timestamps, as everywhere else.
create or replace function public.lab_touch_timestamps()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'INSERT' then
    new.created_at := now();
  else
    new.created_at := old.created_at;
  end if;
  new.updated_at := now();
  return new;
end;
$$;

revoke all on function public.lab_touch_timestamps() from public, anon, authenticated;

create trigger lab_test_categories_touch before insert or update on public.lab_test_categories
  for each row execute function public.lab_touch_timestamps();
create trigger lab_tests_touch before insert or update on public.lab_tests
  for each row execute function public.lab_touch_timestamps();
create trigger lab_test_parameters_touch before insert or update on public.lab_test_parameters
  for each row execute function public.lab_touch_timestamps();
create trigger lab_reference_ranges_touch before insert or update on public.lab_reference_ranges
  for each row execute function public.lab_touch_timestamps();
create trigger lab_panels_touch before insert or update on public.lab_panels
  for each row execute function public.lab_touch_timestamps();

-- A parameter's identity (test, code, value type) is fixed once created:
-- stored results are interpreted through it. Name, unit display, choices
-- (append-only would be a Phase 4 rule), order and active may change.
create or replace function public.lab_test_parameters_validate()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'UPDATE' and (
       new.test_id is distinct from old.test_id
       or new.code is distinct from old.code
       or new.value_type is distinct from old.value_type
       or new.clinic_id is distinct from old.clinic_id
     ) then
    raise exception 'lab parameter: test, code and value type cannot change; add a new parameter instead';
  end if;
  return new;
end;
$$;

revoke all on function public.lab_test_parameters_validate() from public, anon, authenticated;

create trigger lab_test_parameters_validate
  before update on public.lab_test_parameters
  for each row execute function public.lab_test_parameters_validate();

-- Ranges: numeric bounds only for numeric parameters, normal_text only for
-- the others; and no two ACTIVE ranges of a parameter may both apply to the
-- same patient (same sex value — NULL counts as its own value — and
-- overlapping age bands), so range selection is never ambiguous.
create or replace function public.lab_reference_ranges_validate()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_type public.lab_value_type;
  v_choices text[];
  v_clash uuid;
begin
  if tg_op = 'UPDATE' and (new.parameter_id is distinct from old.parameter_id or new.clinic_id is distinct from old.clinic_id) then
    raise exception 'lab reference range: the parameter cannot change; add a new range instead';
  end if;

  -- Serialise range changes per parameter so the overlap check cannot race.
  select p.value_type, p.choices into v_type, v_choices
  from public.lab_test_parameters p
  where p.id = new.parameter_id and p.clinic_id = new.clinic_id
  for update;

  if v_type = 'boolean' and new.normal_text is not null and new.normal_text not in ('true', 'false') then
    raise exception 'lab reference range: the expected value of a yes/no parameter is true or false';
  end if;
  if v_type = 'choice' and new.normal_text is not null and not (new.normal_text = any (v_choices)) then
    raise exception 'lab reference range: the expected value must be one of the parameter''s choices';
  end if;

  if v_type = 'numeric' then
    if new.normal_text is not null then
      raise exception 'lab reference range: numeric parameters use low/high bounds, not normal_text';
    end if;
  else
    if num_nonnulls(new.low, new.high, new.critical_low, new.critical_high) > 0 or new.normal_text is null then
      raise exception 'lab reference range: % parameters use normal_text only', v_type;
    end if;
  end if;

  if new.active then
    select r.id into v_clash
    from public.lab_reference_ranges r
    where r.parameter_id = new.parameter_id
      and r.active
      and r.id <> new.id
      and r.sex is not distinct from new.sex
      and coalesce(r.age_min_days, 0) <= coalesce(new.age_max_days, 2147483647)
      and coalesce(new.age_min_days, 0) <= coalesce(r.age_max_days, 2147483647)
    limit 1;
    if found then
      raise exception 'lab reference range: overlaps active range % for the same sex and age band', v_clash;
    end if;
  end if;
  return new;
end;
$$;

revoke all on function public.lab_reference_ranges_validate() from public, anon, authenticated;

create trigger lab_reference_ranges_validate
  before insert or update on public.lab_reference_ranges
  for each row execute function public.lab_reference_ranges_validate();

-- ---------------------------------------------------------------------------
-- Audit: configuration changes (no patient data in these tables)
-- ---------------------------------------------------------------------------

create trigger lab_tests_audit after insert or update or delete on public.lab_tests
  for each row execute function public.audit_track_changes();
create trigger lab_test_parameters_audit after insert or update or delete on public.lab_test_parameters
  for each row execute function public.audit_track_changes();
create trigger lab_reference_ranges_audit after insert or update or delete on public.lab_reference_ranges
  for each row execute function public.audit_track_changes();
create trigger lab_panels_audit after insert or update or delete on public.lab_panels
  for each row execute function public.audit_track_changes();

-- ---------------------------------------------------------------------------
-- Access: staff read, server writes
-- ---------------------------------------------------------------------------

alter table public.lab_test_categories enable row level security;
alter table public.lab_tests enable row level security;
alter table public.lab_test_parameters enable row level security;
alter table public.lab_reference_ranges enable row level security;
alter table public.lab_panels enable row level security;
alter table public.lab_panel_tests enable row level security;

create policy "lab test categories read for clinic staff" on public.lab_test_categories
  for select to authenticated using (public.is_clinic_staff(clinic_id));
create policy "lab tests read for clinic staff" on public.lab_tests
  for select to authenticated using (public.is_clinic_staff(clinic_id));
create policy "lab test parameters read for clinic staff" on public.lab_test_parameters
  for select to authenticated using (public.is_clinic_staff(clinic_id));
create policy "lab reference ranges read for clinic staff" on public.lab_reference_ranges
  for select to authenticated using (public.is_clinic_staff(clinic_id));
create policy "lab panels read for clinic staff" on public.lab_panels
  for select to authenticated using (public.is_clinic_staff(clinic_id));
create policy "lab panel tests read for clinic staff" on public.lab_panel_tests
  for select to authenticated using (public.is_clinic_staff(clinic_id));

do $$
declare
  t text;
begin
  foreach t in array array['lab_test_categories', 'lab_tests', 'lab_test_parameters',
                           'lab_reference_ranges', 'lab_panels', 'lab_panel_tests'] loop
    execute format('revoke all on table public.%I from public, anon, authenticated, service_role', t);
    execute format('grant select on table public.%I to authenticated', t);
    execute format('grant select, insert, update, delete on table public.%I to service_role', t);
  end loop;
end;
$$;

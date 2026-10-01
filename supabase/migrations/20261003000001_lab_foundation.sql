-- Laboratory module, phase 2: the domain model.
--
-- docs/labs/PHASE_1_AUDIT.md and docs/labs/DECISIONS.md are the authority. This migration adds the
-- NORMALIZED laboratory model inside the existing Health AI schema. It reuses clinics, patients,
-- doctors, appointments (the ordering consultation), referrals, profiles/staff_roles, audit_events
-- and the composite same-clinic FK discipline; it creates NO second patient, doctor, payment,
-- history or audit system. Payments (D2), roles (phase 3), documents' bytes (phase 7), patient
-- delivery (phase 8) and identity (own phase) are NOT part of it.
--
-- Entities
--   catalog (clinic configuration):  lab_categories, lab_tests, lab_test_parameters,
--                                    lab_reference_ranges, lab_panels, lab_panel_tests
--   workflow:                        lab_orders, lab_order_items, lab_samples, lab_sample_items
--   results:                         lab_results (one per order item), lab_result_versions
--                                    (append-only lineage; verification is a property of a version),
--                                    lab_result_values (structured values + the reference range used),
--                                    lab_result_attachments (metadata; storage comes in phase 7)
--
-- Five concepts that stay separate (never one combined status):
--   ORDER status        lab_orders.status
--   PAYMENT status      payments.status           (phase 5: payments are extended, not duplicated)
--   SAMPLE status       lab_samples.status
--   RESULT status       lab_results.status        (= status of the latest version, kept by triggers)
--   VERIFICATION        lab_result_versions.status / verified_by / verified_at
--
-- Why not `specialties`: lab sections are not clinical departments (they drive doctor catalogs and
-- department referrals). Why not `clinical_records`: those are doctor-authored in the doctor's own
-- consultation; a lab result is entered by lab staff. A doctor's own interpretation stays a
-- clinical record of theirs.
--
-- Security model (same as clinical_records):
--   * RLS is enabled on every table. Signed-in roles read ONLY the non-clinical catalog (clinic staff,
--     policy below). The order/sample/result tables have no signed-in grant and no policy: every read
--     goes through the server, which authorizes it with doctor_patient_access() and audits it.
--   * Only service_role writes, with the narrowest grants (no DELETE anywhere, UPDATE only on the
--     columns a lifecycle needs). Triggers enforce lifecycle, immutability and snapshots; they ignore
--     anything the client claims about prices, flags, versions or timestamps.
--   * No cascade anywhere: a patient, appointment or clinic with laboratory data cannot be deleted
--     (retention; no period is assumed — see retention_data_category 'laboratory').
--   * The audit trail is ids-only and written by purpose-built triggers; the generic
--     audit_track_changes() is deliberately NOT used (it would copy result values into audit_events).
--
-- Reversible: drop the tables below in reverse dependency order (lab_result_attachments,
-- lab_result_values, lab_result_versions, lab_results, lab_sample_items, lab_samples,
-- lab_order_items, lab_orders, lab_panel_tests, lab_panels, lab_reference_ranges,
-- lab_test_parameters, lab_tests, lab_categories), then the lab_* functions and the lab_* enum types.
-- Also: alter table public.referrals drop constraint referrals_id_clinic_id_patient_id_key.
-- The 'laboratory' value added to retention_data_category cannot be removed from an enum and is left.

-- ---------------------------------------------------------------------------
-- 0. Types
-- ---------------------------------------------------------------------------

create type public.lab_data_type as enum ('numeric', 'text', 'choice');
create type public.lab_priority as enum ('routine', 'urgent');
create type public.lab_order_status as enum ('ordered', 'in_progress', 'completed', 'cancelled');
create type public.lab_item_status as enum ('active', 'cancelled');
create type public.lab_sample_status as enum ('awaiting_collection', 'collected', 'processing', 'rejected', 'cancelled');
create type public.lab_result_status as enum ('draft', 'pending_verification', 'verified');
create type public.lab_version_status as enum ('draft', 'pending_verification', 'verified', 'superseded');
-- "outside configured reference range" — never a diagnosis.
create type public.lab_flag as enum ('normal', 'low', 'high', 'critical_low', 'critical_high', 'unclassified');

alter type public.retention_data_category add value if not exists 'laboratory';

-- ---------------------------------------------------------------------------
-- 1. Catalog (clinic configuration; not clinical text)
-- ---------------------------------------------------------------------------

create table public.lab_categories (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics (id) on delete restrict,
  name text not null check (name ~ '\S' and char_length(name) <= 80),
  sort_order integer not null default 0,
  active boolean not null default true,
  updated_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint lab_categories_id_clinic_key unique (id, clinic_id),
  constraint lab_categories_name_key unique (clinic_id, name)
);

create table public.lab_tests (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics (id) on delete restrict,
  category_id uuid,
  code text not null check (code ~ '^[A-Za-z0-9._-]{1,32}$'),
  name text not null check (name ~ '\S' and char_length(name) <= 160),
  description text check (description is null or char_length(description) <= 1000),
  -- The authoritative price; every order item snapshots it.
  price numeric(12, 2) not null default 0 check (price >= 0),
  sample_type text check (sample_type is null or (sample_type ~ '\S' and char_length(sample_type) <= 60)),
  preparation_text text check (preparation_text is null or char_length(preparation_text) <= 2000),
  turnaround_minutes integer check (turnaround_minutes is null or turnaround_minutes > 0),
  active boolean not null default true,
  updated_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint lab_tests_id_clinic_key unique (id, clinic_id),
  constraint lab_tests_category_fkey foreign key (category_id, clinic_id) references public.lab_categories (id, clinic_id)
);
create unique index lab_tests_clinic_code_key on public.lab_tests (clinic_id, lower(code));
create index lab_tests_clinic_active_idx on public.lab_tests (clinic_id, active);

create table public.lab_test_parameters (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics (id) on delete restrict,
  test_id uuid not null,
  code text not null check (code ~ '^[A-Za-z0-9._-]{1,32}$'),
  name text not null check (name ~ '\S' and char_length(name) <= 120),
  unit text check (unit is null or char_length(unit) <= 32),
  data_type public.lab_data_type not null default 'numeric',
  -- For data_type = 'choice': the allowed values.
  choices text[],
  display_order integer not null default 0,
  active boolean not null default true,
  updated_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint lab_test_parameters_id_clinic_key unique (id, clinic_id),
  constraint lab_test_parameters_test_code_key unique (test_id, code),
  constraint lab_test_parameters_test_fkey foreign key (test_id, clinic_id) references public.lab_tests (id, clinic_id),
  constraint lab_test_parameters_choices_check check ((data_type = 'choice') = (choices is not null and cardinality(choices) > 0))
);

-- Reference ranges are configured data, never global constants. Bounds only where the clinic set them.
create table public.lab_reference_ranges (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics (id) on delete restrict,
  parameter_id uuid not null,
  age_min_years integer check (age_min_years is null or age_min_years >= 0),
  age_max_years integer check (age_max_years is null or age_max_years >= 0),
  low numeric,
  high numeric,
  critical_low numeric,
  critical_high numeric,
  note text check (note is null or char_length(note) <= 200),
  active boolean not null default true,
  updated_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint lab_reference_ranges_id_clinic_key unique (id, clinic_id),
  constraint lab_reference_ranges_parameter_fkey foreign key (parameter_id, clinic_id) references public.lab_test_parameters (id, clinic_id),
  constraint lab_reference_ranges_some_bound check (num_nonnulls(low, high, critical_low, critical_high) > 0),
  constraint lab_reference_ranges_order check (
    (low is null or high is null or low <= high)
    and (critical_low is null or low is null or critical_low <= low)
    and (critical_high is null or high is null or critical_high >= high)
    and (critical_low is null or critical_high is null or critical_low <= critical_high)
    and (age_min_years is null or age_max_years is null or age_min_years <= age_max_years)
  )
);

create table public.lab_panels (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics (id) on delete restrict,
  code text not null check (code ~ '^[A-Za-z0-9._-]{1,32}$'),
  name text not null check (name ~ '\S' and char_length(name) <= 160),
  description text check (description is null or char_length(description) <= 1000),
  -- null: the panel costs the sum of its tests. A fixed panel price is applied at billing (phase 5).
  price numeric(12, 2) check (price is null or price >= 0),
  active boolean not null default true,
  updated_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint lab_panels_id_clinic_key unique (id, clinic_id)
);
create unique index lab_panels_clinic_code_key on public.lab_panels (clinic_id, lower(code));

create table public.lab_panel_tests (
  panel_id uuid not null,
  test_id uuid not null,
  clinic_id uuid not null references public.clinics (id) on delete restrict,
  sort_order integer not null default 0,
  primary key (panel_id, test_id),
  constraint lab_panel_tests_panel_fkey foreign key (panel_id, clinic_id) references public.lab_panels (id, clinic_id),
  constraint lab_panel_tests_test_fkey foreign key (test_id, clinic_id) references public.lab_tests (id, clinic_id)
);

-- ---------------------------------------------------------------------------
-- 2. Orders, items, samples (clinical workflow; server-read only)
-- ---------------------------------------------------------------------------

-- referrals gets the composite key a same-clinic, same-patient reference needs (additive; no data change).
alter table public.referrals add constraint referrals_id_clinic_id_patient_id_key unique (id, clinic_id, patient_id);

create table public.lab_orders (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics (id) on delete restrict,
  patient_id uuid not null,
  ordering_doctor_id uuid not null,
  -- The ordering doctor's own consultation with this patient (same discipline as clinical_records).
  appointment_id uuid not null,
  referral_id uuid,
  priority public.lab_priority not null default 'routine',
  -- Clinical text: doctor-written, never shown to operational staff, logs, audit or analytics.
  notes text check (notes is null or (notes ~ '\S' and char_length(notes) <= 1000)),
  status public.lab_order_status not null default 'ordered',
  -- Idempotent submission: a repeated request resolves to this order.
  creation_key uuid,
  created_by uuid not null references public.profiles (id),
  cancelled_at timestamptz,
  cancelled_by uuid references public.profiles (id),
  cancel_reason text check (cancel_reason is null or (cancel_reason ~ '\S' and char_length(cancel_reason) <= 300)),
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint lab_orders_id_clinic_key unique (id, clinic_id),
  constraint lab_orders_id_clinic_patient_key unique (id, clinic_id, patient_id),
  constraint lab_orders_patient_fkey foreign key (patient_id, clinic_id) references public.patients (id, clinic_id),
  constraint lab_orders_doctor_fkey foreign key (ordering_doctor_id, clinic_id) references public.doctors (id, clinic_id),
  constraint lab_orders_consultation_fkey foreign key (appointment_id, clinic_id, patient_id, ordering_doctor_id)
    references public.appointments (id, clinic_id, patient_id, doctor_id),
  -- Same clinic AND same patient as the referral (referral_id null: not enforced).
  constraint lab_orders_referral_fkey foreign key (referral_id, clinic_id, patient_id)
    references public.referrals (id, clinic_id, patient_id),
  constraint lab_orders_cancelled_fields check ((status = 'cancelled') = (cancelled_at is not null and cancelled_by is not null and cancel_reason is not null)),
  constraint lab_orders_completed_fields check ((status = 'completed') = (completed_at is not null))
);
create unique index lab_orders_creation_key on public.lab_orders (ordering_doctor_id, creation_key) where creation_key is not null;
create index lab_orders_patient_idx on public.lab_orders (clinic_id, patient_id, created_at desc);
create index lab_orders_status_idx on public.lab_orders (clinic_id, status, created_at desc);

create table public.lab_order_items (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics (id) on delete restrict,
  order_id uuid not null,
  test_id uuid not null,
  -- Set when the item came from a panel.
  panel_id uuid,
  -- Snapshots taken by the database from the catalog at order time (the client cannot set them):
  test_code text not null,
  test_name text not null,
  sample_type text,
  price_snapshot numeric(12, 2) not null check (price_snapshot >= 0),
  status public.lab_item_status not null default 'active',
  cancelled_at timestamptz,
  cancel_reason text check (cancel_reason is null or (cancel_reason ~ '\S' and char_length(cancel_reason) <= 300)),
  created_at timestamptz not null default now(),
  constraint lab_order_items_id_clinic_key unique (id, clinic_id),
  constraint lab_order_items_id_clinic_order_key unique (id, clinic_id, order_id),
  constraint lab_order_items_order_test_key unique (order_id, test_id),
  constraint lab_order_items_order_fkey foreign key (order_id, clinic_id) references public.lab_orders (id, clinic_id),
  constraint lab_order_items_test_fkey foreign key (test_id, clinic_id) references public.lab_tests (id, clinic_id),
  constraint lab_order_items_panel_fkey foreign key (panel_id, clinic_id) references public.lab_panels (id, clinic_id),
  constraint lab_order_items_cancelled_fields check ((status = 'cancelled') = (cancelled_at is not null and cancel_reason is not null))
);
create index lab_order_items_order_idx on public.lab_order_items (order_id);

create table public.lab_samples (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics (id) on delete restrict,
  order_id uuid not null,
  patient_id uuid not null,
  sample_type text not null check (sample_type ~ '\S' and char_length(sample_type) <= 60),
  -- The tube/barcode the laboratory prints; unique per clinic.
  sample_code text not null check (sample_code ~ '^[A-Za-z0-9._-]{1,40}$'),
  status public.lab_sample_status not null default 'awaiting_collection',
  collected_at timestamptz,
  collected_by uuid references public.profiles (id),
  rejected_reason text check (rejected_reason is null or (rejected_reason ~ '\S' and char_length(rejected_reason) <= 300)),
  -- Operational note (e.g. "hemolysed"), not clinical text.
  notes text check (notes is null or char_length(notes) <= 200),
  created_by uuid not null references public.profiles (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint lab_samples_id_clinic_key unique (id, clinic_id),
  constraint lab_samples_id_clinic_order_key unique (id, clinic_id, order_id),
  constraint lab_samples_code_key unique (clinic_id, sample_code),
  constraint lab_samples_order_fkey foreign key (order_id, clinic_id, patient_id) references public.lab_orders (id, clinic_id, patient_id),
  constraint lab_samples_collected_fields check ((status in ('collected', 'processing')) <= (collected_at is not null and collected_by is not null)),
  constraint lab_samples_rejected_fields check ((status = 'rejected') = (rejected_reason is not null))
);
-- One live sample per order and type: a duplicate collection request is refused.
create unique index lab_samples_one_live_per_type on public.lab_samples (order_id, sample_type)
  where status in ('awaiting_collection', 'collected', 'processing');
create index lab_samples_status_idx on public.lab_samples (clinic_id, status, created_at desc);

-- Which order items a sample serves (a tube can serve several tests).
create table public.lab_sample_items (
  sample_id uuid not null,
  order_item_id uuid not null,
  clinic_id uuid not null references public.clinics (id) on delete restrict,
  order_id uuid not null,
  primary key (sample_id, order_item_id),
  constraint lab_sample_items_sample_fkey foreign key (sample_id, clinic_id, order_id) references public.lab_samples (id, clinic_id, order_id),
  constraint lab_sample_items_item_fkey foreign key (order_item_id, clinic_id, order_id) references public.lab_order_items (id, clinic_id, order_id)
);

-- ---------------------------------------------------------------------------
-- 3. Results: header + append-only versions + structured values
-- ---------------------------------------------------------------------------

create table public.lab_results (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics (id) on delete restrict,
  order_item_id uuid not null,
  order_id uuid not null,
  patient_id uuid not null,
  -- Status of the latest version, maintained by the version triggers (not writable by the app).
  status public.lab_result_status not null default 'draft',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint lab_results_id_clinic_key unique (id, clinic_id),
  constraint lab_results_item_key unique (order_item_id),
  constraint lab_results_item_fkey foreign key (order_item_id, clinic_id, order_id) references public.lab_order_items (id, clinic_id, order_id),
  constraint lab_results_order_fkey foreign key (order_id, clinic_id, patient_id) references public.lab_orders (id, clinic_id, patient_id)
);
create index lab_results_patient_idx on public.lab_results (clinic_id, patient_id, created_at desc);

create table public.lab_result_versions (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics (id) on delete restrict,
  result_id uuid not null,
  -- Assigned by the database: 1, 2, 3… A correction is a new version; no version is ever rewritten.
  version integer not null,
  status public.lab_version_status not null default 'draft',
  -- Who entered THIS version (for a correction: the corrector — the original author is version 1's).
  entered_by uuid not null references public.profiles (id),
  entered_at timestamptz not null default now(),
  verified_by uuid references public.profiles (id),
  verified_at timestamptz,
  -- The verified version this one corrects, and why.
  corrects_version_id uuid,
  correction_reason text check (correction_reason is null or (correction_reason ~ '\S' and char_length(correction_reason) <= 300)),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint lab_result_versions_id_clinic_key unique (id, clinic_id),
  constraint lab_result_versions_result_version_key unique (result_id, version),
  constraint lab_result_versions_result_fkey foreign key (result_id, clinic_id) references public.lab_results (id, clinic_id),
  constraint lab_result_versions_corrects_fkey foreign key (corrects_version_id, clinic_id) references public.lab_result_versions (id, clinic_id),
  constraint lab_result_versions_verified_fields check (
    (status = 'verified') <= (verified_by is not null and verified_at is not null)
    and (status in ('draft', 'pending_verification')) <= (verified_by is null and verified_at is null)
  ),
  constraint lab_result_versions_correction_fields check ((version > 1) = (corrects_version_id is not null and correction_reason is not null))
);
-- One version in progress at a time, and exactly one current verified version.
create unique index lab_result_versions_one_open on public.lab_result_versions (result_id) where status in ('draft', 'pending_verification');
create unique index lab_result_versions_one_verified on public.lab_result_versions (result_id) where status = 'verified';

create table public.lab_result_values (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics (id) on delete restrict,
  version_id uuid not null,
  parameter_id uuid not null,
  -- Snapshots from the parameter (set by the database): the result stays readable if the catalog changes.
  parameter_code text not null,
  parameter_name text not null,
  unit text,
  value_numeric numeric,
  value_text text check (value_text is null or char_length(value_text) <= 500),
  -- The reference range the value was evaluated against; its bounds are copied here by the database.
  reference_range_id uuid,
  ref_low numeric,
  ref_high numeric,
  critical_low numeric,
  critical_high numeric,
  -- Computed by the database from the value and the snapshotted bounds. "Outside configured reference
  -- range" only — never a disease name.
  flag public.lab_flag not null default 'unclassified',
  created_at timestamptz not null default now(),
  constraint lab_result_values_id_clinic_key unique (id, clinic_id),
  constraint lab_result_values_version_parameter_key unique (version_id, parameter_id),
  constraint lab_result_values_version_fkey foreign key (version_id, clinic_id) references public.lab_result_versions (id, clinic_id),
  constraint lab_result_values_parameter_fkey foreign key (parameter_id, clinic_id) references public.lab_test_parameters (id, clinic_id),
  constraint lab_result_values_range_fkey foreign key (reference_range_id, clinic_id) references public.lab_reference_ranges (id, clinic_id),
  constraint lab_result_values_one_value check (num_nonnulls(value_numeric, value_text) = 1)
);

-- Metadata only: the bytes live in a private bucket added in phase 7. No file names (they can carry names).
create table public.lab_result_attachments (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics (id) on delete restrict,
  result_id uuid not null,
  storage_path text not null unique check (storage_path ~ '^[A-Za-z0-9/_.-]{1,300}$'),
  content_type text not null check (content_type in ('application/pdf', 'image/png', 'image/jpeg')),
  size_bytes bigint not null check (size_bytes > 0),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  uploaded_by uuid not null references public.profiles (id),
  created_at timestamptz not null default now(),
  constraint lab_result_attachments_result_fkey foreign key (result_id, clinic_id) references public.lab_results (id, clinic_id)
);
create index lab_result_attachments_result_idx on public.lab_result_attachments (result_id);

-- ---------------------------------------------------------------------------
-- 4. Helpers
-- ---------------------------------------------------------------------------

create or replace function public.lab_is_clinic_staff(p_profile uuid, p_clinic uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select p_profile is not null and exists (
    select 1 from public.staff_roles sr where sr.profile_id = p_profile and sr.clinic_id = p_clinic
  );
$$;
revoke all on function public.lab_is_clinic_staff(uuid, uuid) from public, anon, authenticated;

-- "Outside configured reference range" from a value and its snapshotted bounds.
create or replace function public.lab_flag_for(p_value numeric, p_low numeric, p_high numeric, p_critical_low numeric, p_critical_high numeric)
returns public.lab_flag
language sql
immutable
set search_path = pg_catalog
as $$
  select case
    when p_value is null then 'unclassified'::public.lab_flag
    when p_critical_low is not null and p_value < p_critical_low then 'critical_low'::public.lab_flag
    when p_critical_high is not null and p_value > p_critical_high then 'critical_high'::public.lab_flag
    when p_low is not null and p_value < p_low then 'low'::public.lab_flag
    when p_high is not null and p_value > p_high then 'high'::public.lab_flag
    when p_low is null and p_high is null then 'unclassified'::public.lab_flag
    else 'normal'::public.lab_flag
  end;
$$;
revoke all on function public.lab_flag_for(numeric, numeric, numeric, numeric, numeric) from public, anon, authenticated;
-- Pure and side-effect free; the SECURITY INVOKER values trigger (below) calls it as the application role.
grant execute on function public.lab_flag_for(numeric, numeric, numeric, numeric, numeric) to service_role;

-- ---------------------------------------------------------------------------
-- 5. Catalog triggers: updated_at, rules, ids-only audit
-- ---------------------------------------------------------------------------

create trigger lab_categories_set_updated_at before update on public.lab_categories for each row execute function public.set_updated_at();
create trigger lab_tests_set_updated_at before update on public.lab_tests for each row execute function public.set_updated_at();
create trigger lab_test_parameters_set_updated_at before update on public.lab_test_parameters for each row execute function public.set_updated_at();
create trigger lab_reference_ranges_set_updated_at before update on public.lab_reference_ranges for each row execute function public.set_updated_at();
create trigger lab_panels_set_updated_at before update on public.lab_panels for each row execute function public.set_updated_at();

create or replace function public.lab_catalog_validate()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_type public.lab_data_type;
begin
  if tg_op = 'UPDATE' then
    if new.id is distinct from old.id or new.clinic_id is distinct from old.clinic_id or new.created_at is distinct from old.created_at then
      raise exception 'lab catalog: id, clinic and creation time cannot change';
    end if;
    -- (nested: PL/pgSQL plans a field reference when the statement runs, so each table's own field is only touched for that table)
    if tg_table_name = 'lab_test_parameters' then
      if new.test_id is distinct from old.test_id then
        raise exception 'lab catalog: a parameter cannot move to another test';
      end if;
    elsif tg_table_name = 'lab_reference_ranges' then
      if new.parameter_id is distinct from old.parameter_id then
        raise exception 'lab catalog: a reference range cannot move to another parameter';
      end if;
    end if;
  end if;
  -- Reference ranges are numeric bounds: only numeric parameters have them.
  if tg_table_name = 'lab_reference_ranges' then
    select p.data_type into v_type from public.lab_test_parameters p where p.id = new.parameter_id and p.clinic_id = new.clinic_id;
    if found and v_type <> 'numeric' then
      raise exception 'lab catalog: only a numeric parameter has a reference range';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function public.lab_catalog_validate() from public, anon, authenticated;

create trigger lab_categories_validate before insert or update on public.lab_categories for each row execute function public.lab_catalog_validate();
create trigger lab_tests_validate before insert or update on public.lab_tests for each row execute function public.lab_catalog_validate();
create trigger lab_test_parameters_validate before insert or update on public.lab_test_parameters for each row execute function public.lab_catalog_validate();
create trigger lab_reference_ranges_validate before insert or update on public.lab_reference_ranges for each row execute function public.lab_catalog_validate();
create trigger lab_panels_validate before insert or update on public.lab_panels for each row execute function public.lab_catalog_validate();

-- Catalog changes are audited as WHO changed WHICH row and WHICH columns — never the values (prices
-- and ranges are configuration, but the trail stays ids and column names only).
create or replace function public.lab_catalog_audit()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_changed text[];
  v_actor uuid;
begin
  v_actor := nullif(to_jsonb(new) ->> 'updated_by', '')::uuid;
  if tg_op = 'UPDATE' then
    select coalesce(array_agg(n.key order by n.key), '{}')
      into v_changed
      from jsonb_each(to_jsonb(new)) n
      join jsonb_each(to_jsonb(old)) o using (key)
     where n.value is distinct from o.value
       and n.key not in ('updated_at', 'updated_by');
    if cardinality(v_changed) = 0 then
      return null;
    end if;
  end if;
  insert into public.audit_events (clinic_id, actor_id, actor_type, action, entity_type, entity_id, new_values)
  values (
    new.clinic_id,
    v_actor,
    case when v_actor is null then 'system'::public.actor_type else 'staff'::public.actor_type end,
    case tg_op when 'INSERT' then 'lab_catalog_created' else 'lab_catalog_updated' end,
    tg_table_name,
    coalesce(to_jsonb(new) ->> 'id', ''),
    case tg_op when 'UPDATE' then jsonb_build_object('changed_columns', to_jsonb(v_changed)) else null end
  );
  return null;
end;
$$;
revoke all on function public.lab_catalog_audit() from public, anon, authenticated;

create trigger lab_categories_audit after insert or update on public.lab_categories for each row execute function public.lab_catalog_audit();
create trigger lab_tests_audit after insert or update on public.lab_tests for each row execute function public.lab_catalog_audit();
create trigger lab_test_parameters_audit after insert or update on public.lab_test_parameters for each row execute function public.lab_catalog_audit();
create trigger lab_reference_ranges_audit after insert or update on public.lab_reference_ranges for each row execute function public.lab_catalog_audit();
create trigger lab_panels_audit after insert or update on public.lab_panels for each row execute function public.lab_catalog_audit();

-- ---------------------------------------------------------------------------
-- 6. Orders
-- ---------------------------------------------------------------------------

create or replace function public.lab_orders_validate()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_doctor_profile uuid;
  v_doctor_active boolean;
  v_appointment_status public.appointment_status;
  v_referral record;
begin
  if tg_op = 'INSERT' then
    new.created_at := now();
    new.updated_at := now();
    if new.status is distinct from 'ordered' then
      raise exception 'lab order: an order is created as ordered';
    end if;
    new.cancelled_at := null; new.cancelled_by := null; new.cancel_reason := null; new.completed_at := null;

    select d.profile_id, d.active into v_doctor_profile, v_doctor_active
      from public.doctors d where d.id = new.ordering_doctor_id and d.clinic_id = new.clinic_id;
    if not found or not v_doctor_active then
      raise exception 'lab order: the ordering doctor must be an active doctor of the clinic';
    end if;
    if v_doctor_profile is null or new.created_by is distinct from v_doctor_profile then
      raise exception 'lab order: created_by must be the ordering doctor''s own doctor account';
    end if;
    if not exists (
      select 1 from public.staff_roles sr
       where sr.profile_id = v_doctor_profile and sr.clinic_id = new.clinic_id and sr.role = 'doctor'
    ) then
      raise exception 'lab order: the ordering doctor does not hold the doctor role';
    end if;

    -- The foreign key pins the consultation to this doctor and patient; it must be taking/have taken place.
    select a.status into v_appointment_status
      from public.appointments a
     where a.id = new.appointment_id and a.clinic_id = new.clinic_id
       and a.patient_id = new.patient_id and a.doctor_id = new.ordering_doctor_id;
    if found and v_appointment_status not in ('in_progress', 'completed') then
      raise exception 'lab order: the consultation must be in progress or completed (it is %)', v_appointment_status;
    end if;

    if new.referral_id is not null then
      select r.clinic_id, r.patient_id into v_referral from public.referrals r where r.id = new.referral_id;
      if not found or v_referral.clinic_id <> new.clinic_id or v_referral.patient_id <> new.patient_id then
        raise exception 'lab order: the referral is not this clinic''s referral of this patient';
      end if;
    end if;
    return new;
  end if;

  -- UPDATE: only the lifecycle moves; everything that identifies or describes the order is fixed.
  if new.id is distinct from old.id
     or new.clinic_id is distinct from old.clinic_id
     or new.patient_id is distinct from old.patient_id
     or new.ordering_doctor_id is distinct from old.ordering_doctor_id
     or new.appointment_id is distinct from old.appointment_id
     or new.referral_id is distinct from old.referral_id
     or new.priority is distinct from old.priority
     or new.notes is distinct from old.notes
     or new.creation_key is distinct from old.creation_key
     or new.created_by is distinct from old.created_by
     or new.created_at is distinct from old.created_at then
    raise exception 'lab order: an order cannot be edited, only moved through its status';
  end if;
  if new.status = old.status then
    if new.cancelled_at is distinct from old.cancelled_at or new.cancelled_by is distinct from old.cancelled_by
       or new.cancel_reason is distinct from old.cancel_reason or new.completed_at is distinct from old.completed_at then
      raise exception 'lab order: an order cannot be edited, only moved through its status';
    end if;
    return new;
  end if;
  if not ((old.status = 'ordered' and new.status in ('in_progress', 'cancelled'))
       or (old.status = 'in_progress' and new.status in ('completed', 'cancelled'))) then
    raise exception 'lab order: invalid status transition % -> %', old.status, new.status;
  end if;
  new.updated_at := now();
  if new.status = 'cancelled' then
    if new.cancelled_by is null or not public.lab_is_clinic_staff(new.cancelled_by, new.clinic_id) then
      raise exception 'lab order: only staff of the clinic can cancel an order';
    end if;
    if exists (
      select 1 from public.lab_results r
        join public.lab_result_versions v on v.result_id = r.id and v.status = 'verified'
       where r.order_id = new.id
    ) then
      raise exception 'lab order: an order with a verified result cannot be cancelled';
    end if;
    new.cancelled_at := now();
  elsif new.status = 'completed' then
    if not exists (select 1 from public.lab_order_items i where i.order_id = new.id and i.status = 'active') then
      raise exception 'lab order: an order without an active item cannot be completed';
    end if;
    if exists (
      select 1 from public.lab_order_items i
       where i.order_id = new.id and i.status = 'active'
         and not exists (
           select 1 from public.lab_results r join public.lab_result_versions v on v.result_id = r.id and v.status = 'verified'
            where r.order_item_id = i.id
         )
    ) then
      raise exception 'lab order: every active item needs a verified result before the order is completed';
    end if;
    new.completed_at := now();
  end if;
  return new;
end;
$$;
revoke all on function public.lab_orders_validate() from public, anon, authenticated;
create trigger lab_orders_validate before insert or update on public.lab_orders for each row execute function public.lab_orders_validate();

create or replace function public.lab_order_items_validate()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order_status public.lab_order_status;
  v_test record;
begin
  if tg_op = 'INSERT' then
    select o.status into v_order_status from public.lab_orders o where o.id = new.order_id and o.clinic_id = new.clinic_id;
    if found and v_order_status <> 'ordered' then
      raise exception 'lab order item: items are added while the order is still ordered (it is %)', v_order_status;
    end if;
    select t.code, t.name, t.sample_type, t.price, t.active into v_test
      from public.lab_tests t where t.id = new.test_id and t.clinic_id = new.clinic_id;
    if not found then
      raise exception 'lab order item: the test is not in this clinic''s catalog';
    end if;
    if not v_test.active then
      raise exception 'lab order item: the test is inactive and cannot be ordered';
    end if;
    -- Snapshots come from the catalog, never from the request.
    new.test_code := v_test.code;
    new.test_name := v_test.name;
    new.sample_type := v_test.sample_type;
    new.price_snapshot := v_test.price;
    new.status := 'active';
    new.cancelled_at := null;
    new.cancel_reason := null;
    new.created_at := now();
    return new;
  end if;

  if new.id is distinct from old.id or new.clinic_id is distinct from old.clinic_id or new.order_id is distinct from old.order_id
     or new.test_id is distinct from old.test_id or new.panel_id is distinct from old.panel_id
     or new.test_code is distinct from old.test_code or new.test_name is distinct from old.test_name
     or new.sample_type is distinct from old.sample_type or new.price_snapshot is distinct from old.price_snapshot
     or new.created_at is distinct from old.created_at then
    raise exception 'lab order item: only its cancellation can change';
  end if;
  if new.status = old.status then
    if new.cancelled_at is distinct from old.cancelled_at or new.cancel_reason is distinct from old.cancel_reason then
      raise exception 'lab order item: only its cancellation can change';
    end if;
    return new;
  end if;
  if not (old.status = 'active' and new.status = 'cancelled') then
    raise exception 'lab order item: invalid status transition % -> %', old.status, new.status;
  end if;
  select o.status into v_order_status from public.lab_orders o where o.id = new.order_id;
  if v_order_status in ('completed', 'cancelled') then
    raise exception 'lab order item: the order is already %', v_order_status;
  end if;
  if exists (
    select 1 from public.lab_results r join public.lab_result_versions v on v.result_id = r.id and v.status = 'verified'
     where r.order_item_id = new.id
  ) then
    raise exception 'lab order item: an item with a verified result cannot be cancelled';
  end if;
  new.cancelled_at := now();
  return new;
end;
$$;
revoke all on function public.lab_order_items_validate() from public, anon, authenticated;
create trigger lab_order_items_validate before insert or update on public.lab_order_items for each row execute function public.lab_order_items_validate();

-- ---------------------------------------------------------------------------
-- 7. Samples
-- ---------------------------------------------------------------------------

create or replace function public.lab_samples_validate()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order_status public.lab_order_status;
begin
  if tg_op = 'INSERT' then
    new.created_at := now();
    new.updated_at := now();
    select o.status into v_order_status from public.lab_orders o where o.id = new.order_id and o.clinic_id = new.clinic_id;
    if found and v_order_status not in ('ordered', 'in_progress') then
      raise exception 'lab sample: no sample for an order that is %', v_order_status;
    end if;
    if new.status is distinct from 'awaiting_collection' then
      raise exception 'lab sample: a sample is created awaiting collection';
    end if;
    if not public.lab_is_clinic_staff(new.created_by, new.clinic_id) then
      raise exception 'lab sample: created_by must be staff of the clinic';
    end if;
    new.collected_at := null; new.collected_by := null; new.rejected_reason := null;
    return new;
  end if;

  if new.id is distinct from old.id or new.clinic_id is distinct from old.clinic_id or new.order_id is distinct from old.order_id
     or new.patient_id is distinct from old.patient_id or new.sample_type is distinct from old.sample_type
     or new.sample_code is distinct from old.sample_code or new.created_by is distinct from old.created_by
     or new.created_at is distinct from old.created_at then
    raise exception 'lab sample: only its status, notes and collection details can change';
  end if;
  new.updated_at := now();
  if new.status = old.status then
    if new.collected_at is distinct from old.collected_at or new.collected_by is distinct from old.collected_by
       or new.rejected_reason is distinct from old.rejected_reason then
      raise exception 'lab sample: collection details change only with the status';
    end if;
    return new;
  end if;
  if not ((old.status = 'awaiting_collection' and new.status in ('collected', 'cancelled'))
       or (old.status = 'collected' and new.status in ('processing', 'rejected', 'cancelled'))
       or (old.status = 'processing' and new.status = 'rejected')) then
    raise exception 'lab sample: invalid status transition % -> %', old.status, new.status;
  end if;
  if new.status = 'collected' then
    if new.collected_by is null or not public.lab_is_clinic_staff(new.collected_by, new.clinic_id) then
      raise exception 'lab sample: collected_by must be staff of the clinic';
    end if;
    new.collected_at := now();
  elsif new.status in ('processing', 'cancelled') then
    new.collected_at := old.collected_at;
    new.collected_by := old.collected_by;
  elsif new.status = 'rejected' then
    new.collected_at := old.collected_at;
    new.collected_by := old.collected_by;
  end if;
  return new;
end;
$$;
revoke all on function public.lab_samples_validate() from public, anon, authenticated;
create trigger lab_samples_validate before insert or update on public.lab_samples for each row execute function public.lab_samples_validate();

create or replace function public.lab_sample_items_validate()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_sample_status public.lab_sample_status;
  v_item_status public.lab_item_status;
begin
  select s.status into v_sample_status from public.lab_samples s where s.id = new.sample_id and s.clinic_id = new.clinic_id;
  if found and v_sample_status <> 'awaiting_collection' then
    raise exception 'lab sample: tests are attached before collection (the sample is %)', v_sample_status;
  end if;
  select i.status into v_item_status from public.lab_order_items i where i.id = new.order_item_id and i.clinic_id = new.clinic_id;
  if found and v_item_status <> 'active' then
    raise exception 'lab sample: a cancelled test cannot be attached to a sample';
  end if;
  return new;
end;
$$;
revoke all on function public.lab_sample_items_validate() from public, anon, authenticated;
create trigger lab_sample_items_validate before insert on public.lab_sample_items for each row execute function public.lab_sample_items_validate();

-- A collected sample puts a fresh order in progress.
create or replace function public.lab_sample_progress()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.status = 'collected' and old.status is distinct from 'collected' then
    update public.lab_orders set status = 'in_progress' where id = new.order_id and status = 'ordered';
  end if;
  return null;
end;
$$;
revoke all on function public.lab_sample_progress() from public, anon, authenticated;
create trigger lab_sample_progress after update of status on public.lab_samples for each row execute function public.lab_sample_progress();

-- ---------------------------------------------------------------------------
-- 8. Results: header, versions, values
-- ---------------------------------------------------------------------------

create or replace function public.lab_results_validate()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order public.lab_order_status;
  v_item public.lab_item_status;
begin
  if tg_op = 'UPDATE' then
    -- Only the version triggers (a nested trigger) keep the header's status.
    if pg_trigger_depth() < 2 then
      raise exception 'lab result: the result status follows its versions and cannot be written directly';
    end if;
    if new.id is distinct from old.id or new.clinic_id is distinct from old.clinic_id or new.order_item_id is distinct from old.order_item_id
       or new.order_id is distinct from old.order_id or new.patient_id is distinct from old.patient_id then
      raise exception 'lab result: its order item and patient cannot change';
    end if;
    new.updated_at := now();
    return new;
  end if;
  new.created_at := now();
  new.updated_at := now();
  new.status := 'draft';
  select o.status into v_order from public.lab_orders o where o.id = new.order_id and o.clinic_id = new.clinic_id;
  if found and v_order not in ('ordered', 'in_progress') then
    raise exception 'lab result: no result for an order that is %', v_order;
  end if;
  select i.status into v_item from public.lab_order_items i where i.id = new.order_item_id and i.clinic_id = new.clinic_id;
  if found and v_item <> 'active' then
    raise exception 'lab result: no result for a cancelled test';
  end if;
  return new;
end;
$$;
revoke all on function public.lab_results_validate() from public, anon, authenticated;
create trigger lab_results_validate before insert or update on public.lab_results for each row execute function public.lab_results_validate();

create or replace function public.lab_result_versions_validate()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_result public.lab_results%rowtype;
  v_order public.lab_order_status;
  v_corrected record;
  v_has_values boolean;
begin
  if tg_op = 'INSERT' then
    -- Serialises the numbering of one result's versions.
    select * into v_result from public.lab_results r where r.id = new.result_id and r.clinic_id = new.clinic_id for update;
    if not found then
      return new; -- the foreign key reports it
    end if;
    select o.status into v_order from public.lab_orders o where o.id = v_result.order_id;
    if v_order = 'cancelled' then
      raise exception 'lab result: the order is cancelled';
    end if;
    if new.status is distinct from 'draft' then
      raise exception 'lab result: a version is created as a draft';
    end if;
    if not public.lab_is_clinic_staff(new.entered_by, new.clinic_id) then
      raise exception 'lab result: entered_by must be staff of the clinic';
    end if;
    new.version := coalesce((select max(v.version) from public.lab_result_versions v where v.result_id = new.result_id), 0) + 1;
    new.entered_at := now();
    new.created_at := now();
    new.updated_at := now();
    new.verified_by := null;
    new.verified_at := null;
    if new.version = 1 then
      new.corrects_version_id := null;
      new.correction_reason := null;
    else
      -- A correction replaces the CURRENT VERIFIED version, with a reason; nothing is overwritten.
      select v.id, v.result_id, v.status into v_corrected
        from public.lab_result_versions v where v.id = new.corrects_version_id and v.clinic_id = new.clinic_id;
      if not found or v_corrected.result_id <> new.result_id or v_corrected.status <> 'verified' then
        raise exception 'lab result: a correction must name the current verified version of the same result';
      end if;
    end if;
    return new;
  end if;

  if new.id is distinct from old.id or new.clinic_id is distinct from old.clinic_id or new.result_id is distinct from old.result_id
     or new.version is distinct from old.version or new.entered_by is distinct from old.entered_by
     or new.entered_at is distinct from old.entered_at or new.corrects_version_id is distinct from old.corrects_version_id
     or new.correction_reason is distinct from old.correction_reason or new.created_at is distinct from old.created_at then
    raise exception 'lab result: a version cannot be edited; add a correction instead';
  end if;
  if new.status = old.status then
    if new.verified_by is distinct from old.verified_by or new.verified_at is distinct from old.verified_at then
      raise exception 'lab result: a version cannot be edited; add a correction instead';
    end if;
    return new;
  end if;
  new.updated_at := now();
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
    if new.verified_by is null or not public.lab_is_clinic_staff(new.verified_by, new.clinic_id) then
      raise exception 'lab result: verified_by must be staff of the clinic';
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
  else
    raise exception 'lab result: invalid version transition % -> %', old.status, new.status;
  end if;
  return new;
end;
$$;
revoke all on function public.lab_result_versions_validate() from public, anon, authenticated;
create trigger lab_result_versions_validate before insert or update on public.lab_result_versions for each row execute function public.lab_result_versions_validate();

-- The header's status follows its latest version; a verified result completes its order when it was the last.
create or replace function public.lab_result_versions_sync()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_status public.lab_version_status;
  v_order uuid;
begin
  select v.status into v_status
    from public.lab_result_versions v where v.result_id = new.result_id order by v.version desc limit 1;
  update public.lab_results set status = case v_status
      when 'verified' then 'verified'::public.lab_result_status
      when 'pending_verification' then 'pending_verification'::public.lab_result_status
      else 'draft'::public.lab_result_status end
   where id = new.result_id;
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
revoke all on function public.lab_result_versions_sync() from public, anon, authenticated;
create trigger lab_result_versions_sync after insert or update of status on public.lab_result_versions for each row execute function public.lab_result_versions_sync();

-- SECURITY INVOKER on purpose: the "draft only" rule below depends on WHO deletes (current_user), and the
-- application role has the SELECT it needs on every table read here.
create or replace function public.lab_result_values_validate()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
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
    new.ref_low := v_range.low; new.ref_high := v_range.high;
    new.critical_low := v_range.critical_low; new.critical_high := v_range.critical_high;
  end if;
  new.flag := public.lab_flag_for(new.value_numeric, new.ref_low, new.ref_high, new.critical_low, new.critical_high);
  return new;
end;
$$;
revoke all on function public.lab_result_values_validate() from public, anon, authenticated;
create trigger lab_result_values_validate before insert or update or delete on public.lab_result_values for each row execute function public.lab_result_values_validate();

-- ---------------------------------------------------------------------------
-- 9. Ids-only audit for orders, items, samples, versions, attachments
-- ---------------------------------------------------------------------------

create or replace function public.lab_workflow_audit()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
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
        else 'lab_result_returned_to_draft' end;
      v_actor := case new.status when 'verified' then new.verified_by when 'pending_verification' then new.entered_by else null end;
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
$$;
revoke all on function public.lab_workflow_audit() from public, anon, authenticated;

create trigger lab_orders_audit after insert or update on public.lab_orders for each row execute function public.lab_workflow_audit();
create trigger lab_order_items_audit after insert or update on public.lab_order_items for each row execute function public.lab_workflow_audit();
create trigger lab_samples_audit after insert or update on public.lab_samples for each row execute function public.lab_workflow_audit();
create trigger lab_result_versions_audit after insert or update on public.lab_result_versions for each row execute function public.lab_workflow_audit();
create trigger lab_result_attachments_audit after insert on public.lab_result_attachments for each row execute function public.lab_workflow_audit();

-- ---------------------------------------------------------------------------
-- 10. RLS and grants
-- ---------------------------------------------------------------------------

alter table public.lab_categories enable row level security;
alter table public.lab_tests enable row level security;
alter table public.lab_test_parameters enable row level security;
alter table public.lab_reference_ranges enable row level security;
alter table public.lab_panels enable row level security;
alter table public.lab_panel_tests enable row level security;
alter table public.lab_orders enable row level security;
alter table public.lab_order_items enable row level security;
alter table public.lab_samples enable row level security;
alter table public.lab_sample_items enable row level security;
alter table public.lab_results enable row level security;
alter table public.lab_result_versions enable row level security;
alter table public.lab_result_values enable row level security;
alter table public.lab_result_attachments enable row level security;

revoke all on table
  public.lab_categories, public.lab_tests, public.lab_test_parameters, public.lab_reference_ranges,
  public.lab_panels, public.lab_panel_tests, public.lab_orders, public.lab_order_items, public.lab_samples,
  public.lab_sample_items, public.lab_results, public.lab_result_versions, public.lab_result_values,
  public.lab_result_attachments
  from public, anon, authenticated, service_role;

-- The catalog is configuration, not clinical text: clinic staff may read it (the role split is phase 3).
grant select on public.lab_categories, public.lab_tests, public.lab_test_parameters, public.lab_reference_ranges,
  public.lab_panels, public.lab_panel_tests to authenticated;
create policy "lab categories read for clinic staff" on public.lab_categories for select to authenticated using (public.is_clinic_staff(clinic_id));
create policy "lab tests read for clinic staff" on public.lab_tests for select to authenticated using (public.is_clinic_staff(clinic_id));
create policy "lab parameters read for clinic staff" on public.lab_test_parameters for select to authenticated using (public.is_clinic_staff(clinic_id));
create policy "lab reference ranges read for clinic staff" on public.lab_reference_ranges for select to authenticated using (public.is_clinic_staff(clinic_id));
create policy "lab panels read for clinic staff" on public.lab_panels for select to authenticated using (public.is_clinic_staff(clinic_id));
create policy "lab panel tests read for clinic staff" on public.lab_panel_tests for select to authenticated using (public.is_clinic_staff(clinic_id));

-- Order, sample and result tables: no signed-in grant, no policy. The server reads them after
-- doctor_patient_access() and audits every read.

-- service_role: the narrowest grants. Nothing is ever deleted (except draft values and panel membership).
grant select, insert, update on public.lab_categories, public.lab_tests, public.lab_test_parameters,
  public.lab_reference_ranges, public.lab_panels to service_role;
grant select, insert, delete on public.lab_panel_tests to service_role;

grant select, insert on public.lab_orders to service_role;
grant update (status, cancelled_at, cancelled_by, cancel_reason, completed_at, updated_at) on public.lab_orders to service_role;
grant select, insert on public.lab_order_items to service_role;
grant update (status, cancelled_at, cancel_reason) on public.lab_order_items to service_role;
grant select, insert on public.lab_samples to service_role;
grant update (status, collected_at, collected_by, rejected_reason, notes, updated_at) on public.lab_samples to service_role;
grant select, insert on public.lab_sample_items to service_role;
grant select, insert on public.lab_results to service_role;
grant select, insert on public.lab_result_versions to service_role;
grant update (status, verified_by, verified_at, updated_at) on public.lab_result_versions to service_role;
grant select, insert, update, delete on public.lab_result_values to service_role;
grant select, insert on public.lab_result_attachments to service_role;

comment on table public.lab_orders is
  'A doctor''s laboratory order, from their own consultation. Order status only; payment, sample, result and verification are separate. Server-read only (doctor_patient_access).';
comment on table public.lab_result_versions is
  'Append-only lineage of a result: a correction is a new version; verification is a property of a version. Never rewritten.';
comment on table public.lab_result_values is
  'Structured values with the reference range used (copied by the database). The flag means outside the configured range only — not a diagnosis.';

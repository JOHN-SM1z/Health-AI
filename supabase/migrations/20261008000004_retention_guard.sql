-- Retention (owner decision 2026-10-07, docs/decisions/2026-10-07-retention-tenancy-refunds.md §1):
-- clinical and laboratory history is kept indefinitely; terminating a clinic
-- keeps its data; there is no patient-deletion workflow.
--
-- The application never deletes clinics or patients, but the database would
-- have let it happen: deleting a clinic or a patient cascades to clinical
-- records, referrals, appointments, payments and conversations, and clinical
-- records and referrals had no delete guard of their own. From here the
-- database refuses:
--
--   * DELETE or TRUNCATE of clinics, patients, clinical_records, referrals.
--
-- Lab results, values and documents already refuse deletion unless the whole
-- clinic is being erased (20261005000003/04), visits are ON DELETE RESTRICT,
-- the kassa ledger and charges are append-only, and audit_events cannot be
-- changed by the service role. With clinics and patients undeletable, none of
-- the cascades can run.
--
-- The one exception is a TEST database: local development and CI seed a row
-- into internal.retention_override (supabase/seed.sql), so test suites can
-- still erase the clinics they create. No migration inserts that row, the
-- production setup file (supabase/full-db-setup.sql) does not contain the
-- seed, and no API role can read or write the internal schema. Staging and
-- production must keep it empty (runbook pre-flight).
--
-- This protects against the application, a leaked service key and accidental
-- SQL. The database owner can still disable triggers; that is outside what a
-- schema can enforce.

create schema if not exists internal;
revoke all on schema internal from public, anon, authenticated, service_role;
comment on schema internal is 'Server-internal settings. Not exposed through the API; no API role has access.';

create table internal.retention_override (
  only_row boolean primary key default true check (only_row),
  reason text not null check (char_length(btrim(reason)) between 10 and 500),
  created_at timestamptz not null default now()
);
revoke all on internal.retention_override from public, anon, authenticated, service_role;
comment on table internal.retention_override is 'Present ONLY in local development and CI test databases (supabase/seed.sql). Production and staging must never contain a row: with a row, clinics and patients become deletable.';

-- True only on a test database (see above).
create or replace function public.history_erasure_allowed()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (select 1 from internal.retention_override);
$$;

create or replace function public.retention_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if public.history_erasure_allowed() then
    if tg_level = 'ROW' then
      return old;
    end if;
    return null;
  end if;
  raise exception using
    message = format('retention: %s are kept indefinitely and are never deleted', tg_table_name),
    errcode = '42501',
    hint = 'retention',
    detail = case tg_table_name
      when 'clinics' then 'Deactivate the clinic (clinics.is_active = false); its history stays.'
      when 'patients' then 'Patients are never deleted; merge a duplicate card with merge_patients().'
      when 'clinical_records' then 'Clinical records are immutable; correct one with a new record.'
      else 'Referrals are kept; revoke, decline or complete one instead.'
    end;
end;
$$;

-- Fires before clinics_mark_erasure (triggers fire in name order).
create trigger clinics_a_retention_guard
  before delete on public.clinics
  for each row execute function public.retention_guard();
create trigger clinics_retention_truncate_guard
  before truncate on public.clinics
  for each statement execute function public.retention_guard();

create trigger patients_retention_guard
  before delete on public.patients
  for each row execute function public.retention_guard();
create trigger patients_retention_truncate_guard
  before truncate on public.patients
  for each statement execute function public.retention_guard();

create trigger clinical_records_retention_guard
  before delete on public.clinical_records
  for each row execute function public.retention_guard();
create trigger clinical_records_retention_truncate_guard
  before truncate on public.clinical_records
  for each statement execute function public.retention_guard();

create trigger referrals_retention_guard
  before delete on public.referrals
  for each row execute function public.retention_guard();
create trigger referrals_retention_truncate_guard
  before truncate on public.referrals
  for each statement execute function public.retention_guard();

revoke all on function public.history_erasure_allowed() from public, anon, authenticated, service_role;
revoke all on function public.retention_guard() from public, anon, authenticated, service_role;

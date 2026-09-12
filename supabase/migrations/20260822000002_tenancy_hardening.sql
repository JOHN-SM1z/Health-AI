-- 0028: Multi-tenancy hardening pass (audit findings, Phase 2).
--
-- Bundles four independent, additive fixes from the DB/RLS audit:
--   1. doctor_services cross-tenant consistency trigger
--   2. drop redundant duplicate RLS policies (dead since 0024)
--   3. missing index on staff_roles(profile_id) — hot path, every
--      authenticated request resolves its session through this table
--   4. UNIQUE constraint on clinic_telegram_integrations bot identity
--      columns, added defensively (skips + warns instead of failing the
--      migration if pre-existing duplicate data is ever found)
--
-- All four are safe for existing records: (1) only validates future
-- inserts/updates, never scans existing rows; (2) removes policies whose
-- access is already fully subsumed by 0024's combined policies (RLS
-- SELECT policies are OR-combined, so this changes zero effective access);
-- (3) a plain additive index; (4) explicitly guarded against failing on
-- existing duplicates. Reversible via a follow-up migration dropping the
-- trigger/function, indexes, and re-creating the two policies from
-- 20260813000010_rls.sql if ever needed.

-- ---------- 1. doctor_services: doctor and service must share a clinic ----------
--
-- doctor_services has no clinic_id of its own (junction table on
-- doctor_id/service_id); nothing at the database layer previously stopped
-- a row from pairing a Clinic A doctor with a Clinic B service — only one
-- application-layer check (src/app/api/admin/services/route.ts,
-- assertDoctorsInClinic) prevented it, and only on that one write path.

create or replace function public.doctor_services_check_same_clinic()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_doctor_clinic uuid;
  v_service_clinic uuid;
begin
  select clinic_id into v_doctor_clinic from public.doctors where id = new.doctor_id;
  select clinic_id into v_service_clinic from public.services where id = new.service_id;
  if v_doctor_clinic is null or v_service_clinic is null or v_doctor_clinic <> v_service_clinic then
    raise exception 'doctor_services: doctor and service must belong to the same clinic';
  end if;
  return new;
end;
$$;

drop trigger if exists doctor_services_check_same_clinic on public.doctor_services;
create trigger doctor_services_check_same_clinic
  before insert or update on public.doctor_services
  for each row execute function public.doctor_services_check_same_clinic();

comment on function public.doctor_services_check_same_clinic() is
  'Rejects any doctor_services row whose doctor_id and service_id resolve to different clinics — closes the one DB-layer gap in an otherwise clinic_id-scoped schema.';

-- ---------- 2. Drop redundant duplicate RLS policies (dead since 0024) ----------
--
-- 20260818000024_role_based_rls.sql widened the admin/owner SELECT
-- policies on patients and appointments to include manager/receptionist,
-- and re-implemented the "own doctor" clause inline as an OR — but never
-- dropped the original standalone policies below, leaving two policies
-- granting the identical doctor-scope permission. Dropping the dead one
-- changes zero effective access (RLS SELECT policies are OR-combined).

drop policy if exists "patients read for own doctor" on public.patients;
drop policy if exists "appointments read for own doctor" on public.appointments;

-- ---------- 3. Missing index: staff_roles(profile_id) ----------
--
-- getStaffContext() (src/lib/auth/staff.ts) — resolved on every
-- authenticated admin/doctor/platform request via requireStaff/
-- requireRoles/requirePlatformAdmin — filters staff_roles by profile_id
-- alone. The only existing index is the composite unique(clinic_id,
-- profile_id), whose leading column is clinic_id, so it cannot serve a
-- profile_id-only lookup efficiently.

create index if not exists staff_roles_profile_id_idx on public.staff_roles (profile_id);

-- ---------- 4. clinic_telegram_integrations bot-identity uniqueness ----------
--
-- resolveClinicByBotUsername() (src/lib/telegram/bots.ts), called on
-- every incoming Telegram webhook, does .eq("telegram_username",
-- normalized).maybeSingle() — which requires at most one matching row.
-- No constraint previously enforced that. If two clinics ever shared a
-- telegram_username/telegram_bot_id (e.g. an operator reusing a bot
-- token), PostgREST's singular-row requirement would be violated and
-- webhook routing would silently break for both affected clinics with no
-- visible dashboard error. Guarded with a duplicate check first so this
-- migration cannot fail outright on unexpected existing data — it skips
-- and logs a notice instead, leaving the constraint to be added once any
-- conflict is resolved.

do $$
declare
  v_dup_count int;
begin
  select count(*) into v_dup_count from (
    select telegram_username from public.clinic_telegram_integrations
    where telegram_username is not null
    group by telegram_username having count(*) > 1
  ) d;
  if v_dup_count > 0 then
    raise notice 'Skipping UNIQUE(telegram_username) on clinic_telegram_integrations: % duplicate value(s) exist — resolve manually, then add the constraint in a follow-up migration', v_dup_count;
  elsif not exists (select 1 from pg_indexes where indexname = 'clinic_telegram_integrations_username_key') then
    create unique index clinic_telegram_integrations_username_key
      on public.clinic_telegram_integrations (telegram_username)
      where telegram_username is not null;
  end if;
end $$;

do $$
declare
  v_dup_count int;
begin
  select count(*) into v_dup_count from (
    select telegram_bot_id from public.clinic_telegram_integrations
    where telegram_bot_id is not null
    group by telegram_bot_id having count(*) > 1
  ) d;
  if v_dup_count > 0 then
    raise notice 'Skipping UNIQUE(telegram_bot_id) on clinic_telegram_integrations: % duplicate value(s) exist — resolve manually, then add the constraint in a follow-up migration', v_dup_count;
  elsif not exists (select 1 from pg_indexes where indexname = 'clinic_telegram_integrations_bot_id_key') then
    create unique index clinic_telegram_integrations_bot_id_key
      on public.clinic_telegram_integrations (telegram_bot_id)
      where telegram_bot_id is not null;
  end if;
end $$;

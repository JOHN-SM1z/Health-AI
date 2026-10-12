-- Database audit 2026-10-12 (docs/PILOT_VALIDATION.md, Run 6): production,
-- staging and this repository had drifted apart. Production carried two
-- hand-applied migrations from 2026-08-22 (apply_final_db_fixes,
-- fix_multiclinic_and_audit_ip) that were never in the repository; staging
-- carried three hardening migrations (db_audit_*, 2026-10-09) that were in
-- neither. This migration brings all three to one schema. Every step is
-- idempotent: it is a no-op wherever the change is already in place.
--
-- 1. Audit actor and IP. Production's audit_track_changes() took the actor
--    and IP from the session settings app.current_user_id / app.current_ip,
--    which any SQL session can set — the recorded actor could be forged. The
--    application never sets them. The actor is the signed-in user
--    (auth.uid()) and the IP the request's, as the repository always had.
-- 2. Message deletion. Production had a DELETE policy on messages for
--    clinic owners and admins. It was inert (signed-in roles hold no DELETE
--    on messages), but conversation history is kept (owner decision
--    2026-10-07 §1), so the policy goes.
-- 3. Profile visibility. One form everywhere — production's, which states
--    "shares a clinic with the reader" directly rather than relying on the
--    staff_roles policy to hide other clinics' rows from a `limit 1`. Both
--    forms admit the same rows. auth.uid() is wrapped in a scalar subquery
--    so it is evaluated once per statement, not once per row (Supabase
--    advisor auth_rls_initplan), on every profiles / platform_admins policy.
-- 4. appointments_doctor_status_only() exempts managers as well as owners
--    and admins — production's form; every other management policy already
--    includes managers. is_platform_admin() and payments_block_direct_write()
--    are re-created from the repository text so the definitions match.
-- 5. Catalogue rows stay in their clinic (from staging): a manager of two
--    clinics could move a doctor or a service to the other clinic, taking its
--    appointments' references with it. clinic_id of doctors and services is
--    now immutable.
-- 6. A payment names its appointment's patient (from staging): the payment →
--    appointment key includes patient_id, so a payment can never name a
--    different patient than its appointment. The matching unique key keeps
--    the one-to-one shape PostgREST uses for appointments → payments embeds.
--
-- Not taken from staging: a service-role check inside the notification-claim
-- and webhook-claim functions. Their EXECUTE grants already admit only the
-- service role; staging is re-aligned to the repository bodies instead.

set local lock_timeout = '5s';

-- ---------- 1. audit actor and IP ----------
create or replace function public.audit_track_changes()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_clinic_id uuid := coalesce(new.clinic_id, old.clinic_id);
  v_actor uuid := auth.uid();
  v_action text;
begin
  if tg_op = 'UPDATE' then
    v_action := tg_table_name || '_updated';
  elsif tg_op = 'DELETE' then
    v_action := tg_table_name || '_deleted';
  else
    v_action := tg_table_name || '_created';
  end if;

  insert into public.audit_events (
    clinic_id, actor_id, actor_type, action, entity_type, entity_id,
    old_values, new_values, ip_address
  ) values (
    v_clinic_id,
    v_actor,
    case when v_actor is null then 'system'::public.actor_type else 'staff'::public.actor_type end,
    v_action,
    tg_table_name,
    coalesce(new.id::text, old.id::text),
    case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) else null end,
    case when tg_op in ('UPDATE', 'INSERT') then to_jsonb(new) else null end,
    nullif(current_setting('request.ip', true), '')
  );
  return null;
end;
$$;
revoke all on function public.audit_track_changes() from public, anon, authenticated;

-- ---------- 2. no message deletion ----------
drop policy if exists "Clinic admins can delete messages" on public.messages;

-- ---------- 3. profile and platform-admin policies ----------
drop policy if exists "profile read own" on public.profiles;
create policy "profile read own"
  on public.profiles for select
  to authenticated
  using (id = (select auth.uid()));

drop policy if exists "profile read for clinic staff" on public.profiles;
create policy "profile read for clinic staff"
  on public.profiles for select
  to authenticated
  using (exists (
    select 1 from public.staff_roles reader
    where reader.profile_id = (select auth.uid())
      and reader.clinic_id in (select target.clinic_id from public.staff_roles target where target.profile_id = profiles.id)
  ));

drop policy if exists "profile insert own" on public.profiles;
create policy "profile insert own"
  on public.profiles for insert
  to authenticated
  with check (id = (select auth.uid()));

drop policy if exists "profile update own" on public.profiles;
create policy "profile update own"
  on public.profiles for update
  to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

drop policy if exists "platform_admins read own" on public.platform_admins;
create policy "platform_admins read own"
  on public.platform_admins for select
  to authenticated
  using (profile_id = (select auth.uid()));

-- ---------- 4. trigger and helper definitions ----------
create or replace function public.appointments_doctor_status_only()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  -- Server-side code (service role, no JWT) and owner/admin/manager sessions
  -- are unrestricted. coalesce() matters: without JWT claims auth.role() is
  -- NULL and `NULL <> 'authenticated'` is NULL (false), which would wrongly
  -- apply the doctor restriction to server-side calls.
  if coalesce(auth.role(), '') <> 'authenticated'
     or public.is_clinic_staff(new.clinic_id, array['owner'::public.staff_role, 'admin'::public.staff_role, 'manager'::public.staff_role]) then
    return new;
  end if;

  -- Doctor session: only the status column may change. Raise when any
  -- non-status column changes (status itself is allowed to change).
  -- updated_at is excluded because the set_updated_at trigger manages it.
  if new.clinic_id is distinct from old.clinic_id
     or new.patient_id is distinct from old.patient_id
     or new.doctor_id is distinct from old.doctor_id
     or new.service_id is distinct from old.service_id
     or new.start_at is distinct from old.start_at
     or new.end_at is distinct from old.end_at
     or new.source is distinct from old.source
     or new.notes is distinct from old.notes
     or new.cancelled_at is distinct from old.cancelled_at
     or new.cancelled_reason is distinct from old.cancelled_reason
     or new.cancelled_by is distinct from old.cancelled_by
     or new.no_show_reason is distinct from old.no_show_reason
     or new.created_by is distinct from old.created_by then
    raise exception 'Doctors may only update the status of their own appointments';
  end if;

  return new;
end;
$$;
revoke all on function public.appointments_doctor_status_only() from public, anon, authenticated;

create or replace function public.is_platform_admin()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (select 1 from public.platform_admins where profile_id = auth.uid());
$$;

create or replace function public.payments_block_direct_write()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  -- Server-side code (service role, no JWT) is unrestricted — the only
  -- legitimate path for a payment write (20260822000001).
  if coalesce(auth.role(), '') <> 'authenticated' then
    return new;
  end if;
  raise exception 'Payments are server-managed; use the payment API';
end;
$$;
revoke all on function public.payments_block_direct_write() from public, anon, authenticated;

-- ---------- 5. catalogue rows stay in their clinic ----------
create or replace function public.catalog_clinic_immutable()
returns trigger
language plpgsql
set search_path = pg_catalog
as $$
begin
  if new.clinic_id is distinct from old.clinic_id then
    raise exception 'catalog clinic identity is immutable' using errcode = '23514';
  end if;
  return new;
end;
$$;
revoke all on function public.catalog_clinic_immutable() from public, anon, authenticated;

drop trigger if exists catalog_clinic_immutable on public.doctors;
create trigger catalog_clinic_immutable
  before update of clinic_id on public.doctors
  for each row execute function public.catalog_clinic_immutable();
drop trigger if exists catalog_clinic_immutable on public.services;
create trigger catalog_clinic_immutable
  before update of clinic_id on public.services
  for each row execute function public.catalog_clinic_immutable();

-- ---------- 6. a payment names its appointment's patient ----------
do $$
declare
  v_def text;
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.appointments'::regclass and contype = 'u'
      and pg_get_constraintdef(oid) = 'UNIQUE (id, clinic_id, patient_id)'
  ) then
    alter table public.appointments add constraint appointments_payment_patient_key unique (id, clinic_id, patient_id);
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.payments'::regclass and contype = 'u'
      and pg_get_constraintdef(oid) = 'UNIQUE (appointment_id, clinic_id, patient_id)'
  ) then
    alter table public.payments add constraint payments_appointment_patient_key unique (appointment_id, clinic_id, patient_id);
  end if;

  select pg_get_constraintdef(oid) into v_def
  from pg_constraint
  where conrelid = 'public.payments'::regclass and conname = 'payments_appointment_id_fkey';
  if v_def is distinct from 'FOREIGN KEY (appointment_id, clinic_id, patient_id) REFERENCES appointments(id, clinic_id, patient_id) ON DELETE CASCADE' then
    alter table public.payments drop constraint if exists payments_appointment_id_fkey;
    alter table public.payments add constraint payments_appointment_id_fkey
      foreign key (appointment_id, clinic_id, patient_id)
      references public.appointments (id, clinic_id, patient_id) on delete cascade;
  end if;
end;
$$;

notify pgrst, 'reload schema';

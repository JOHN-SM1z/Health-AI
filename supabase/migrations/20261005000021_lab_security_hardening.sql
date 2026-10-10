-- Laboratory security review (Phase 17/19, docs/labs/SECURITY_REVIEW.md).
--
-- F1  TRUNCATE (and REFERENCES / TRIGGER) were granted to anon / authenticated
--     on several public tables by Supabase's default privileges — clinics,
--     staff_roles, doctors, profiles, services, app_settings, … TRUNCATE is
--     not subject to row level security: a session able to run SQL as
--     `authenticated` could empty a table for every clinic at once (e.g.
--     app_settings, resetting every clinic's lab settings to defaults —
--     releaseToPatient back to true). PostgREST cannot issue TRUNCATE, so it
--     was not reachable over HTTP, but the privilege must not exist. Revoked
--     on every table, and from the default privileges so new tables never get
--     it again. The same for MAINTAIN (PostgreSQL 17: LOCK TABLE, VACUUM, …).
--
-- F2  Server/RLS parity for money: the server shows payment amounts only to
--     the payment roles (owner, admin — canViewPaymentDynamics), but the
--     payments SELECT policies let managers, receptionists and doctors read
--     whole rows directly — amounts, provider references, payment links and
--     metadata of appointment AND lab payments. The browser only ever reads
--     payments(status). Signed-in roles now get the status columns only; every
--     amount is read through the server.

do $$
declare
  t record;
begin
  for t in
    select c.relname
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm', 'f')
  loop
    execute format('revoke truncate, references, trigger on public.%I from anon, authenticated', t.relname);
    -- PostgreSQL 17+: MAINTAIN (LOCK TABLE, VACUUM, REINDEX, …) likewise.
    if current_setting('server_version_num')::int >= 170000 then
      execute format('revoke maintain on public.%I from anon, authenticated', t.relname);
    end if;
  end loop;
  execute 'alter default privileges in schema public revoke truncate, references, trigger on tables from anon, authenticated';
  if current_setting('server_version_num')::int >= 170000 then
    execute 'alter default privileges in schema public revoke maintain on tables from anon, authenticated';
  end if;
end;
$$;

revoke select on public.payments from authenticated;
grant select (id, clinic_id, patient_id, appointment_id, lab_order_id, status) on public.payments to authenticated;

-- F4  Forged verification at the database level. The database required only
--     that the verifier is "a staff member of the clinic, not the enterer":
--     a server path (or anyone with the service role) could record a
--     receptionist, the owner or a doctor with no access to the patient as
--     the person who entered, submitted or verified a result. The server
--     (result.enter / result.verify + resolveLabResultAccess) never did, but
--     the rule now holds in the database too:
--       * whoever enters, submits or verifies a result is lab staff of the
--         clinic, or a doctor of the clinic whom doctor_patient_access()
--         admits to the patient;
--       * the verifier also matches the clinic's `verifiers` setting
--         (lab_and_doctor / lab_only / doctor_only).

create or replace function public.lab_result_handler_ok(p_clinic_id uuid, p_patient_id uuid, p_profile_id uuid, p_as text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with policy as (
    select coalesce((select s.value ->> 'verifiers' from public.app_settings s where s.clinic_id = p_clinic_id and s.key = 'lab'), 'lab_and_doctor') as verifiers
  )
  select
    (
      (p_as <> 'verifier' or (select verifiers from policy) <> 'doctor_only')
      and exists (select 1 from public.staff_roles sr where sr.clinic_id = p_clinic_id and sr.profile_id = p_profile_id and sr.role = 'lab')
    )
    or (
      (p_as <> 'verifier' or (select verifiers from policy) <> 'lab_only')
      and exists (
        select 1
        from public.staff_roles sr
        join public.doctors d on d.profile_id = sr.profile_id and d.clinic_id = sr.clinic_id and d.active
        cross join lateral public.doctor_patient_access(d.id, p_patient_id) x
        where sr.clinic_id = p_clinic_id and sr.profile_id = p_profile_id and sr.role = 'doctor'
          and x.clinic_id = p_clinic_id and (x.own_patient or cardinality(x.active_referral_ids) > 0)
      )
    );
$$;

revoke all on function public.lab_result_handler_ok(uuid, uuid, uuid, text) from public, anon, authenticated;

create or replace function public.lab_results_check_handlers()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'INSERT' then
    if not public.lab_result_handler_ok(new.clinic_id, new.patient_id, new.entered_by, 'enterer') then
      raise exception 'lab result: entered_by must be lab staff of the clinic or a doctor with access to the patient';
    end if;
    return new;
  end if;
  if new.status is distinct from old.status then
    if new.status = 'submitted' and not public.lab_result_handler_ok(new.clinic_id, new.patient_id, new.submitted_by, 'submitter') then
      raise exception 'lab result: submitted_by must be lab staff of the clinic or a doctor with access to the patient';
    end if;
    if new.status = 'verified' and not public.lab_result_handler_ok(new.clinic_id, new.patient_id, new.verified_by, 'verifier') then
      raise exception 'lab_result_verifier_not_allowed: the verifier may not verify this result (role, access or the clinic''s verifier setting)';
    end if;
  end if;
  return new;
end;
$$;

revoke all on function public.lab_results_check_handlers() from public, anon, authenticated;

drop trigger if exists lab_results_check_handlers on public.lab_results;
create trigger lab_results_check_handlers
  before insert or update of status on public.lab_results
  for each row execute function public.lab_results_check_handlers();

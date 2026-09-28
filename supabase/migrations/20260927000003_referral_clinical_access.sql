-- Referral-based clinical access: the authorization layer for doctors.
--
-- A doctor never gets a patient's clinical data merely by working in the
-- same clinic. public.doctor_patient_access() is the single definition of
-- what one doctor may see of one patient. The RLS policies below use it for
-- direct database/API access with the doctor's own token, and the server
-- (src/lib/clinical-access, through the service role) uses it before it
-- reads anything, so both layers make the same decision.
--
--   own       the doctor has an appointment with the patient (the rule the
--             existing policies already applied): the patient record and
--             the doctor's own appointments with the patient.
--   referred  an active referral to the doctor: status pending or accepted
--             AND expires_at still in the future (compared with now(), so
--             access ends on time even before the lazy expiry sweep marks
--             the row expired). Declined, revoked, completed and expired
--             referrals grant nothing.
--               pending  -> the patient record only (to decide on it),
--               accepted -> also the patient's appointments with the
--                           referring doctor (the handed-over history).
--   none      nothing - including every patient of another clinic.
--
-- Unchanged and deliberately so: payments stay limited to the doctor's own
-- appointments; conversations, messages and voice notes stay closed to
-- doctors; a doctor session may only change the status of its own
-- appointments (appointments_doctor_status_only); referrals are read-only
-- for every signed-in role. Staff who also hold an operational role
-- (owner/admin/manager/receptionist) keep that role's clinic-wide access.

-- ---------------------------------------------------------------------------
-- The decision
-- ---------------------------------------------------------------------------

-- One row when the doctor record belongs to an account holding the doctor
-- role and the patient is in the same clinic; no row otherwise (unknown ids,
-- another clinic, a doctor record nobody signs in as).
create or replace function public.doctor_patient_access(p_doctor_id uuid, p_patient_id uuid)
returns table (
  clinic_id uuid,
  own_patient boolean,
  active_referral_ids uuid[],
  history_doctor_ids uuid[]
)
language sql
stable
security definer
set search_path = public
as $$
  select
    d.clinic_id,
    exists (
      select 1
      from public.appointments a
      where a.clinic_id = d.clinic_id
        and a.patient_id = p.id
        and a.doctor_id = d.id
    ),
    array(
      select r.id
      from public.referrals r
      where r.clinic_id = d.clinic_id
        and r.patient_id = p.id
        and r.referred_to_doctor_id = d.id
        and r.status in ('pending', 'accepted')
        and r.expires_at > now()
      order by r.created_at
    ),
    array(
      select distinct r.referring_doctor_id
      from public.referrals r
      where r.clinic_id = d.clinic_id
        and r.patient_id = p.id
        and r.referred_to_doctor_id = d.id
        and r.status = 'accepted'
        and r.expires_at > now()
    )
  from public.doctors d
  join public.patients p
    on p.id = p_patient_id
   and p.clinic_id = d.clinic_id
  where d.id = p_doctor_id
    and exists (
      select 1
      from public.staff_roles sr
      where sr.profile_id = d.profile_id
        and sr.clinic_id = d.clinic_id
        and sr.role = 'doctor'
    );
$$;

comment on function public.doctor_patient_access(uuid, uuid) is
  'What a doctor may see of a patient: own relationship, active referrals (pending/accepted, unexpired) and the referring doctors whose visits are shared (accepted). No row = no access. Server-only: it answers for any doctor id.';

-- It answers for any doctor id, so only the server may call it directly.
revoke all on function public.doctor_patient_access(uuid, uuid) from public, anon, authenticated;
grant execute on function public.doctor_patient_access(uuid, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- The signed-in doctor (for RLS)
-- ---------------------------------------------------------------------------

-- The caller's doctor record in a clinic: linked to auth.uid() and backed by
-- the doctor role there. At most one (doctors_clinic_profile_key).
create or replace function public.current_doctor_id(p_clinic_id uuid)
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select d.id
  from public.doctors d
  join public.staff_roles sr
    on sr.profile_id = d.profile_id
   and sr.clinic_id = d.clinic_id
   and sr.role = 'doctor'
  where d.profile_id = auth.uid()
    and d.clinic_id = p_clinic_id
  limit 1;
$$;

-- Whether the caller, as a doctor, may read this patient's record.
create or replace function public.doctor_can_read_patient(p_clinic_id uuid, p_patient_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.doctor_patient_access(public.current_doctor_id(p_clinic_id), p_patient_id) x
    where x.own_patient or cardinality(x.active_referral_ids) > 0
  );
$$;

-- Whether the caller, as a doctor, may read an appointment: their own, or
-- one of the patient's visits with a doctor who referred the patient to
-- them (accepted, unexpired referral).
create or replace function public.doctor_can_read_appointment(p_clinic_id uuid, p_patient_id uuid, p_doctor_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.doctor_patient_access(public.current_doctor_id(p_clinic_id), p_patient_id) x
    where p_doctor_id = public.current_doctor_id(p_clinic_id)
       or p_doctor_id = any (x.history_doctor_ids)
  );
$$;

-- These only ever answer about the caller, so RLS may call them for any
-- signed-in user; anonymous callers never reach them.
revoke all on function public.current_doctor_id(uuid) from public, anon;
revoke all on function public.doctor_can_read_patient(uuid, uuid) from public, anon;
revoke all on function public.doctor_can_read_appointment(uuid, uuid, uuid) from public, anon;
grant execute on function public.current_doctor_id(uuid) to authenticated, service_role;
grant execute on function public.doctor_can_read_patient(uuid, uuid) to authenticated, service_role;
grant execute on function public.doctor_can_read_appointment(uuid, uuid, uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- RLS: operational staff and doctors as separate policies
-- ---------------------------------------------------------------------------

drop policy if exists "patients read for operational staff" on public.patients;
create policy "patients read for operational staff" on public.patients
  for select to authenticated
  using (public.is_clinic_staff(clinic_id, array['owner', 'admin', 'manager', 'receptionist']::public.staff_role[]));
create policy "patients read for authorized doctors" on public.patients
  for select to authenticated
  using (public.doctor_can_read_patient(clinic_id, id));

drop policy if exists "appointments read for staff" on public.appointments;
create policy "appointments read for operational staff" on public.appointments
  for select to authenticated
  using (public.is_clinic_staff(clinic_id, array['owner', 'admin', 'manager', 'receptionist']::public.staff_role[]));
create policy "appointments read for authorized doctors" on public.appointments
  for select to authenticated
  using (public.doctor_can_read_appointment(clinic_id, patient_id, doctor_id));

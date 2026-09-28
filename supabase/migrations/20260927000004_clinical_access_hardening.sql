-- Clinical access hardening: closes the gaps found reviewing the doctor
-- authorization layer (20260927000003_referral_clinical_access.sql).
--
-- 1. Voice recordings: any staff member of a clinic — doctors included —
--    could download every patient's voice note straight from Supabase
--    Storage, although the voice_messages rows are operational-staff only.
--    The bucket's read policy now matches the table's.
-- 2. Doctors could still UPDATE their own appointments directly through the
--    REST API (any status: cancel, no-show, back to pending), bypassing the
--    server's forward-only checked_in -> in_progress -> completed rule. The
--    app only ever changes status through /api/doctor/appointments (service
--    role), so doctors lose direct write access to appointments entirely.
-- 3. A deactivated doctor record kept clinical access through RLS while the
--    API, the referral policies (is_linked_doctor) and the booking engine
--    all treat it as not practising. The decision now requires an active
--    doctor record, so every layer agrees.
-- 4. The server showed the receiving doctor the referral's originating
--    consultation and the referring doctor the follow-up appointment, which
--    RLS denied. The decision now names these referral-linked appointments
--    (referral_appointment_ids), and RLS and server both use it:
--      - the originating consultation of an active (pending/accepted,
--        unexpired) referral, for the doctor it is referred to;
--      - the follow-up appointment of a referral, for the referring doctor.
--    A completed, declined, revoked or expired referral no longer shows the
--    receiving doctor the consultation.

-- ---------------------------------------------------------------------------
-- 1. Voice recordings: operational roles only
-- ---------------------------------------------------------------------------

drop policy if exists "voice-messages staff read" on storage.objects;
create policy "voice-messages staff read"
  on storage.objects
  for select
  to authenticated
  using (
    bucket_id = 'voice-messages'
    and exists (
      select 1
      from public.staff_roles sr
      where sr.profile_id = auth.uid()
        and sr.clinic_id::text = (storage.foldername(name))[1]
        and sr.role = any (array['owner', 'admin', 'manager', 'receptionist']::public.staff_role[])
    )
  );

-- ---------------------------------------------------------------------------
-- 2. Doctors write appointments only through the server
-- ---------------------------------------------------------------------------

drop policy if exists "appointments status update for own doctor" on public.appointments;

-- ---------------------------------------------------------------------------
-- 3 + 4. The decision: active doctors, referral-linked appointments
-- ---------------------------------------------------------------------------

-- The appointments policy depends on the old doctor_can_read_appointment
-- signature, and doctor_patient_access gains a column: drop and recreate.
drop policy if exists "appointments read for authorized doctors" on public.appointments;
drop function if exists public.doctor_can_read_appointment(uuid, uuid, uuid);
drop function if exists public.doctor_patient_access(uuid, uuid);

create function public.doctor_patient_access(p_doctor_id uuid, p_patient_id uuid)
returns table (
  clinic_id uuid,
  own_patient boolean,
  active_referral_ids uuid[],
  history_doctor_ids uuid[],
  referral_appointment_ids uuid[]
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
    ),
    array(
      -- The consultation an active referral to this doctor was raised from…
      select r.originating_appointment_id
      from public.referrals r
      where r.clinic_id = d.clinic_id
        and r.patient_id = p.id
        and r.referred_to_doctor_id = d.id
        and r.status in ('pending', 'accepted')
        and r.expires_at > now()
      union
      -- …and the follow-up booked for a referral this doctor made.
      select r.follow_up_appointment_id
      from public.referrals r
      where r.clinic_id = d.clinic_id
        and r.patient_id = p.id
        and r.referring_doctor_id = d.id
        and r.follow_up_appointment_id is not null
    )
  from public.doctors d
  join public.patients p
    on p.id = p_patient_id
   and p.clinic_id = d.clinic_id
  where d.id = p_doctor_id
    and d.active
    and exists (
      select 1
      from public.staff_roles sr
      where sr.profile_id = d.profile_id
        and sr.clinic_id = d.clinic_id
        and sr.role = 'doctor'
    );
$$;

comment on function public.doctor_patient_access(uuid, uuid) is
  'What an active doctor may see of a patient: own relationship, active referrals (pending/accepted, unexpired), referring doctors whose visits are shared (accepted) and referral-linked appointments. No row = no access. Server-only: it answers for any doctor id.';

revoke all on function public.doctor_patient_access(uuid, uuid) from public, anon, authenticated;
grant execute on function public.doctor_patient_access(uuid, uuid) to service_role;

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
    and d.active
  limit 1;
$$;

-- Whether the caller, as a doctor, may read an appointment: their own, a
-- visit with a doctor who referred the patient to them (accepted,
-- unexpired), or an appointment a referral links them to.
create function public.doctor_can_read_appointment(
  p_clinic_id uuid,
  p_patient_id uuid,
  p_doctor_id uuid,
  p_appointment_id uuid
)
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
       or p_appointment_id = any (x.referral_appointment_ids)
  );
$$;

revoke all on function public.doctor_can_read_appointment(uuid, uuid, uuid, uuid) from public, anon;
grant execute on function public.doctor_can_read_appointment(uuid, uuid, uuid, uuid) to authenticated, service_role;

create policy "appointments read for authorized doctors" on public.appointments
  for select to authenticated
  using (public.doctor_can_read_appointment(clinic_id, patient_id, doctor_id, id));

-- Payments: a doctor still sees only the payments of their own appointments,
-- now through the same notion of "the signed-in, active doctor".
drop policy if exists "payments read for operational staff" on public.payments;
create policy "payments read for operational staff" on public.payments
  for select to authenticated
  using (public.is_clinic_staff(clinic_id, array['owner', 'admin', 'manager', 'receptionist']::public.staff_role[]));
create policy "payments read for own doctor" on public.payments
  for select to authenticated
  using (
    exists (
      select 1
      from public.appointments a
      where a.id = payments.appointment_id
        and a.clinic_id = payments.clinic_id
        and a.doctor_id = public.current_doctor_id(payments.clinic_id)
    )
  );

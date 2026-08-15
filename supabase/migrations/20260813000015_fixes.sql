-- 0015: Fixes from schema review.
--
-- 1. reschedule_appointment ignored doctor_services.duration_override_minutes
--    when computing the new end time (book_appointment honours it). Rescheduling
--    an appointment for a doctor with an overridden service duration produced
--    the wrong end_at. Fixed with the same coalesce as book_appointment.
--
-- 2. The "appointments status update for own doctor" RLS policy (0010) is a
--    full-row UPDATE policy: a doctor session could change start_at, end_at,
--    patient_id, service_id, etc. on their own appointments, bypassing the
--    booking engine's working-hours and time-block checks. A BEFORE UPDATE
--    trigger now rejects any non-status column change made by a doctor
--    session. Service-role (server-side) and owner/admin sessions are
--    unaffected.

-- ---------- 1. Reschedule honours per-doctor duration overrides ----------

create or replace function public.reschedule_appointment(
  p_appointment_id uuid,
  p_new_start_at timestamptz,
  p_actor uuid default null,
  out error_code text,
  out error_message text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_appt public.appointments%rowtype;
  v_clinic public.clinics%rowtype;
  v_duration_minutes int;
  v_new_end_at timestamptz;
begin
  select * into v_appt from public.appointments where id = p_appointment_id;
  if not found then
    error_code := 'appointment_not_found'; return;
  end if;

  if v_appt.status in ('cancelled', 'no_show', 'completed') then
    error_code := 'not_reschedulable'; return;
  end if;

  if p_new_start_at <= now() then
    error_code := 'past_slot'; return;
  end if;

  select * into v_clinic from public.clinics where id = v_appt.clinic_id;
  select coalesce(ds.duration_override_minutes, s.duration_minutes)
    into v_duration_minutes
    from public.services s
    left join public.doctor_services ds
      on ds.service_id = s.id and ds.doctor_id = v_appt.doctor_id
    where s.id = v_appt.service_id;

  v_new_end_at := p_new_start_at + make_interval(mins => v_duration_minutes);

  perform pg_advisory_xact_lock(hashtextextended(v_appt.doctor_id::text, 0));

  if not exists (
    select 1 from public.doctor_working_hours wh
    where wh.doctor_id = v_appt.doctor_id
      and wh.weekday = extract(isodow from p_new_start_at at time zone v_clinic.timezone)
      and wh.start_time <= (p_new_start_at at time zone v_clinic.timezone)::time
      and wh.end_time >= (v_new_end_at at time zone v_clinic.timezone)::time
  ) then
    error_code := 'outside_working_hours'; return;
  end if;

  if exists (
    select 1 from public.doctor_time_blocks tb
    where tb.doctor_id = v_appt.doctor_id
      and tstzrange(tb.starts_at, tb.ends_at, '[)') && tstzrange(p_new_start_at, v_new_end_at, '[)')
  ) then
    error_code := 'time_blocked'; return;
  end if;

  if exists (
    select 1 from public.appointments a
    where a.doctor_id = v_appt.doctor_id
      and a.id <> p_appointment_id
      and a.status not in ('cancelled', 'no_show')
      and tstzrange(a.start_at, a.end_at, '[)') && tstzrange(p_new_start_at, v_new_end_at, '[)')
  ) then
    error_code := 'slot_taken'; return;
  end if;

  begin
    update public.appointments
      set start_at = p_new_start_at,
          end_at = v_new_end_at,
          status = 'pending'::public.appointment_status
      where id = p_appointment_id;
    error_code := null;
    return;
  exception
    when exclusion_violation then
      error_code := 'slot_taken';
      error_message := 'Bu vaqt band qilingan';
      return;
    when unique_violation then
      error_code := 'slot_taken';
      error_message := 'Bu vaqt band qilingan';
      return;
  end;
end;
$$;

-- ---------- 2. Doctors may only change appointment status ----------

-- Runs before every UPDATE on appointments. Doctor sessions (authenticated
-- role, not owner/admin) may only change the status column; any other change
-- is rejected. Server-side (service role) and owner/admin sessions pass
-- through untouched.
create or replace function public.appointments_doctor_status_only()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Server-side code (service role) and owner/admin sessions are unrestricted.
  if auth.role() <> 'authenticated'
     or public.is_clinic_staff(new.clinic_id, array['owner'::public.staff_role, 'admin'::public.staff_role]) then
    return new;
  end if;

  -- Doctor session: only the status column may change.
  if new.status is distinct from old.status
     or new.clinic_id is distinct from old.clinic_id
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
     or new.created_by is distinct from old.created_by then
    raise exception 'Doctors may only update the status of their own appointments';
  end if;

  return new;
end;
$$;

drop trigger if exists appointments_doctor_status_only on public.appointments;
create trigger appointments_doctor_status_only
  before update on public.appointments
  for each row execute function public.appointments_doctor_status_only();

-- Audit remediation: no-show reasons + conversation read tracking.
-- 1) appointments.no_show_reason — staff record why a patient missed the
--    appointment; surfaced in management analytics like cancellation reasons.
alter table public.appointments
  add column no_show_reason text;

comment on column public.appointments.no_show_reason is
  'Reason recorded by staff when an appointment is marked as a no-show';

-- 2) conversations.admin_seen_at — last time an operator viewed the
--    conversation; patient messages after this timestamp are unread and
--    drive unread badges in the admin conversation center.
alter table public.conversations
  add column admin_seen_at timestamptz;

comment on column public.conversations.admin_seen_at is
  'Last time an operator viewed this conversation; patient messages after this are unread';

-- 3) Doctors may only update the status column of their own appointments.
--    no_show_reason is a staff-managed field, so it must NOT be settable by a
--    doctor session (their own route only ever touches status).
create or replace function public.appointments_doctor_status_only()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Server-side code (service role, no JWT) and owner/admin sessions are
  -- unrestricted. coalesce() matters: without JWT claims auth.role() is NULL
  -- and `NULL <> 'authenticated'` is NULL (false), which would wrongly apply
  -- the doctor restriction to server-side calls.
  if coalesce(auth.role(), '') <> 'authenticated'
     or public.is_clinic_staff(new.clinic_id, array['owner'::public.staff_role, 'admin'::public.staff_role]) then
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
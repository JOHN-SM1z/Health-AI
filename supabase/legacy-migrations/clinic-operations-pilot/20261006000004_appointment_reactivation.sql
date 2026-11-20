-- Revalidate reactivation, patient/service changes, and same-day duration.
create or replace function public.appointments_validate_slot()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_clinic_tz text;
  v_offers_service boolean;
begin
  -- cancelled/no_show rows never block availability; skip validation.
  if new.status in ('cancelled', 'no_show') then
    return new;
  end if;

  -- Updates that do not move the slot (status, notes, cancellation fields)
  -- do not need availability validation.
  if tg_op = 'UPDATE'
     and new.start_at is not distinct from old.start_at
     and new.end_at is not distinct from old.end_at
     and new.doctor_id is not distinct from old.doctor_id
     and new.service_id is not distinct from old.service_id
     and new.patient_id is not distinct from old.patient_id
     and new.clinic_id is not distinct from old.clinic_id
     and old.status not in ('cancelled','no_show') then
    return new;
  end if;

  select timezone into v_clinic_tz
  from public.clinics
  where id = new.clinic_id and is_active;
  if not found then
    raise exception 'appointment validation: clinic not found or inactive';
  end if;

  if not exists (
    select 1 from public.doctors d
    where d.id = new.doctor_id and d.clinic_id = new.clinic_id and d.active
  ) then
    raise exception 'appointment validation: doctor not found or inactive';
  end if;

  if not exists (
    select 1 from public.services s
    where s.id = new.service_id and s.clinic_id = new.clinic_id and s.active
  ) then
    raise exception 'appointment validation: service not found or inactive';
  end if;

  if not exists (
    select 1 from public.patients p
    where p.id = new.patient_id and p.clinic_id = new.clinic_id
  ) then
    raise exception 'appointment validation: patient not found';
  end if;

  -- Closed service-list rule: a doctor with explicit services must offer it.
  select exists (select 1 from public.doctor_services where doctor_id = new.doctor_id)
    into v_offers_service;
  if v_offers_service and not exists (
    select 1 from public.doctor_services
    where doctor_id = new.doctor_id and service_id = new.service_id
  ) then
    raise exception 'appointment validation: service not offered by doctor';
  end if;

  if (new.start_at at time zone v_clinic_tz)::date <> (new.end_at at time zone v_clinic_tz)::date then raise exception 'appointment validation: slot crosses clinic-local day'; end if;
  -- Whole slot must fall within one day's working hours (clinic timezone).
  if not exists (
    select 1 from public.doctor_working_hours wh
    where wh.doctor_id = new.doctor_id
      and wh.weekday = extract(isodow from new.start_at at time zone v_clinic_tz)
      and wh.start_time <= (new.start_at at time zone v_clinic_tz)::time
      and wh.end_time >= (new.end_at at time zone v_clinic_tz)::time
  ) then
    raise exception 'appointment validation: outside working hours';
  end if;

  -- No time-block overlap.
  if exists (
    select 1 from public.doctor_time_blocks tb
    where tb.doctor_id = new.doctor_id
      and tstzrange(tb.starts_at, tb.ends_at, '[)') && tstzrange(new.start_at, new.end_at, '[)')
  ) then
    raise exception 'appointment validation: slot is inside a time block';
  end if;

  -- No overlap with other active appointments (the new row is not yet in the
  -- table on INSERT, so self-exclusion is only needed on UPDATE).
  if exists (
    select 1 from public.appointments a
    where a.doctor_id = new.doctor_id
      and (tg_op = 'INSERT' or a.id <> new.id)
      and a.status not in ('cancelled', 'no_show')
      and tstzrange(a.start_at, a.end_at, '[)') && tstzrange(new.start_at, new.end_at, '[)')
  ) then
    raise exception 'appointment validation: slot overlaps another appointment';
  end if;

  return new;
end;
$$;

drop trigger if exists appointments_validate_slot on public.appointments;
create trigger appointments_validate_slot
  before insert or update on public.appointments
  for each row execute function public.appointments_validate_slot();

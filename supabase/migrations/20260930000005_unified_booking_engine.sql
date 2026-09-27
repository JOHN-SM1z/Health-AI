-- Unified booking engine: one authoritative booking operation, and a
-- database guarantee that a doctor can never hold two active appointments in
-- overlapping time.
--
-- The invariant — for any clinic, doctor and conflicting time interval, at
-- most ONE active appointment — is enforced by the exclusion constraint
-- no_overlapping_active_appointments, which Postgres checks on every INSERT
-- and UPDATE by every role, whatever code path wrote the row. Everything else
-- here serves it:
--
-- 1. Tenancy is structural. Composite foreign keys make an appointment's
--    doctor, patient and service belong to the appointment's own clinic, and
--    the constraint names the clinic explicitly (clinic_id, doctor_id, time):
--    a doctor row belongs to exactly one clinic, so the same time in another
--    clinic is never a conflict, and a row can never pair a clinic with
--    another clinic's doctor.
-- 2. Active = every status except 'cancelled' and 'no_show' (the product's
--    existing model, unchanged): cancelling or marking a no-show releases the
--    time; 'completed' keeps it (it happened).
-- 3. Appointments have variable durations (service duration or the doctor's
--    override), so conflicts are interval overlaps on [start_at, end_at):
--    14:00–14:30 and 14:15–14:45 conflict, 14:00–14:30 and 14:30–15:00 do not.
-- 4. book_appointment() is the one booking operation (Mini App, bot deep link,
--    website, reception, admin, the doctor's walk-in): it validates clinic,
--    doctor, service, patient, time, working hours and time blocks, serializes
--    per doctor with an advisory lock, re-checks inside the transaction and
--    inserts — a conflict found by the constraint instead (any race the lock
--    does not cover) comes back as 'slot_taken', never as a raw error.
-- 5. Idempotency: an optional key per booking attempt, unique per clinic. A
--    retried request (double click, network retry, reconnect) returns the
--    appointment the first attempt created (replayed = true) instead of a
--    second one; the same key for a different booking is refused.
-- 6. Working hours are compared as local date-times on the slot's own local
--    day: a slot running past midnight (23:50–00:10) used to pass a
--    time-of-day comparison. The clinic's IANA timezone (clinics.timezone)
--    is applied inside Postgres, so DST, where a timezone has it, is handled.
-- 7. reschedule_appointment() is clinic-scoped, locks the appointment row and
--    takes the same per-doctor lock; the appointment never conflicts with
--    itself.
-- 8. The slot-validation trigger (direct writes) raises the overlap as
--    exclusion_violation (23P01), like the constraint, so every path reports a
--    conflict the same way.
--
-- Rollback: restore book_appointment / reschedule_appointment /
-- appointments_validate_slot from 20260813000009 + 20260813000020 +
-- 20260912000001; drop slot_within_working_hours, booking_replay; drop
-- index appointments_clinic_idempotency_key_idx and column
-- appointments.idempotency_key; recreate the constraint on (doctor_id, range);
-- restore the single-column appointments_{doctor,patient,service}_id_fkey and
-- drop services_id_clinic_id_key.

-- ---------- 1. Same-clinic foreign keys ----------

alter table public.services add constraint services_id_clinic_id_key unique (id, clinic_id);

-- The single-column keys become composite ones under the same names (and
-- the same ON DELETE rules): one relationship per table, so the API's embeds
-- (doctors(name), appointments!appointments_patient_id_fkey …) are unchanged.
alter table public.appointments
  drop constraint appointments_doctor_id_fkey,
  drop constraint appointments_patient_id_fkey,
  drop constraint appointments_service_id_fkey,
  add constraint appointments_doctor_id_fkey
    foreign key (doctor_id, clinic_id) references public.doctors (id, clinic_id) on delete restrict,
  add constraint appointments_patient_id_fkey
    foreign key (patient_id, clinic_id) references public.patients (id, clinic_id) on delete cascade,
  add constraint appointments_service_id_fkey
    foreign key (service_id, clinic_id) references public.services (id, clinic_id) on delete restrict;

-- ---------- 2. The invariant, per clinic ----------

alter table public.appointments drop constraint no_overlapping_active_appointments;
alter table public.appointments add constraint no_overlapping_active_appointments
  exclude using gist (
    clinic_id with =,
    doctor_id with =,
    tstzrange(start_at, end_at, '[)') with &&
  ) where (status not in ('cancelled', 'no_show'));

comment on constraint no_overlapping_active_appointments on public.appointments is
  'At most one active (not cancelled / no-show) appointment per clinic, doctor and overlapping [start_at, end_at) — the booking invariant.';

-- ---------- 3. Idempotency ----------

alter table public.appointments
  add column idempotency_key text
    constraint appointments_idempotency_key_format
      check (idempotency_key is null or idempotency_key ~ '^[A-Za-z0-9_-]{16,128}$');

create unique index appointments_clinic_idempotency_key_idx
  on public.appointments (clinic_id, idempotency_key)
  where idempotency_key is not null;

comment on column public.appointments.idempotency_key is
  'Client-generated key of the booking attempt that created the appointment; a retry with the same key returns this appointment.';

-- ---------- 4. Working hours on the slot's own local day ----------

create or replace function public.slot_within_working_hours(
  p_doctor_id uuid,
  p_timezone text,
  p_start_at timestamptz,
  p_end_at timestamptz
)
returns boolean
language sql
stable
set search_path = public, pg_temp
as $$
  select exists (
    select 1
      from public.doctor_working_hours wh
     where wh.doctor_id = p_doctor_id
       and wh.weekday = extract(isodow from p_start_at at time zone p_timezone)
       and (p_start_at at time zone p_timezone) >= (p_start_at at time zone p_timezone)::date + wh.start_time
       and (p_end_at at time zone p_timezone) <= (p_start_at at time zone p_timezone)::date + wh.end_time
  );
$$;

comment on function public.slot_within_working_hours(uuid, text, timestamptz, timestamptz) is
  'True when [start, end) lies inside one of the doctor''s working-hour windows on the start''s local day (clinic timezone). A slot crossing local midnight is outside.';

-- ---------- 5. Replaying an idempotent booking ----------

create or replace function public.booking_replay(
  p_clinic_id uuid,
  p_idempotency_key text,
  p_patient_id uuid,
  p_doctor_id uuid,
  p_service_id uuid,
  p_start_at timestamptz
)
returns table (appointment_id uuid, amount numeric, error_code text)
language sql
stable
set search_path = public, pg_temp
as $$
  select a.id,
         (select p.amount from public.payments p where p.appointment_id = a.id order by p.created_at limit 1),
         case
           when a.patient_id = p_patient_id and a.doctor_id = p_doctor_id
                and a.service_id = p_service_id and a.start_at = p_start_at then null
           else 'idempotency_key_reused'
         end
    from public.appointments a
   where a.clinic_id = p_clinic_id
     and a.idempotency_key = p_idempotency_key;
$$;

-- ---------- 6. The booking operation ----------

drop function public.book_appointment(
  uuid, uuid, uuid, uuid, timestamptz, public.appointment_status, public.appointment_source, text, uuid
);

create function public.book_appointment(
  p_clinic_id uuid,
  p_patient_id uuid,
  p_doctor_id uuid,
  p_service_id uuid,
  p_start_at timestamptz,
  p_status public.appointment_status default 'pending',
  p_source public.appointment_source default 'telegram_mini_app',
  p_notes text default null,
  p_created_by uuid default null,
  p_idempotency_key text default null,
  out appointment_id uuid,
  out amount numeric,
  out error_code text,
  out error_message text,
  out replayed boolean
)
returns record
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_clinic public.clinics%rowtype;
  v_service public.services%rowtype;
  v_duration_minutes int;
  v_price numeric;
  v_end_at timestamptz;
  v_offers_service boolean;
  v_replay record;
  v_constraint text;
begin
  replayed := false;

  -- A booking starts a visit; closing statuses are never booked.
  if p_status not in ('pending', 'confirmed', 'checked_in', 'in_progress') then
    error_code := 'invalid_status'; return;
  end if;

  select * into v_clinic from public.clinics where id = p_clinic_id and is_active;
  if not found then
    error_code := 'clinic_not_found'; return;
  end if;

  if not exists (select 1 from public.doctors where id = p_doctor_id and clinic_id = p_clinic_id and active) then
    error_code := 'doctor_not_found'; return;
  end if;

  select * into v_service from public.services where id = p_service_id and clinic_id = p_clinic_id and active;
  if not found then
    error_code := 'service_not_found'; return;
  end if;

  if not exists (select 1 from public.patients where id = p_patient_id and clinic_id = p_clinic_id) then
    error_code := 'patient_not_found'; return;
  end if;

  -- A doctor with an explicit service list performs only those services.
  select exists (select 1 from public.doctor_services where doctor_id = p_doctor_id) into v_offers_service;
  if v_offers_service and not exists (
    select 1 from public.doctor_services where doctor_id = p_doctor_id and service_id = p_service_id
  ) then
    error_code := 'service_not_offered'; return;
  end if;

  -- A retried request returns the first attempt's appointment.
  if p_idempotency_key is not null then
    select * into v_replay
      from public.booking_replay(p_clinic_id, p_idempotency_key, p_patient_id, p_doctor_id, p_service_id, p_start_at);
    if found then
      appointment_id := case when v_replay.error_code is null then v_replay.appointment_id end;
      amount := case when v_replay.error_code is null then v_replay.amount end;
      error_code := v_replay.error_code;
      replayed := v_replay.error_code is null;
      return;
    end if;
  end if;

  -- Duration and price come from the service (or the doctor's override) —
  -- never from the caller.
  select coalesce(ds.duration_override_minutes, v_service.duration_minutes),
         coalesce(ds.price_override, v_service.price)
    into v_duration_minutes, v_price
    from public.services s
    left join public.doctor_services ds on ds.service_id = s.id and ds.doctor_id = p_doctor_id
   where s.id = p_service_id;

  if p_start_at <= now() then
    error_code := 'past_slot'; return;
  end if;
  v_end_at := p_start_at + make_interval(mins => v_duration_minutes);

  -- Serialize bookings and reschedules of this doctor (released at commit).
  perform pg_advisory_xact_lock(hashtextextended(p_clinic_id::text || ':' || p_doctor_id::text, 0));

  -- The same attempt may have committed while this one waited for the lock.
  if p_idempotency_key is not null then
    select * into v_replay
      from public.booking_replay(p_clinic_id, p_idempotency_key, p_patient_id, p_doctor_id, p_service_id, p_start_at);
    if found then
      appointment_id := case when v_replay.error_code is null then v_replay.appointment_id end;
      amount := case when v_replay.error_code is null then v_replay.amount end;
      error_code := v_replay.error_code;
      replayed := v_replay.error_code is null;
      return;
    end if;
  end if;

  if not public.slot_within_working_hours(p_doctor_id, v_clinic.timezone, p_start_at, v_end_at) then
    error_code := 'outside_working_hours'; return;
  end if;

  if exists (
    select 1 from public.doctor_time_blocks tb
     where tb.doctor_id = p_doctor_id
       and tstzrange(tb.starts_at, tb.ends_at, '[)') && tstzrange(p_start_at, v_end_at, '[)')
  ) then
    error_code := 'time_blocked'; return;
  end if;

  -- Re-check under the lock (belt) …
  if exists (
    select 1 from public.appointments a
     where a.clinic_id = p_clinic_id
       and a.doctor_id = p_doctor_id
       and a.status not in ('cancelled', 'no_show')
       and tstzrange(a.start_at, a.end_at, '[)') && tstzrange(p_start_at, v_end_at, '[)')
  ) then
    error_code := 'slot_taken'; error_message := 'Bu vaqt band qilingan'; return;
  end if;

  -- … and the exclusion constraint decides (braces).
  begin
    insert into public.appointments (
      clinic_id, patient_id, doctor_id, service_id,
      start_at, end_at, status, source, notes, created_by, idempotency_key
    ) values (
      p_clinic_id, p_patient_id, p_doctor_id, p_service_id,
      p_start_at, v_end_at, p_status, p_source, p_notes, p_created_by, p_idempotency_key
    )
    returning id into appointment_id;

    insert into public.payments (clinic_id, appointment_id, patient_id, amount, currency)
    values (p_clinic_id, appointment_id, p_patient_id, v_price, v_clinic.currency);

    amount := v_price;
    error_code := null;
    return;
  exception
    when exclusion_violation then
      appointment_id := null;
      error_code := 'slot_taken';
      error_message := 'Bu vaqt band qilingan';
      return;
    when unique_violation then
      get stacked diagnostics v_constraint = constraint_name;
      if v_constraint is distinct from 'appointments_clinic_idempotency_key_idx' then
        raise;
      end if;
      -- The same key was committed by a concurrent attempt for another doctor.
      select * into v_replay
        from public.booking_replay(p_clinic_id, p_idempotency_key, p_patient_id, p_doctor_id, p_service_id, p_start_at);
      appointment_id := case when v_replay.error_code is null then v_replay.appointment_id end;
      amount := case when v_replay.error_code is null then v_replay.amount end;
      error_code := v_replay.error_code;
      replayed := v_replay.error_code is null;
      return;
  end;
end;
$$;

comment on function public.book_appointment(uuid, uuid, uuid, uuid, timestamptz, public.appointment_status, public.appointment_source, text, uuid, text) is
  'The one booking operation for every channel. Server-only. Returns appointment_id, or error_code in (invalid_status, clinic_not_found, doctor_not_found, service_not_found, patient_not_found, service_not_offered, past_slot, outside_working_hours, time_blocked, slot_taken, idempotency_key_reused); replayed = true when an earlier attempt with the same idempotency key created it.';

-- ---------- 7. Rescheduling ----------

drop function public.reschedule_appointment(uuid, timestamptz, uuid);

create function public.reschedule_appointment(
  p_clinic_id uuid,
  p_appointment_id uuid,
  p_new_start_at timestamptz,
  p_actor uuid default null,
  out error_code text,
  out error_message text
)
returns record
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_appt public.appointments%rowtype;
  v_clinic public.clinics%rowtype;
  v_duration_minutes int;
  v_new_end_at timestamptz;
begin
  select * into v_appt from public.appointments where id = p_appointment_id and clinic_id = p_clinic_id;
  if not found then
    error_code := 'appointment_not_found'; return;
  end if;

  -- Same lock as book_appointment, then the row itself: a concurrent
  -- reschedule, cancellation or booking of this doctor waits.
  perform pg_advisory_xact_lock(hashtextextended(v_appt.clinic_id::text || ':' || v_appt.doctor_id::text, 0));
  select * into v_appt from public.appointments where id = p_appointment_id and clinic_id = p_clinic_id for update;

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
    left join public.doctor_services ds on ds.service_id = s.id and ds.doctor_id = v_appt.doctor_id
   where s.id = v_appt.service_id;
  v_new_end_at := p_new_start_at + make_interval(mins => v_duration_minutes);

  if not public.slot_within_working_hours(v_appt.doctor_id, v_clinic.timezone, p_new_start_at, v_new_end_at) then
    error_code := 'outside_working_hours'; return;
  end if;

  if exists (
    select 1 from public.doctor_time_blocks tb
     where tb.doctor_id = v_appt.doctor_id
       and tstzrange(tb.starts_at, tb.ends_at, '[)') && tstzrange(p_new_start_at, v_new_end_at, '[)')
  ) then
    error_code := 'time_blocked'; return;
  end if;

  -- The appointment never conflicts with itself.
  if exists (
    select 1 from public.appointments a
     where a.clinic_id = v_appt.clinic_id
       and a.doctor_id = v_appt.doctor_id
       and a.id <> p_appointment_id
       and a.status not in ('cancelled', 'no_show')
       and tstzrange(a.start_at, a.end_at, '[)') && tstzrange(p_new_start_at, v_new_end_at, '[)')
  ) then
    error_code := 'slot_taken'; error_message := 'Bu vaqt band qilingan'; return;
  end if;

  begin
    -- The status is kept: moving a confirmed visit does not downgrade it.
    update public.appointments
       set start_at = p_new_start_at,
           end_at = v_new_end_at
     where id = p_appointment_id;
    error_code := null;
    return;
  exception
    when exclusion_violation then
      error_code := 'slot_taken';
      error_message := 'Bu vaqt band qilingan';
      return;
  end;
end;
$$;

-- ---------- 8. Direct writes report an overlap as the constraint does ----------

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
  -- do not need availability validation (the exclusion constraint still
  -- decides whether a reactivated appointment may hold its time).
  if tg_op = 'UPDATE'
     and new.start_at is not distinct from old.start_at
     and new.end_at is not distinct from old.end_at
     and new.doctor_id is not distinct from old.doctor_id then
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

  -- Whole slot within one working-hour window of its own local day.
  if not public.slot_within_working_hours(new.doctor_id, v_clinic_tz, new.start_at, new.end_at) then
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
  -- table on INSERT, so self-exclusion is only needed on UPDATE). Raised as
  -- exclusion_violation, exactly like the constraint.
  if exists (
    select 1 from public.appointments a
    where a.clinic_id = new.clinic_id
      and a.doctor_id = new.doctor_id
      and (tg_op = 'INSERT' or a.id <> new.id)
      and a.status not in ('cancelled', 'no_show')
      and tstzrange(a.start_at, a.end_at, '[)') && tstzrange(new.start_at, new.end_at, '[)')
  ) then
    raise exception using
      errcode = 'exclusion_violation',
      message = 'appointment validation: slot overlaps another appointment',
      constraint = 'no_overlapping_active_appointments';
  end if;

  return new;
end;
$$;

-- ---------- 9. Grants: server-only ----------

revoke all on function public.slot_within_working_hours(uuid, text, timestamptz, timestamptz) from public, anon, authenticated;
revoke all on function public.booking_replay(uuid, text, uuid, uuid, uuid, timestamptz) from public, anon, authenticated;
revoke all on function public.book_appointment(uuid, uuid, uuid, uuid, timestamptz, public.appointment_status, public.appointment_source, text, uuid, text) from public, anon, authenticated;
revoke all on function public.reschedule_appointment(uuid, uuid, timestamptz, uuid) from public, anon, authenticated;
grant execute on function public.slot_within_working_hours(uuid, text, timestamptz, timestamptz) to service_role;
grant execute on function public.booking_replay(uuid, text, uuid, uuid, uuid, timestamptz) to service_role;
grant execute on function public.book_appointment(uuid, uuid, uuid, uuid, timestamptz, public.appointment_status, public.appointment_source, text, uuid, text) to service_role;
grant execute on function public.reschedule_appointment(uuid, uuid, timestamptz, uuid) to service_role;

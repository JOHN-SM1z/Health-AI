-- Q-06 / audit 2026-11-14 P1-2: starting a walk-in consultation must not go
-- through the future-slot booking engine.
--
-- Before: start_visit_consultation -> start_walk_in_consultation ->
-- book_appointment(now() + 1 minute). A patient already waiting in the live
-- queue could be refused care because of working hours, a time block or an
-- overlapping booking, and the function then deleted the generated unpaid
-- payment row.
--
-- After: the walk-in encounter is an appointments row flagged
-- queue_encounter = true (clinical records, referrals and lab orders keep
-- referencing appointments as before). It is created directly, starting now,
-- with no working-hours, time-block or overlap check and no payment row (the
-- visit's own charges and kassa transactions carry the money). Overlap
-- protection between real bookings is unchanged: the exclusion constraint and
-- every belt check still apply to all rows that are not queue encounters.

alter table public.appointments
  add column if not exists queue_encounter boolean not null default false;

comment on column public.appointments.queue_encounter is
  'True only for the encounter row a doctor opens for a walk-in queue visit (open_queue_encounter). Not a reservation: ignored by overlap checks. Server-set only.';

-- Exclusion constraint: real bookings only.
alter table public.appointments drop constraint if exists no_overlapping_active_appointments;
alter table public.appointments
  add constraint no_overlapping_active_appointments
  exclude using gist (
    clinic_id with =,
    doctor_id with =,
    tstzrange(start_at, end_at, '[)') with &&
  ) where (status <> all (array['cancelled'::public.appointment_status, 'no_show'::public.appointment_status]) and not queue_encounter);

-- Belt checks in book_appointment, reschedule_appointment and the validation
-- trigger: ignore queue encounters. Patched in place so the bodies stay exactly
-- the deployed ones; each replacement is asserted.
do $$
declare
  f record;
  v_def text;
  v_new text;
begin
  for f in
    select p.oid, p.proname
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in ('book_appointment', 'reschedule_appointment', 'appointments_validate_slot')
  loop
    v_def := pg_get_functiondef(f.oid);
    v_new := replace(v_def,
      'a.status not in (''cancelled'', ''no_show'')',
      'a.status not in (''cancelled'', ''no_show'') and not a.queue_encounter');
    if v_new = v_def then
      raise exception 'walk-in encounter migration: overlap check not found in %', f.proname;
    end if;
    execute v_new;
  end loop;
end;
$$;

-- The validation trigger: a queue encounter skips slot rules (it is not a
-- slot) but keeps every tenant and entity check, and the flag can never be
-- set from an ordinary write or toggled later.
do $$
declare
  v_def text;
  v_new text;
begin
  v_def := pg_get_functiondef('public.appointments_validate_slot()'::regprocedure);
  v_new := replace(v_def,
    '  -- Whole slot within one working-hour window of its own local day.',
    '  if tg_op = ''UPDATE'' and new.queue_encounter is distinct from old.queue_encounter then
    raise exception using message = ''appointment validation: queue_encounter is fixed at creation'', errcode = ''42501'', hint = ''forbidden'';
  end if;
  if new.queue_encounter then
    if tg_op = ''INSERT'' and coalesce(current_setting(''health_ai.queue_encounter'', true), '''') <> ''on'' then
      raise exception using message = ''appointment validation: queue encounters are opened by open_queue_encounter only'', errcode = ''42501'', hint = ''forbidden'';
    end if;
    return new;
  end if;

  -- Whole slot within one working-hour window of its own local day.');
  if v_new = v_def then
    raise exception 'walk-in encounter migration: validation trigger anchor not found';
  end if;
  execute v_new;
end;
$$;

-- The queue encounter. start_walk_in_consultation (the doctor-workspace walk-in
-- without a desk visit, which still books through the engine and creates its
-- payment row) is left unchanged.
create or replace function public.open_queue_encounter(
  p_clinic_id uuid,
  p_patient_id uuid,
  p_doctor_id uuid,
  p_service_id uuid,
  p_actor uuid
)
returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_duration int;
  v_appointment uuid;
begin
  if not exists (
    select 1 from public.doctors d
     where d.id = p_doctor_id and d.clinic_id = p_clinic_id and d.profile_id = p_actor and d.active
  ) then
    raise exception 'consultation: a walk-in is started by the doctor themselves';
  end if;

  select coalesce(ds.duration_override_minutes, s.duration_minutes)
    into v_duration
    from public.services s
    left join public.doctor_services ds on ds.service_id = s.id and ds.doctor_id = p_doctor_id
   where s.id = p_service_id and s.clinic_id = p_clinic_id and s.active;
  if v_duration is null then
    return jsonb_build_object('appointment_id', null, 'error_code', 'service_not_found', 'referral_id', null);
  end if;

  perform set_config('health_ai.queue_encounter', 'on', true);
  insert into public.appointments (
    clinic_id, patient_id, doctor_id, service_id, start_at, end_at,
    status, source, created_by, queue_encounter
  ) values (
    p_clinic_id, p_patient_id, p_doctor_id, p_service_id, now(), now() + make_interval(mins => greatest(v_duration, 1)),
    'in_progress', 'walk_in', p_actor, true
  )
  returning id into v_appointment;
  perform set_config('health_ai.queue_encounter', '', true);

  return jsonb_build_object(
    'appointment_id', v_appointment,
    'error_code', null,
    'referral_id', public.consultation_started_effects(v_appointment, p_actor, 'doctor_workspace', true, true)
  );
end;
$$;

revoke execute on function public.open_queue_encounter(uuid, uuid, uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.open_queue_encounter(uuid, uuid, uuid, uuid, uuid) to service_role;
comment on function public.open_queue_encounter(uuid, uuid, uuid, uuid, uuid) is
  'Opens the encounter row for a walk-in queue visit, starting now. Not a reservation: no working-hours, time-block or overlap check and no payment row. Called by start_visit_consultation.';

-- start_visit_consultation: opens a queue encounter instead of a future slot, and no payment delete (the
-- encounter creates no payment row).
do $$
declare
  v_def text;
  v_new text;
begin
  v_def := pg_get_functiondef('public.start_visit_consultation(uuid, uuid, uuid, text)'::regprocedure);
  v_new := replace(v_def,
    'public.start_walk_in_consultation(
      p_clinic, v.patient_id, v.doctor_id, v_service, date_trunc(''minute'', now()) + interval ''1 minute'', p_actor
    )',
    'public.open_queue_encounter(p_clinic, v.patient_id, v.doctor_id, v_service, p_actor)');
  v_new := replace(v_new, '    delete from public.payments where appointment_id = v_appointment and status = ''unpaid'';
', '');
  if v_new = v_def or position('start_walk_in_consultation' in v_new) > 0 or position('delete from public.payments' in v_new) > 0 then
    raise exception 'walk-in encounter migration: start_visit_consultation did not match the expected definition';
  end if;
  execute v_new;
end;
$$;

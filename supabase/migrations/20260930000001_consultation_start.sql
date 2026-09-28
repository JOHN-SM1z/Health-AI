-- Starting a consultation is one database transaction.
--
-- Until now the server moved the appointment to in progress, then linked a
-- waiting referral, then wrote the 'consultation_started' audit row — three
-- requests. A failure between them left a started consultation with no audit
-- row (or no referral link), and two concurrent starts could both write one.
-- These functions do all three in one transaction, with a compare-and-swap
-- on the appointment's status:
--
--   start_consultation(...)          an existing appointment → in progress
--   start_walk_in_consultation(...)  a walk-in booked in progress through the
--                                    booking engine (book_appointment)
--
-- Both write 'consultation_started' (ids only — never clinical text) with the
-- acting staff member, and optionally link the consultation to the accepted
-- referral waiting for it (the referral then moves to in progress through
-- referrals_validate(), exactly as before). A link the referral trigger
-- refuses never blocks the consultation: the referral simply stays accepted.
--
-- Server-only: EXECUTE for service_role alone. The server has already
-- authorized the caller (the doctor's own appointment and access to the
-- patient, or operational staff of the clinic); the functions re-check the
-- tenant, the actor's staff role in the clinic and, when given, the doctor.
--
-- Rollback: drop function public.start_walk_in_consultation(uuid, uuid, uuid,
-- uuid, timestamptz, uuid); drop function public.start_consultation(uuid,
-- uuid, public.appointment_status, uuid, text, boolean, uuid); drop function
-- public.consultation_started_effects(uuid, uuid, text, boolean, boolean).

create or replace function public.consultation_started_effects(
  p_appointment_id uuid,
  p_actor uuid,
  p_via text,
  p_link_referral boolean,
  p_walk_in boolean
)
returns uuid
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_appointment public.appointments%rowtype;
  v_waiting uuid;
  v_referral uuid;
begin
  select * into v_appointment from public.appointments where id = p_appointment_id;
  if not found or v_appointment.status <> 'in_progress' then
    raise exception 'consultation: the appointment is not in progress';
  end if;

  -- The accepted referral to this doctor for this patient that is waiting for
  -- its consultation: none booked yet, or its booking was cancelled or has
  -- not started (same rule as referrals_validate()).
  if p_link_referral and not exists (
    select 1 from public.referrals r
     where r.follow_up_appointment_id = v_appointment.id
       and r.status in ('accepted', 'in_progress', 'completed')
  ) then
    select r.id into v_waiting
      from public.referrals r
      left join public.appointments f on f.id = r.follow_up_appointment_id
     where r.clinic_id = v_appointment.clinic_id
       and r.patient_id = v_appointment.patient_id
       and r.referred_to_doctor_id = v_appointment.doctor_id
       and r.status = 'accepted'
       and r.expires_at > now()
       and (r.follow_up_appointment_id is null
            or f.status in ('cancelled', 'no_show', 'pending', 'confirmed', 'checked_in'))
     order by r.created_at
     limit 1
     for update of r;
    if v_waiting is not null then
      begin
        update public.referrals set follow_up_appointment_id = v_appointment.id where id = v_waiting;
      exception when others then
        raise warning 'consultation not linked to referral (sqlstate %)', sqlstate;
      end;
    end if;
  end if;

  select r.id into v_referral
    from public.referrals r
   where r.clinic_id = v_appointment.clinic_id
     and r.follow_up_appointment_id = v_appointment.id
     and r.status in ('accepted', 'in_progress', 'completed')
   order by r.created_at desc
   limit 1;

  insert into public.audit_events (
    clinic_id, actor_id, actor_type, action, entity_type, entity_id,
    patient_id, referral_id, new_values, metadata
  ) values (
    v_appointment.clinic_id, p_actor, 'staff', 'consultation_started', 'appointments', v_appointment.id::text,
    v_appointment.patient_id, v_referral,
    jsonb_build_object('status', 'in_progress'),
    jsonb_build_object(
      'patient_id', v_appointment.patient_id,
      'doctor_id', v_appointment.doctor_id,
      'referral_id', v_referral,
      'via', p_via,
      'walk_in', p_walk_in
    )
  );
  return v_referral;
end;
$$;

create or replace function public.start_consultation(
  p_clinic_id uuid,
  p_appointment_id uuid,
  p_from_status public.appointment_status,
  p_actor uuid,
  p_via text,
  p_link_referral boolean default false,
  p_doctor_id uuid default null
)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  if p_via is null or p_via not in ('doctor_workspace', 'doctor_queue', 'front_desk') then
    raise exception 'consultation: unknown start channel %', p_via;
  end if;
  if not exists (select 1 from public.staff_roles where profile_id = p_actor and clinic_id = p_clinic_id) then
    raise exception 'consultation: the actor is not staff of this clinic';
  end if;
  if p_from_status = 'in_progress' then
    return jsonb_build_object('started', false, 'referral_id', null);
  end if;

  -- Compare-and-swap: only the status the caller saw moves, so of two
  -- concurrent starts exactly one starts (and audits) the consultation.
  update public.appointments
     set status = 'in_progress'
   where id = p_appointment_id
     and clinic_id = p_clinic_id
     and status = p_from_status
     and (p_doctor_id is null or doctor_id = p_doctor_id);
  if not found then
    return jsonb_build_object('started', false, 'referral_id', null);
  end if;

  return jsonb_build_object(
    'started', true,
    'referral_id', public.consultation_started_effects(p_appointment_id, p_actor, p_via, p_link_referral, false)
  );
end;
$$;

create or replace function public.start_walk_in_consultation(
  p_clinic_id uuid,
  p_patient_id uuid,
  p_doctor_id uuid,
  p_service_id uuid,
  p_start_at timestamptz,
  p_actor uuid
)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_booking record;
begin
  if not exists (
    select 1 from public.doctors d
     where d.id = p_doctor_id and d.clinic_id = p_clinic_id and d.profile_id = p_actor
  ) then
    raise exception 'consultation: a walk-in is started by the doctor themselves';
  end if;

  -- The booking engine checks working hours, time blocks, the doctor's
  -- services and overlaps, as for every other booking.
  select * into v_booking
    from public.book_appointment(
      p_clinic_id, p_patient_id, p_doctor_id, p_service_id, p_start_at,
      'in_progress'::public.appointment_status, 'walk_in'::public.appointment_source, null, p_actor
    );
  if v_booking.error_code is not null or v_booking.appointment_id is null then
    return jsonb_build_object(
      'appointment_id', null,
      'error_code', coalesce(v_booking.error_code, 'booking_failed'),
      'referral_id', null
    );
  end if;

  return jsonb_build_object(
    'appointment_id', v_booking.appointment_id,
    'error_code', null,
    'referral_id', public.consultation_started_effects(v_booking.appointment_id, p_actor, 'doctor_workspace', true, true)
  );
end;
$$;

revoke execute on function public.consultation_started_effects(uuid, uuid, text, boolean, boolean) from public, anon, authenticated;
revoke execute on function public.start_consultation(uuid, uuid, public.appointment_status, uuid, text, boolean, uuid) from public, anon, authenticated;
revoke execute on function public.start_walk_in_consultation(uuid, uuid, uuid, uuid, timestamptz, uuid) from public, anon, authenticated;
grant execute on function public.consultation_started_effects(uuid, uuid, text, boolean, boolean) to service_role;
grant execute on function public.start_consultation(uuid, uuid, public.appointment_status, uuid, text, boolean, uuid) to service_role;
grant execute on function public.start_walk_in_consultation(uuid, uuid, uuid, uuid, timestamptz, uuid) to service_role;

comment on function public.start_consultation(uuid, uuid, public.appointment_status, uuid, text, boolean, uuid) is
  'Server-only. Moves an appointment from p_from_status to in_progress (compare-and-swap), optionally links the waiting accepted referral, and audits consultation_started — one transaction.';
comment on function public.start_walk_in_consultation(uuid, uuid, uuid, uuid, timestamptz, uuid) is
  'Server-only. Books a walk-in in progress through book_appointment, links the waiting accepted referral, and audits consultation_started — one transaction.';

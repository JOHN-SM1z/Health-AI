-- Outpatient pilot fix (found by e2e/outpatient-journey.mjs): completing a
-- walk-in visit left its consultation appointment occupying the full booked
-- service duration, so the doctor could not start the next queued patient
-- ("slot taken") until that time had passed. The visit's appointment now ends
-- when the doctor completes it. Only transition_visit changes.

create or replace function public.transition_visit(
  p_clinic uuid,
  p_actor uuid,
  p_visit uuid,
  p_expected text,
  p_status text,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v public.visits;
  b record;
  v_desk boolean;
  v_own_doctor boolean;
begin
  perform public.ops_require_role(p_clinic, p_actor, array['owner', 'manager', 'admin', 'receptionist', 'doctor']::public.staff_role[]);
  select * into v from public.visits where id = p_visit and clinic_id = p_clinic for update;
  if not found then
    raise exception using message = 'operations: visit not found', errcode = '22023', hint = 'visit_not_found';
  end if;

  v_desk := public.ops_has_role(p_clinic, p_actor, array['owner', 'manager', 'admin', 'receptionist']::public.staff_role[]);
  v_own_doctor := exists (
    select 1 from public.doctors d where d.id = v.doctor_id and d.clinic_id = p_clinic and d.profile_id = p_actor and d.active
  ) and public.ops_has_role(p_clinic, p_actor, array['doctor']::public.staff_role[]);
  if not v_desk and not v_own_doctor then
    raise exception using message = 'operations: not your patient', errcode = '42501', hint = 'forbidden';
  end if;

  if v.status <> p_expected then
    raise exception using message = 'operations: the queue changed; refresh', errcode = '40001', hint = 'stale';
  end if;

  if p_status = 'called' and v.status = 'waiting' then
    update public.visits set status = 'called', called_at = now(), updated_at = now() where id = v.id returning * into v;
  elsif p_status = 'waiting' and v.status = 'called' then
    update public.visits set status = 'waiting', updated_at = now() where id = v.id returning * into v;
  elsif p_status = 'completed' and v.status = 'in_progress' and v_own_doctor then
    update public.visits set status = 'completed', completed_at = now(), updated_at = now() where id = v.id returning * into v;
    -- The consultation ends now, not when its booked duration would: a
    -- completed appointment still occupies its slot (no_overlapping_active_
    -- appointments), and a walk-in queue must let the doctor start the next
    -- patient at once. Never shorter than one minute (end > start).
    update public.appointments
       set status = 'completed', end_at = greatest(now(), start_at + interval '1 minute')
     where id = v.appointment_id and status = 'in_progress';
  elsif p_status = 'cancelled' and v.status in ('awaiting_payment', 'waiting', 'called') and v_desk then
    if p_reason is null or char_length(btrim(p_reason)) not between 3 and 500 then
      raise exception using message = 'operations: a reason is required', errcode = '22023', hint = 'reason_required';
    end if;
    select * into b from public.visit_balance(v.id);
    if b.collected - b.refunded > 0 then
      raise exception using message = 'operations: refund the payment before cancelling', errcode = '22023', hint = 'refund_first';
    end if;
    update public.visit_charges set status = 'voided', voided_by = p_actor, voided_at = now(), void_reason = 'Tashrif bekor qilindi'
     where visit_id = v.id and status = 'active';
    update public.visits set status = 'cancelled', cancelled_at = now(), cancel_reason = btrim(p_reason), updated_at = now()
     where id = v.id returning * into v;
  else
    raise exception using message = 'operations: this change is not allowed', errcode = '22023', hint = 'invalid_transition';
  end if;

  insert into public.audit_events (clinic_id, actor_id, actor_type, action, entity_type, entity_id, old_values, new_values)
  values (p_clinic, p_actor, 'staff', 'visit_status_changed', 'visits', v.id::text,
          jsonb_build_object('status', p_expected), jsonb_build_object('status', v.status));
  return jsonb_build_object('visit_id', v.id, 'status', v.status);
end;
$$;

-- "I've reviewed this": reception dismisses the warning of a visit booked for a
-- referral that was revoked or declined.
--
-- Referral controls workflow; the booking controls the treating relationship
-- (AGENTS.md): revoking or declining a referral never cancels or changes the
-- visit booked for it. Reception is warned (REFERRAL_REVOKED / REFERRAL_DECLINED,
-- derived by the server) and decides. Once they have looked at it and keep the
-- visit, the warning must go — without touching the booking:
--
--   * appointments.referral_warning_reviewed_at / _by record who reviewed it and
--     when. The warning is shown while the referral's revocation/decline is
--     NEWER than the review (so a visit later linked to another referral that is
--     then revoked warns again).
--   * public.review_referral_warning() is the one way to write them: atomic,
--     service role only, verifies the actor is staff of the clinic (owner, admin,
--     manager or receptionist), that the visit really is the follow-up of a
--     revoked/declined referral of the clinic and has not started, and audits it
--     ('referral_warning_reviewed': ids and the referral's status, no clinical
--     text). Nothing else about the appointment changes.
--
-- Reversible: drop function public.review_referral_warning(uuid, uuid, uuid);
-- alter table public.appointments drop column referral_warning_reviewed_at,
-- drop column referral_warning_reviewed_by.

alter table public.appointments
  add column referral_warning_reviewed_at timestamptz,
  add column referral_warning_reviewed_by uuid references public.profiles(id) on delete set null;

comment on column public.appointments.referral_warning_reviewed_at is
  'When reception reviewed the warning of a visit booked for a revoked/declined referral (the visit was kept). Written only by review_referral_warning().';
comment on column public.appointments.referral_warning_reviewed_by is
  'The staff profile that reviewed that warning.';

create or replace function public.review_referral_warning(
  p_clinic_id uuid,
  p_appointment_id uuid,
  p_actor uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_appointment public.appointments%rowtype;
  v_referral record;
begin
  if not exists (
    select 1 from public.staff_roles sr
     where sr.profile_id = p_actor
       and sr.clinic_id = p_clinic_id
       and sr.role in ('owner', 'admin', 'manager', 'receptionist')
  ) then
    raise exception 'review: the actor is not reception or management of this clinic';
  end if;

  -- The appointment first (the lock order everywhere: appointment, then referral).
  select * into v_appointment
    from public.appointments a
   where a.id = p_appointment_id and a.clinic_id = p_clinic_id
   for update;
  if not found then
    return jsonb_build_object('reviewed', false, 'error_code', 'appointment_not_found');
  end if;
  if v_appointment.status not in ('pending', 'confirmed', 'checked_in') then
    return jsonb_build_object('reviewed', false, 'error_code', 'nothing_to_review');
  end if;

  select r.id, r.status,
         case r.status when 'revoked' then r.revoked_at else r.declined_at end as ended_at
    into v_referral
    from public.referrals r
   where r.clinic_id = p_clinic_id
     and r.follow_up_appointment_id = p_appointment_id
     and r.status in ('revoked', 'declined');
  if not found then
    return jsonb_build_object('reviewed', false, 'error_code', 'nothing_to_review');
  end if;
  -- Already reviewed since the referral ended: nothing more to record.
  if v_appointment.referral_warning_reviewed_at is not null
     and v_appointment.referral_warning_reviewed_at >= v_referral.ended_at then
    return jsonb_build_object('reviewed', true, 'already', true);
  end if;

  update public.appointments
     set referral_warning_reviewed_at = now(),
         referral_warning_reviewed_by = p_actor
   where id = p_appointment_id;

  insert into public.audit_events (
    clinic_id, actor_id, actor_type, action, entity_type, entity_id, patient_id, referral_id, new_values
  ) values (
    p_clinic_id, p_actor, 'staff', 'referral_warning_reviewed', 'appointments', p_appointment_id::text,
    v_appointment.patient_id, v_referral.id,
    jsonb_build_object('referral_status', v_referral.status, 'appointment_status', v_appointment.status)
  );
  return jsonb_build_object('reviewed', true, 'already', false);
end;
$$;

comment on function public.review_referral_warning(uuid, uuid, uuid) is
  'Reception/management dismiss the REFERRAL_REVOKED / REFERRAL_DECLINED warning of a visit they keep: records who and when, audits it, changes nothing else. Server-only.';

revoke all on function public.review_referral_warning(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.review_referral_warning(uuid, uuid, uuid) to service_role;

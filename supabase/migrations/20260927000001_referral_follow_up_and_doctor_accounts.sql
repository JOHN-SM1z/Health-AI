-- Referral follow-up booking + doctor account hardening (referrals Phase 1,
-- API/UI step; builds on 20260926000001_referrals.sql).
--
-- 1. referrals.follow_up_appointment_id — the appointment reception books
--    with the receiving doctor once the referral is accepted. A composite
--    foreign key pins it to the referral's clinic, patient and RECEIVING
--    doctor (reusing appointments_id_clinic_id_patient_id_doctor_id_key).
--    referrals_validate() now also enforces: only while the referral is
--    accepted and unexpired; never on a cancelled/no-show appointment; once —
--    replaceable only after the linked appointment was cancelled or marked
--    no-show; never unlinked. referrals_audit() records the booking as
--    'referral_follow_up_booked', attributed to the staff member who created
--    the appointment (appointments.created_by).
--
-- 2. Doctor accounts (Phase 0 audit gap G3). Referral authority is keyed to
--    the account linked to a doctor record, so that link must be trustworthy:
--      * one doctor record per account per clinic (the admin API already
--        enforces this; the index makes it hold for every writer). Added
--        defensively: skipped with a notice if duplicates already exist;
--      * linking an account (doctors.profile_id) is server-side only. The
--        "doctors write for management" RLS policy has no column limit, so a
--        manager's browser session could link its own account to a doctor
--        record — bypassing assertDoctorProfileAvailable() in
--        src/app/api/admin/doctors/route.ts — and pass doctor-only routes.
--        Same pattern as patients_telegram_identity_server_only.
--
-- Reversible: drop column referrals.follow_up_appointment_id; restore
-- referrals_validate()/referrals_audit() from 20260926000001_referrals.sql;
-- drop trigger doctors_account_link_server_only, function
-- doctors_account_link_server_only() and index doctors_clinic_profile_key.

-- ---------- 1. Follow-up appointment ----------

alter table public.referrals
  add column follow_up_appointment_id uuid;

alter table public.referrals
  add constraint referrals_follow_up_appointment_fkey
  foreign key (follow_up_appointment_id, clinic_id, patient_id, referred_to_doctor_id)
  references public.appointments (id, clinic_id, patient_id, doctor_id);

create index referrals_follow_up_appointment_idx
  on public.referrals (follow_up_appointment_id)
  where follow_up_appointment_id is not null;

comment on column public.referrals.follow_up_appointment_id is
  'The appointment booked with the receiving doctor for this referral; set by reception once the referral is accepted.';

create or replace function public.referrals_validate()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_referring_found boolean;
  v_referring_active boolean;
  v_referring_profile uuid;
  v_referring_is_doctor boolean;
  v_target_found boolean;
  v_target_active boolean;
  v_target_profile uuid;
  v_target_is_doctor boolean;
  v_appointment_status public.appointment_status;
  v_mutable text[];
  v_actor uuid;
begin
  -- Doctor records are only looked up inside the referral's own clinic. A
  -- missing or cross-clinic record is left to the composite foreign keys to
  -- reject, rather than reported here with a misleading message.
  select d.active,
         d.profile_id,
         exists (
           select 1 from public.staff_roles sr
           where sr.profile_id = d.profile_id
             and sr.clinic_id = d.clinic_id
             and sr.role = 'doctor'::public.staff_role
         )
    into v_referring_active, v_referring_profile, v_referring_is_doctor
    from public.doctors d
   where d.id = new.referring_doctor_id
     and d.clinic_id = new.clinic_id;
  v_referring_found := found;

  select d.active,
         d.profile_id,
         exists (
           select 1 from public.staff_roles sr
           where sr.profile_id = d.profile_id
             and sr.clinic_id = d.clinic_id
             and sr.role = 'doctor'::public.staff_role
         )
    into v_target_active, v_target_profile, v_target_is_doctor
    from public.doctors d
   where d.id = new.referred_to_doctor_id
     and d.clinic_id = new.clinic_id;
  v_target_found := found;

  if tg_op = 'INSERT' then
    if new.status is distinct from 'pending'::public.referral_status then
      raise exception 'referral: a referral must be created as pending';
    end if;
    if new.follow_up_appointment_id is not null then
      raise exception 'referral: a follow-up can only be booked once the referral is accepted';
    end if;

    new.created_at := now();
    new.updated_at := now();

    if v_referring_found and new.created_by is not null then
      if not v_referring_active then
        raise exception 'referral: the referring doctor is inactive';
      end if;
      if new.created_by is distinct from v_referring_profile or not v_referring_is_doctor then
        raise exception 'referral: created_by must be the referring doctor''s own doctor account';
      end if;
    end if;

    -- Same doctor record on both sides is left to referrals_not_self_referral.
    if v_target_found and new.referred_to_doctor_id <> new.referring_doctor_id then
      if not v_target_active then
        raise exception 'referral: the receiving doctor is inactive';
      end if;
      if v_target_profile is null or not v_target_is_doctor then
        raise exception 'referral: the receiving doctor has no linked doctor account';
      end if;
      if v_target_profile = v_referring_profile then
        raise exception 'referral: self-referral (both doctor records belong to the same account)';
      end if;
    end if;

    select a.status
      into v_appointment_status
      from public.appointments a
     where a.id = new.originating_appointment_id
       and a.clinic_id = new.clinic_id
       and a.patient_id = new.patient_id
       and a.doctor_id = new.referring_doctor_id;
    if found and v_appointment_status not in ('in_progress', 'completed') then
      raise exception 'referral: the originating consultation must be in progress or completed (it is %)', v_appointment_status;
    end if;

    return new;
  end if;

  -- UPDATE: status transitions, plus booking the follow-up while accepted.
  if new.status = old.status then
    if new.follow_up_appointment_id is distinct from old.follow_up_appointment_id
       and old.status <> 'accepted' then
      raise exception 'referral: a follow-up can only be booked once the referral is accepted';
    end if;
    v_mutable := array['follow_up_appointment_id', 'updated_at'];
  elsif (old.status = 'pending' and new.status in ('accepted', 'declined', 'revoked', 'expired'))
     or (old.status = 'accepted' and new.status in ('completed', 'revoked', 'expired')) then
    v_mutable := case new.status
      when 'accepted' then array['status', 'accepted_at', 'accepted_by', 'updated_at']
      when 'declined' then array['status', 'declined_at', 'declined_by', 'declined_reason', 'updated_at']
      when 'completed' then array['status', 'completed_at', 'completed_by', 'updated_at']
      when 'revoked' then array['status', 'revoked_at', 'revoked_by', 'revoked_reason', 'updated_at']
      else array['status', 'updated_at']
    end;
  else
    raise exception 'referral: invalid status transition % -> %', old.status, new.status;
  end if;

  if (to_jsonb(new) - v_mutable) is distinct from (to_jsonb(old) - v_mutable) then
    if new.status = old.status then
      raise exception 'referral: a referral cannot be edited, only moved through its status transitions';
    end if;
    raise exception 'referral: the % transition may only set its own fields', new.status;
  end if;

  if new.status = old.status then
    if new.follow_up_appointment_id is distinct from old.follow_up_appointment_id then
      if new.follow_up_appointment_id is null then
        raise exception 'referral: a booked follow-up cannot be unlinked';
      end if;
      if old.expires_at <= now() then
        raise exception 'referral: the referral expired at %', old.expires_at;
      end if;
      if old.follow_up_appointment_id is not null and exists (
           select 1 from public.appointments a
           where a.id = old.follow_up_appointment_id
             and a.status not in ('cancelled', 'no_show')
         ) then
        raise exception 'referral: a follow-up appointment is already booked';
      end if;
      if exists (
           select 1 from public.appointments a
           where a.id = new.follow_up_appointment_id
             and a.status in ('cancelled', 'no_show')
         ) then
        raise exception 'referral: the follow-up appointment is cancelled';
      end if;
    end if;
    return new;
  end if;

  if new.status in ('accepted', 'completed') and old.expires_at <= now() then
    raise exception 'referral: the referral expired at %', old.expires_at;
  end if;
  if new.status = 'expired' and old.expires_at > now() then
    raise exception 'referral: the referral does not expire until %', old.expires_at;
  end if;

  if new.status in ('accepted', 'declined', 'completed') then
    v_actor := case new.status
      when 'accepted' then new.accepted_by
      when 'declined' then new.declined_by
      else new.completed_by
    end;
    if v_actor is null
       or v_actor is distinct from v_target_profile
       or not v_target_active
       or not v_target_is_doctor then
      raise exception 'referral: only the receiving doctor can mark the referral %', new.status;
    end if;
  elsif new.status = 'revoked' then
    if new.revoked_by is null or not (
         (new.revoked_by = v_referring_profile and v_referring_active and v_referring_is_doctor)
         or exists (
           select 1 from public.staff_roles sr
           where sr.profile_id = new.revoked_by
             and sr.clinic_id = new.clinic_id
             and sr.role in ('owner', 'admin', 'manager')
         )
       ) then
      raise exception 'referral: only the referring doctor or clinic management can revoke a referral';
    end if;
  end if;

  case new.status
    when 'accepted' then new.accepted_at := now();
    when 'declined' then new.declined_at := now();
    when 'completed' then new.completed_at := now();
    when 'revoked' then new.revoked_at := now();
    else null;
  end case;

  return new;
end;
$$;

create or replace function public.referrals_audit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_action text;
  v_actor uuid;
  v_old jsonb;
begin
  if tg_op = 'INSERT' then
    v_action := 'referral_created';
    v_actor := new.created_by;
  elsif new.status is distinct from old.status then
    v_action := 'referral_' || new.status::text;
    v_actor := case new.status
      when 'accepted' then new.accepted_by
      when 'declined' then new.declined_by
      when 'completed' then new.completed_by
      when 'revoked' then new.revoked_by
      else null
    end;
    v_old := jsonb_build_object('status', old.status);
  elsif new.follow_up_appointment_id is distinct from old.follow_up_appointment_id then
    v_action := 'referral_follow_up_booked';
    select a.created_by into v_actor
      from public.appointments a
     where a.id = new.follow_up_appointment_id;
    v_old := jsonb_build_object('follow_up_appointment_id', old.follow_up_appointment_id);
  else
    return null;
  end if;

  insert into public.audit_events (
    clinic_id, actor_id, actor_type, action, entity_type, entity_id,
    old_values, new_values, ip_address
  ) values (
    new.clinic_id,
    v_actor,
    case when v_actor is null then 'system'::public.actor_type else 'staff'::public.actor_type end,
    v_action,
    'referrals',
    new.id::text,
    v_old,
    jsonb_build_object(
      'status', new.status,
      'priority', new.priority,
      'patient_id', new.patient_id,
      'referring_doctor_id', new.referring_doctor_id,
      'referred_to_doctor_id', new.referred_to_doctor_id,
      'originating_appointment_id', new.originating_appointment_id,
      'follow_up_appointment_id', new.follow_up_appointment_id,
      'expires_at', new.expires_at
    ),
    nullif(current_setting('request.ip', true), '')
  );
  return null;
end;
$$;

-- ---------- 2. Doctor accounts ----------

do $$
declare
  v_dup_count int;
begin
  select count(*) into v_dup_count from (
    select 1 from public.doctors
    where profile_id is not null
    group by clinic_id, profile_id having count(*) > 1
  ) d;
  if v_dup_count > 0 then
    raise notice 'Skipping UNIQUE(clinic_id, profile_id) on doctors: % account(s) are linked to several doctor records — resolve manually, then add doctors_clinic_profile_key in a follow-up migration', v_dup_count;
  elsif not exists (select 1 from pg_indexes where indexname = 'doctors_clinic_profile_key') then
    create unique index doctors_clinic_profile_key
      on public.doctors (clinic_id, profile_id)
      where profile_id is not null;
  end if;
end $$;

create or replace function public.doctors_account_link_server_only()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Server-side code (service role, no JWT) links accounts after the admin
  -- API has checked the account is a doctor of this clinic; browser
  -- sessions may edit a doctor record but never who it belongs to.
  if coalesce(auth.role(), '') <> 'authenticated' then
    return new;
  end if;

  if (tg_op = 'INSERT' and new.profile_id is not null)
     or (tg_op = 'UPDATE' and new.profile_id is distinct from old.profile_id) then
    raise exception 'doctors: linking a doctor account is server-side only';
  end if;

  return new;
end;
$$;

drop trigger if exists doctors_account_link_server_only on public.doctors;
create trigger doctors_account_link_server_only
  before insert or update on public.doctors
  for each row execute function public.doctors_account_link_server_only();

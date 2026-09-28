-- Clinical handoff (2 of 2): the referral lifecycle
--
--   PENDING → ACCEPTED → IN_PROGRESS → COMPLETED   (PENDING → DECLINED;
--   REVOKED by the referring doctor or management and EXPIRED at expires_at
--   while open)
--
-- 1. referrals.started_at / started_by — when the receiving doctor's
--    consultation for the referral started, and whose account it was.
-- 2. referrals_validate():
--      * accepted → in_progress only once the referral's follow-up
--        consultation (follow_up_appointment_id, the receiving doctor's own
--        appointment by foreign key) is in progress or completed, and only
--        for the receiving doctor's account;
--      * completed only from in_progress — a referral is completed after the
--        receiving doctor saw the patient, not instead of it;
--      * linking a consultation that has already started makes the referral
--        in progress in the same statement;
--      * a consultation that took place may replace a booked follow-up that
--        has not started yet (the doctor saw the patient earlier).
-- 3. appointments_referral_follow_up_started: when a linked follow-up
--    appointment starts (in progress or completed), whoever moved it, the
--    accepted referral becomes in progress. It never blocks the visit itself.
-- 4. referrals_audit(): 'referral_in_progress' is attributed to started_by
--    (referral_accepted / _declined / _completed already are).
-- 5. The open states now include in_progress everywhere "open" is used: the
--    one-open-referral-per-pair index, the receiving doctor's read policy, and
--    public.doctor_patient_access() — an in-progress referral gives the
--    receiving doctor the same history as an accepted one, until it is
--    completed, revoked or expires.
--
-- Clinical records need no change beyond the new types (20260928000001): a
-- handoff consultation is documented in the existing clinical_records table,
-- authored by the receiving doctor by foreign key, and the referring
-- doctor's records stay theirs and immutable.
--
-- Reversible: restore referrals_validate()/referrals_audit() from
-- 20260927000001, doctor_patient_access() from 20260927000004, the policy and
-- index from 20260926000001; drop trigger appointments_referral_follow_up_started,
-- function referral_follow_up_started(), constraint referrals_started_state_check
-- and columns referrals.started_at/started_by (after moving in_progress rows
-- back to accepted).

-- ---------- 1. Columns ----------

alter table public.referrals
  add column started_at timestamptz,
  add column started_by uuid references public.profiles(id);

alter table public.referrals
  add constraint referrals_started_state_check
  check (
    (started_at is null) = (started_by is null)
    and (status <> 'in_progress' or started_at is not null)
    and (started_at is null or (accepted_at is not null and started_at >= accepted_at))
    and (started_at is null or completed_at is null or completed_at >= started_at)
  );

comment on column public.referrals.started_at is
  'When the receiving doctor''s consultation for this referral (follow_up_appointment_id) started; set with the in_progress transition.';

comment on column public.referrals.follow_up_appointment_id is
  'The receiving doctor''s consultation for this referral: booked by reception once accepted, or the consultation the receiving doctor started. Once it has started the referral is in progress.';

comment on column public.referrals.expires_at is
  'End of the referral''s validity (at most 365 days after creation). After it an open referral (pending, accepted, in progress) can no longer be accepted, started or completed, and the receiving doctor can no longer read it unless they completed it.';

-- ---------- 2. Status machine ----------

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
  v_old_follow_up_status public.appointment_status;
  v_new_follow_up_status public.appointment_status;
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

  -- UPDATE: status transitions, plus linking the follow-up while accepted.
  if new.status = old.status then
    if new.follow_up_appointment_id is distinct from old.follow_up_appointment_id
       and old.status <> 'accepted' then
      raise exception 'referral: a follow-up can only be booked once the referral is accepted';
    end if;
    v_mutable := array['follow_up_appointment_id', 'updated_at'];
  elsif (old.status = 'pending' and new.status in ('accepted', 'declined', 'revoked', 'expired'))
     or (old.status = 'accepted' and new.status in ('in_progress', 'revoked', 'expired'))
     or (old.status = 'in_progress' and new.status in ('completed', 'revoked', 'expired')) then
    v_mutable := case new.status
      when 'accepted' then array['status', 'accepted_at', 'accepted_by', 'updated_at']
      when 'in_progress' then array['status', 'started_at', 'started_by', 'updated_at']
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
      select a.status into v_new_follow_up_status
        from public.appointments a
       where a.id = new.follow_up_appointment_id;
      if v_new_follow_up_status in ('cancelled', 'no_show') then
        raise exception 'referral: the follow-up appointment is cancelled';
      end if;
      if old.follow_up_appointment_id is not null then
        select a.status into v_old_follow_up_status
          from public.appointments a
         where a.id = old.follow_up_appointment_id;
        -- A cancelled/no-show booking may be replaced; so may one that has
        -- not started when the receiving doctor saw the patient before it.
        if v_old_follow_up_status not in ('cancelled', 'no_show')
           and not (
             v_old_follow_up_status in ('pending', 'confirmed', 'checked_in')
             and v_new_follow_up_status in ('in_progress', 'completed')
           ) then
          raise exception 'referral: a follow-up appointment is already booked';
        end if;
      end if;

      -- Linking a consultation that has already started: the referral is in
      -- progress from this statement on.
      if v_new_follow_up_status in ('in_progress', 'completed') then
        if v_target_profile is null or not v_target_active or not v_target_is_doctor then
          raise exception 'referral: only the receiving doctor can mark the referral in_progress';
        end if;
        new.status := 'in_progress';
        new.started_at := now();
        new.started_by := v_target_profile;
      end if;
    end if;
    return new;
  end if;

  if new.status in ('accepted', 'in_progress', 'completed') and old.expires_at <= now() then
    raise exception 'referral: the referral expired at %', old.expires_at;
  end if;
  if new.status = 'expired' and old.expires_at > now() then
    raise exception 'referral: the referral does not expire until %', old.expires_at;
  end if;

  if new.status = 'in_progress' and not exists (
       select 1 from public.appointments a
       where a.id = old.follow_up_appointment_id
         and a.status in ('in_progress', 'completed')
     ) then
    raise exception 'referral: a referral is in progress only once its follow-up consultation has started';
  end if;

  if new.status in ('accepted', 'in_progress', 'declined', 'completed') then
    v_actor := case new.status
      when 'accepted' then new.accepted_by
      when 'in_progress' then new.started_by
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
    when 'in_progress' then new.started_at := now();
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
      when 'in_progress' then new.started_by
      when 'declined' then new.declined_by
      when 'completed' then new.completed_by
      when 'revoked' then new.revoked_by
      else null
    end;
    v_old := jsonb_build_object('status', old.status);
    -- A consultation linked in the same statement (see referrals_validate).
    if new.follow_up_appointment_id is distinct from old.follow_up_appointment_id then
      v_old := v_old || jsonb_build_object('follow_up_appointment_id', old.follow_up_appointment_id);
    end if;
  elsif new.follow_up_appointment_id is distinct from old.follow_up_appointment_id then
    v_action := 'referral_follow_up_booked';
    select a.created_by into v_actor
      from public.appointments a
     where a.id = new.follow_up_appointment_id;
    v_old := jsonb_build_object('follow_up_appointment_id', old.follow_up_appointment_id);
  else
    return null;
  end if;

  -- Ids, status and dates only: never the reason, handoff note or any other
  -- clinical text.
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

-- ---------- 3. A linked follow-up starting moves the referral ----------

create or replace function public.referral_follow_up_started()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status in ('in_progress', 'completed') and old.status not in ('in_progress', 'completed') then
    begin
      -- The consultation is the receiving doctor's own appointment (foreign
      -- key), so the transition is theirs. Rows that referrals_validate()
      -- would refuse are not selected in the first place.
      update public.referrals r
         set status = 'in_progress',
             started_by = d.profile_id
        from public.doctors d
       where r.follow_up_appointment_id = new.id
         and r.clinic_id = new.clinic_id
         and r.status = 'accepted'
         and r.expires_at > now()
         and d.id = r.referred_to_doctor_id
         and d.clinic_id = r.clinic_id
         and d.active
         and d.profile_id is not null
         and exists (
           select 1 from public.staff_roles sr
           where sr.profile_id = d.profile_id
             and sr.clinic_id = d.clinic_id
             and sr.role = 'doctor'::public.staff_role
         );
    exception when others then
      -- Never block the visit itself; the referral simply stays accepted.
      raise warning 'referral follow-up start not recorded (sqlstate %)', sqlstate;
    end;
  end if;
  return null;
end;
$$;

revoke execute on function public.referral_follow_up_started() from public, anon, authenticated;

drop trigger if exists appointments_referral_follow_up_started on public.appointments;
create trigger appointments_referral_follow_up_started
  after update of status on public.appointments
  for each row execute function public.referral_follow_up_started();

-- ---------- 4. Open = pending, accepted or in progress ----------

drop index if exists public.referrals_one_open_per_pair;
create unique index referrals_one_open_per_pair
  on public.referrals (patient_id, referring_doctor_id, referred_to_doctor_id)
  where status in ('pending', 'accepted', 'in_progress');

drop policy if exists "referrals read for receiving doctor" on public.referrals;
create policy "referrals read for receiving doctor"
  on public.referrals for select
  to authenticated
  using (
    public.is_linked_doctor(referred_to_doctor_id)
    and (
      status = 'completed'
      or (status in ('pending', 'accepted', 'in_progress') and expires_at > now())
    )
  );

-- Same signature and columns as 20260927000004: the policies built on it
-- keep working. Only the referral states change: an in-progress referral
-- counts wherever an accepted one does.
create or replace function public.doctor_patient_access(p_doctor_id uuid, p_patient_id uuid)
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
        and r.status in ('pending', 'accepted', 'in_progress')
        and r.expires_at > now()
      order by r.created_at
    ),
    array(
      select distinct r.referring_doctor_id
      from public.referrals r
      where r.clinic_id = d.clinic_id
        and r.patient_id = p.id
        and r.referred_to_doctor_id = d.id
        and r.status in ('accepted', 'in_progress')
        and r.expires_at > now()
    ),
    array(
      -- The consultation an active referral to this doctor was raised from…
      select r.originating_appointment_id
      from public.referrals r
      where r.clinic_id = d.clinic_id
        and r.patient_id = p.id
        and r.referred_to_doctor_id = d.id
        and r.status in ('pending', 'accepted', 'in_progress')
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

-- ---------- 5. Record types ----------

comment on type public.clinical_record_type is
  'consultation_note: clinical note; assessment: the doctor''s current assessment; diagnosis: a diagnosis made in that consultation (earlier consultations'' diagnoses are historical, never rewritten); prescription; lab_order: tests ordered; lab_result; medical_history; follow_up: follow-up plan or onward referral note.';

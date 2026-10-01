-- Longitudinal patient history and department referrals.
--
-- A referral is a clinical handoff, not a permission request, and a patient's
-- clinical history belongs to the patient's clinic record:
--
-- 1. LONGITUDINAL ACCESS. A doctor with a legitimate clinical relationship to
--    a patient sees the patient's whole clinical history in the clinic —
--    every doctor's consultations and records — without asking anyone. The
--    relationship (unchanged in kind, widened in what it shows):
--      * a treating relationship: any appointment, neither cancelled nor a no-show, with the
--        patient (past, today or booked; a website booking not yet confirmed
--        by staff excepted — its visitor is unverified) or a record the
--        doctor wrote — kept for continuity of care; or
--      * an open referral (pending, accepted or in progress, unexpired) to
--        the doctor, or to the doctor's department while no doctor has taken
--        it yet — from the moment it is created: acceptance is a care step,
--        never a gate on the history.
--    Everything else is unchanged: an active doctor-role doctor of the
--    patient's clinic only (no row across clinics), no access at all for a
--    same-clinic doctor without a relationship, clinical text read only
--    through the server (signed-in roles still have no SELECT on
--    clinical_records / referrals), and every record stays its author's —
--    only the author corrects it (20261001000001).
--
-- 2. DEPARTMENT REFERRALS. A referral goes to a department (a specialty),
--    a doctor, or both (the doctor must then belong to the department). A
--    department referral waits in every department doctor's incoming list;
--    the first of them to accept it becomes its receiving doctor
--    (referred_to_doctor_id is set exactly once, by that doctor's own
--    acceptance). Until then nobody can decline, start or complete it.
--
-- 3. PAYMENTS. Doctors no longer read payment rows directly (the policy
--    "payments read for own doctor" is dropped): the server shows a doctor
--    only the payment status of the visit in front of them.
--
-- 4. PATIENT IDENTITY. patients.phone_normalized (digits only, a 9-digit
--    local number prefixed with 998) is generated from phone and indexed per
--    clinic, so reception can find a returning patient before creating a
--    duplicate. Not unique: two people can share a phone.
--
-- 4b. CONSULTATION START. A doctor's own start re-checks their access inside
--    the transaction (a walk-in resting on a referral alone confirms the
--    referral is still open after booking, locking appointment-then-referral,
--    and is refused with SQLSTATE CALST otherwise), refuses an unconfirmed
--    website booking, and accepts the doctor's pending referral there too: a
--    start that fails accepts nothing.
--
-- 5. AUDIT. A correction is audited as 'clinical_record_version_created'
--    (earlier rows keep 'clinical_record_corrected'); referral events carry
--    the department.
--
-- Reversible (restore each function from the LATEST earlier definition — on a
-- database that has 20261001000002 that migration redefines three of them):
-- doctor_patient_access(), referrals_validate() and
-- consultation_started_effects() from 20261001000002 (the no-show rule, the
-- follow-up of a pending referral), and from 20260930000001 for
-- start_consultation() / start_walk_in_consultation(); referrals_audit() and
-- the receiving-doctor policy from 20260929000001, doctor_can_read_patient()
-- from 20260927000003, doctor_can_read_appointment() from 20260929000001,
-- clinical_records_audit() from 20261001000001; re-create the policy
-- "referral history for treating doctor" (20261001000002) only if rolling back
-- past it; re-create
-- "payments read for own doctor" (20260927000004); drop trigger
-- referrals_catch_up_started and its function; drop
-- referrals.referred_to_specialty_id (after assigning or revoking department
-- referrals), its constraints and indexes, and set referred_to_doctor_id not
-- null again; drop patients.phone_normalized, its index and
-- normalize_phone().

-- ---------------------------------------------------------------------------
-- 1. Department referrals: columns and constraints
-- ---------------------------------------------------------------------------

alter table public.referrals
  add column referred_to_specialty_id uuid,
  alter column referred_to_doctor_id drop not null,
  add constraint referrals_referred_to_specialty_fkey
    foreign key (referred_to_specialty_id, clinic_id) references public.specialties (id, clinic_id),
  add constraint referrals_recipient_check
    check (referred_to_doctor_id is not null or referred_to_specialty_id is not null);

comment on column public.referrals.referred_to_specialty_id is
  'The department (specialty) the patient is referred to. Alone: every active doctor of the department sees the referral until one of them accepts it and becomes referred_to_doctor_id.';

-- One open referral per patient, referring doctor and department while no
-- doctor has taken it (referrals_one_open_per_pair covers named doctors).
create unique index referrals_one_open_per_department
  on public.referrals (patient_id, referring_doctor_id, referred_to_specialty_id)
  where referred_to_doctor_id is null and status in ('pending', 'accepted', 'in_progress');

create index referrals_unclaimed_department_idx
  on public.referrals (clinic_id, referred_to_specialty_id, status)
  where referred_to_doctor_id is null;

-- ---------------------------------------------------------------------------
-- 2. Status machine: department referrals and their acceptance
-- ---------------------------------------------------------------------------

create or replace function public.referrals_validate()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
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
  v_target_specialty uuid;
  v_appointment_status public.appointment_status;
  v_old_follow_up_status public.appointment_status;
  v_new_follow_up_status public.appointment_status;
  v_mutable text[];
  v_actor uuid;
  v_claiming boolean := false;
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
         ),
         d.specialty_id
    into v_target_active, v_target_profile, v_target_is_doctor, v_target_specialty
    from public.doctors d
   where d.id = new.referred_to_doctor_id
     and d.clinic_id = new.clinic_id;
  v_target_found := found;

  if tg_op = 'INSERT' then
    if new.status is distinct from 'pending'::public.referral_status then
      raise exception 'referral: a referral must be created as pending';
    end if;
    if new.follow_up_appointment_id is not null then
      raise exception 'referral: a follow-up can only be linked to an open handoff';
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
      if new.referred_to_specialty_id is not null
         and v_target_specialty is distinct from new.referred_to_specialty_id then
        raise exception 'referral: the receiving doctor does not belong to that department';
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

  -- A department referral nobody has taken yet: its first acceptance names
  -- the receiving doctor, and nothing else may name one.
  if old.referred_to_doctor_id is null then
    if new.referred_to_doctor_id is not null then
      if not (old.status = 'pending' and new.status = 'accepted') then
        raise exception 'referral: a department referral is taken by accepting it';
      end if;
      v_claiming := true;
    end if;
  elsif new.referred_to_doctor_id is distinct from old.referred_to_doctor_id then
    raise exception 'referral: a referral cannot be edited, only moved through its status transitions';
  end if;

  -- UPDATE: status transitions, plus scheduling the follow-up of an open
  -- handoff (reception need not wait for acknowledgement — a referral is no
  -- permission request). A department referral nobody has taken has no
  -- doctor yet, so its visit can only be booked once a doctor took it.
  if new.status = old.status then
    if new.follow_up_appointment_id is distinct from old.follow_up_appointment_id
       and (old.status not in ('pending', 'accepted') or old.referred_to_doctor_id is null) then
      raise exception 'referral: a follow-up can only be linked to an open handoff';
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
    if v_claiming then
      v_mutable := v_mutable || array['referred_to_doctor_id'];
    end if;
  else
    raise exception 'referral: invalid status transition % -> %', old.status, new.status;
  end if;

  if (to_jsonb(new) - v_mutable) is distinct from (to_jsonb(old) - v_mutable) then
    if new.status = old.status then
      raise exception 'referral: a referral cannot be edited, only moved through its status transitions';
    end if;
    raise exception 'referral: the % transition may only set its own fields', new.status;
  end if;

  if v_claiming then
    if new.referred_to_doctor_id = new.referring_doctor_id
       or (v_target_profile is not null and v_target_profile = v_referring_profile) then
      raise exception 'referral: self-referral (both doctor records belong to the same account)';
    end if;
    if not v_target_found or v_target_specialty is distinct from old.referred_to_specialty_id then
      raise exception 'referral: the receiving doctor does not belong to that department';
    end if;
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
      if old.status = 'accepted' and v_new_follow_up_status in ('in_progress', 'completed') then
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
    -- For a department referral nobody has taken, there is no receiving
    -- doctor yet: only an acceptance that names one can pass.
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

revoke all on function public.referrals_validate() from public, anon, authenticated;

create or replace function public.referrals_audit()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
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
    -- A department referral taken by the doctor who accepted it.
    if new.referred_to_doctor_id is distinct from old.referred_to_doctor_id then
      v_old := v_old || jsonb_build_object('referred_to_doctor_id', old.referred_to_doctor_id);
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
    patient_id, referral_id, old_values, new_values, metadata, ip_address
  ) values (
    new.clinic_id,
    v_actor,
    case when v_actor is null then 'system'::public.actor_type else 'staff'::public.actor_type end,
    v_action,
    'referrals',
    new.id::text,
    new.patient_id,
    new.id,
    v_old,
    jsonb_build_object(
      'status', new.status,
      'priority', new.priority,
      'patient_id', new.patient_id,
      'referring_doctor_id', new.referring_doctor_id,
      'referred_to_doctor_id', new.referred_to_doctor_id,
      'referred_to_specialty_id', new.referred_to_specialty_id,
      'originating_appointment_id', new.originating_appointment_id,
      'follow_up_appointment_id', new.follow_up_appointment_id,
      'expires_at', new.expires_at
    ),
    case when new.status = 'expired' and v_action = 'referral_expired'
      then jsonb_build_object('cause', 'validity_elapsed')
      else '{}'::jsonb
    end,
    nullif(current_setting('request.ip', true), '')
  );
  return null;
end;
$$;

revoke all on function public.referrals_audit() from public, anon, authenticated;

-- A pending referral whose follow-up visit is already under way (reception
-- linked it, the visit started, and only now does the receiving doctor accept)
-- is in progress from its acceptance on: otherwise it would stay 'accepted'
-- beside a started — later completed — consultation, with no transition left
-- to take. The acceptance and the start are both audited (two transitions).
-- Also covers the in-transaction accept in consultation_started_effects().
create or replace function public.referrals_catch_up_started()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if old.status = 'pending'
     and new.status = 'accepted'
     and new.follow_up_appointment_id is not null
     and exists (
       select 1 from public.appointments a
        where a.id = new.follow_up_appointment_id
          and a.status in ('in_progress', 'completed')
     ) then
    update public.referrals r
       set status = 'in_progress', started_by = new.accepted_by
     where r.id = new.id
       and r.status = 'accepted';
  end if;
  return null;
end;
$$;

revoke all on function public.referrals_catch_up_started() from public, anon, authenticated;

create trigger referrals_catch_up_started
  after update of status on public.referrals
  for each row execute function public.referrals_catch_up_started();

-- The receiving doctor's (backstop) view of a referral: also a department
-- doctor's while nobody has taken it. Signed-in roles still have no SELECT
-- on referrals; every read goes through the server.
-- 20261001000002 added a SELECT policy for any treating doctor. Referral
-- rows carry the doctor's clinical handoff text and signed-in roles read no
-- clinical table directly (reads go through the server, which authorizes and
-- audits each one), so it is dropped; the receiving doctor's backstop policy
-- below is the only one.
drop policy if exists "referral history for treating doctor" on public.referrals;
drop policy if exists "referrals read for receiving doctor" on public.referrals;
create policy "referrals read for receiving doctor"
  on public.referrals for select
  to authenticated
  using (
    status in ('pending', 'accepted', 'in_progress', 'completed')
    and expires_at > now()
    and (
      public.is_linked_doctor(referred_to_doctor_id)
      or (
        referred_to_doctor_id is null
        and status = 'pending'
        -- A doctor never receives the referral they raised themselves.
        and referring_doctor_id is distinct from public.current_doctor_id(clinic_id)
        and referred_to_specialty_id = (
          select d.specialty_id from public.doctors d where d.id = public.current_doctor_id(clinic_id)
        )
      )
    )
  );

-- ---------------------------------------------------------------------------
-- 3. The decision: longitudinal history for a legitimate relationship
-- ---------------------------------------------------------------------------

-- The return columns change, so the function is re-created. The policies
-- call it only through doctor_can_read_patient()/doctor_can_read_appointment(),
-- whose signatures stay, so no policy has to be re-created.
drop function public.doctor_patient_access(uuid, uuid);

create function public.doctor_patient_access(p_doctor_id uuid, p_patient_id uuid)
returns table (
  clinic_id uuid,
  own_patient boolean,
  active_referral_ids uuid[],
  full_history boolean
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with decision as (
    select
      d.clinic_id,
      -- Treating relationship: any appointment that was neither cancelled nor
      -- a no-show (past, today or booked), or a record the doctor wrote. A website booking
      -- nobody has confirmed yet is not one: it is made without any proof of
      -- who the visitor is, and could name someone else's record. Once staff
      -- confirm it (any status beyond pending) it counts like any other.
      exists (
        select 1
        from public.appointments a
        where a.clinic_id = d.clinic_id
          and a.patient_id = p.id
          and a.doctor_id = d.id
          and a.status not in ('cancelled', 'no_show')
          and not (a.source = 'web' and a.status = 'pending')
      )
      or exists (
        select 1
        from public.clinical_records cr
        where cr.clinic_id = d.clinic_id
          and cr.patient_id = p.id
          and cr.author_doctor_id = d.id
      ) as own_patient,
      -- Open, unexpired referrals to the doctor — or to the doctor's
      -- department while nobody has taken them (other than their own).
      array(
        select r.id
        from public.referrals r
        where r.clinic_id = d.clinic_id
          and r.patient_id = p.id
          and r.status in ('pending', 'accepted', 'in_progress')
          and r.expires_at > now()
          and (
            r.referred_to_doctor_id = d.id
            or (
              r.referred_to_doctor_id is null
              and r.status = 'pending'
              -- Never the referral the doctor raised themselves: their own
              -- department is not a receiver of it.
              and r.referring_doctor_id <> d.id
              and d.specialty_id is not null
              and r.referred_to_specialty_id = d.specialty_id
            )
          )
        order by r.created_at
      ) as active_referral_ids
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
      )
  )
  select clinic_id, own_patient, active_referral_ids, own_patient or cardinality(active_referral_ids) > 0
  from decision;
$$;

comment on function public.doctor_patient_access(uuid, uuid) is
  'What an active doctor may see of a patient of their clinic (see 20261002000001): full_history — the patient''s whole clinical history, every doctor''s visits and records — for a treating relationship (an appointment that was neither cancelled nor a no-show, or an authored record) or an open, unexpired referral to them or (while untaken) to their department. No row = other clinic / not an active doctor. Server-only.';

revoke all on function public.doctor_patient_access(uuid, uuid) from public, anon, authenticated;
grant execute on function public.doctor_patient_access(uuid, uuid) to service_role;

-- Whether the caller, as a doctor, may read this patient's record.
create or replace function public.doctor_can_read_patient(p_clinic_id uuid, p_patient_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce((
    select x.full_history
    from public.doctor_patient_access(public.current_doctor_id(p_clinic_id), p_patient_id) x
    where x.clinic_id = p_clinic_id
  ), false);
$$;

-- Whether the caller, as a doctor, may read an appointment (and the records
-- written in it) of this patient: every one of them once they may see the
-- patient's history. The appointment's doctor and id no longer narrow it;
-- the signature stays for the policies that call it.
create or replace function public.doctor_can_read_appointment(
  p_clinic_id uuid,
  p_patient_id uuid,
  p_doctor_id uuid,
  p_appointment_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select public.doctor_can_read_patient(p_clinic_id, p_patient_id);
$$;

comment on table public.clinical_records is
  'Doctor-authored clinical records with provenance (author, consultation, time, type, version) — part of the patient''s longitudinal clinic record. Readable by doctors doctor_patient_access() gives the patient''s history (a treating relationship or an open referral), never by operational staff, patients or AI; only the author corrects (as a new version).';

-- ---------------------------------------------------------------------------
-- 4. Payments: no direct reads by doctors
-- ---------------------------------------------------------------------------

drop policy if exists "payments read for own doctor" on public.payments;

-- ---------------------------------------------------------------------------
-- 5. Patient identity: a normalized phone to find returning patients
-- ---------------------------------------------------------------------------

create or replace function public.normalize_phone(p_phone text)
returns text
language sql
immutable
parallel safe
set search_path = pg_catalog
as $$
  select case
    when digits = '' then null
    -- 00 998 …: the international prefix dialled from abroad.
    when digits like '00998%' then substr(digits, 3)
    -- A national number: 9 digits, or with the trunk prefix 8 / 0 (10 digits).
    when length(digits) = 9 then '998' || digits
    when length(digits) = 10 and left(digits, 1) in ('8', '0') then '998' || substr(digits, 2)
    else digits
  end
  from (select regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g') as digits) s;
$$;

comment on function public.normalize_phone(text) is
  'Digits only; a national number (9 digits, or 10 with a leading 8 or 0) gets the 998 country code, and a leading 00 before 998 is dropped. NULL when there are no digits.';

alter table public.patients
  add column phone_normalized text generated always as (public.normalize_phone(phone)) stored;

create index patients_clinic_phone_normalized_idx
  on public.patients (clinic_id, phone_normalized)
  where phone_normalized is not null;

-- ---------------------------------------------------------------------------
-- 5b. Starting a consultation: access re-checked and referral accepted in the
--     same transaction as the start
-- ---------------------------------------------------------------------------

-- Lock order, everywhere: the APPOINTMENT first, then the referral (the order
-- the trigger on referrals and the front desk's start already use). Nothing
-- below takes a referral lock before an appointment lock, and no shared lock
-- is ever upgraded — a shared-then-exclusive pattern deadlocks two concurrent
-- starts of one visit.

-- consultation_started_effects: the doctor who starts treating a referred
-- patient takes the referral on first — their own named pending referral
-- before an untaken department one, a referral the database refuses skipped —
-- so a start that fails (a taken slot, a refused booking) accepts nothing.
-- The referral rows are locked FOR UPDATE and waited for: a colleague's
-- concurrent claim is seen (and the row then no longer qualifies), never
-- silently skipped.
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
  v_profile uuid;
  v_specialty uuid;
  v_pending record;
begin
  select * into v_appointment from public.appointments where id = p_appointment_id;
  if not found or v_appointment.status <> 'in_progress' then
    raise exception 'consultation: the appointment is not in progress';
  end if;

  if p_link_referral and p_via in ('doctor_workspace', 'doctor_queue') then
    select d.profile_id, d.specialty_id into v_profile, v_specialty from public.doctors d where d.id = v_appointment.doctor_id;
    for v_pending in
      select r.id
        from public.referrals r
       where r.clinic_id = v_appointment.clinic_id
         and r.patient_id = v_appointment.patient_id
         and r.status = 'pending'
         and r.expires_at > now()
         and (
           r.referred_to_doctor_id = v_appointment.doctor_id
           or (r.referred_to_doctor_id is null and v_specialty is not null
               and r.referred_to_specialty_id = v_specialty and r.referring_doctor_id <> v_appointment.doctor_id)
         )
       order by (r.referred_to_doctor_id is null), r.created_at
         for update of r
    loop
      begin
        update public.referrals
           set status = 'accepted',
               accepted_by = v_profile,
               referred_to_doctor_id = v_appointment.doctor_id
         where id = v_pending.id and status = 'pending';
        exit when found;
      exception when others then
        null; -- a referral the database refuses (say, a second open one to the same doctor) is left for the next
      end;
    end loop;
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

-- start_consultation. For a doctor's own start (workspace or queue):
--   * the actor must be the appointment's doctor's own login (the RPC's
--     parameters are trusted, so a doctor channel cannot be used to act as
--     someone else);
--   * a website booking staff have not confirmed yet is refused
--     ('awaiting_confirmation'): its visitor is unverified, and starting it
--     would make the doctor the patient's treating doctor;
--   * the doctor's access is decided again, without locks ('access_lost'):
--     their own (not cancelled, not no-show) appointment is itself a permanent relationship,
--     so no referral needs holding for it.
-- The front desk's start is reception's own act and is not restricted.
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
declare
  v_appointment public.appointments%rowtype;
  v_doctor uuid;
  v_profile uuid;
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

  if p_via in ('doctor_workspace', 'doctor_queue') then
    select * into v_appointment from public.appointments a where a.id = p_appointment_id and a.clinic_id = p_clinic_id;
    v_doctor := coalesce(p_doctor_id, v_appointment.doctor_id);
    if v_doctor is not null then
      select d.profile_id into v_profile from public.doctors d where d.id = v_doctor and d.clinic_id = p_clinic_id;
      if v_profile is distinct from p_actor then
        raise exception 'consultation: a doctor starts their own consultation (the actor is not that doctor''s login)';
      end if;
    end if;
    if v_appointment.id is not null then
      if v_appointment.source = 'web' and v_appointment.status = 'pending' then
        return jsonb_build_object('started', false, 'referral_id', null, 'error_code', 'awaiting_confirmation');
      end if;
      if not coalesce((
        select x.full_history from public.doctor_patient_access(v_doctor, v_appointment.patient_id) x where x.clinic_id = p_clinic_id
      ), false) then
        return jsonb_build_object('started', false, 'referral_id', null, 'error_code', 'access_lost');
      end if;
    end if;
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

-- start_walk_in_consultation: the doctor's access is decided before the
-- booking (no locks). When it rests on a referral alone — there is no
-- appointment of theirs yet — the referrals that gave it are locked AFTER the
-- booking (appointment first, then referral) and one must still be open, or
-- the whole transaction is refused with SQLSTATE CALST and the booking goes
-- with it: a revoke, decline or a colleague's claim that committed first is
-- seen, and one that comes later waits for this start.
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
  v_access record;
  v_specialty uuid;
  v_open boolean;
begin
  if not exists (
    select 1 from public.doctors d
     where d.id = p_doctor_id and d.clinic_id = p_clinic_id and d.profile_id = p_actor
  ) then
    raise exception 'consultation: a walk-in is started by the doctor themselves';
  end if;

  select x.own_patient, x.full_history, x.active_referral_ids into v_access
    from public.doctor_patient_access(p_doctor_id, p_patient_id) x
   where x.clinic_id = p_clinic_id;
  if not found or not v_access.full_history then
    return jsonb_build_object('appointment_id', null, 'error_code', 'access_lost', 'referral_id', null);
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

  if not v_access.own_patient then
    select d.specialty_id into v_specialty from public.doctors d where d.id = p_doctor_id and d.clinic_id = p_clinic_id;
    perform 1 from public.referrals r where r.id = any (v_access.active_referral_ids) for no key update;
    select exists (
      select 1
        from public.referrals r
       where r.id = any (v_access.active_referral_ids)
         and r.clinic_id = p_clinic_id
         and r.patient_id = p_patient_id
         and r.status in ('pending', 'accepted', 'in_progress')
         and r.expires_at > now()
         and (
           r.referred_to_doctor_id = p_doctor_id
           or (r.referred_to_doctor_id is null and v_specialty is not null
               and r.referred_to_specialty_id = v_specialty and r.referring_doctor_id <> p_doctor_id)
         )
    ) into v_open;
    if not v_open then
      raise exception 'consultation: the referral that gave this doctor access has ended' using errcode = 'CALST';
    end if;
  end if;

  return jsonb_build_object(
    'appointment_id', v_booking.appointment_id,
    'error_code', null,
    'referral_id', public.consultation_started_effects(v_booking.appointment_id, p_actor, 'doctor_workspace', true, true)
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Audit naming: a correction creates a version
-- ---------------------------------------------------------------------------

create or replace function public.clinical_records_audit()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_referral uuid;
  v_previous public.clinical_records;
begin
  select r.id into v_referral
    from public.referrals r
   where r.clinic_id = new.clinic_id
     and r.patient_id = new.patient_id
     and r.follow_up_appointment_id = new.appointment_id
   order by r.created_at desc
   limit 1;

  if new.corrects_record_id is not null then
    select * into v_previous from public.clinical_records where id = new.corrects_record_id;
  end if;

  insert into public.audit_events (
    clinic_id, actor_id, actor_type, action, entity_type, entity_id,
    patient_id, referral_id, old_values, new_values
  ) values (
    new.clinic_id,
    new.created_by,
    'staff'::public.actor_type,
    case when new.corrects_record_id is null then 'clinical_record_created' else 'clinical_record_version_created' end,
    'clinical_records',
    new.id::text,
    new.patient_id,
    v_referral,
    case when new.corrects_record_id is null then null else
      jsonb_build_object(
        'record_id', v_previous.id,
        'version', v_previous.version,
        'author_doctor_id', v_previous.author_doctor_id,
        'created_by', v_previous.created_by
      )
    end,
    jsonb_build_object(
      'record_type', new.record_type,
      'patient_id', new.patient_id,
      'author_doctor_id', new.author_doctor_id,
      'appointment_id', new.appointment_id,
      'corrects_record_id', new.corrects_record_id,
      'root_record_id', new.root_record_id,
      'version', new.version
    )
  );
  return new;
end;
$$;

revoke all on function public.clinical_records_audit() from public, anon, authenticated;

-- Clinical referrals, Phase 1: the data model only.
--
-- Doctor A refers a patient to Doctor B inside one clinic. This migration adds
-- the referral record and its database-level guarantees. It deliberately does
-- NOT widen access to the patient's history (patients/appointments RLS is
-- unchanged) and adds no API or UI.
--
-- Reuses the existing model — no new patient, doctor, clinic, consultation or
-- diagnosis tables:
--   * clinic, patient and both doctors are the existing clinics, patients and
--     doctors rows;
--   * there is no separate consultation entity: the consultation is the
--     appointments row in which the referring doctor saw the patient
--     (originating_appointment_id).
--
-- Tenant isolation is declarative. Composite foreign keys pin the patient,
-- both doctors and the originating appointment to the referral's own
-- clinic_id; the appointment key also pins it to THIS patient and THIS
-- referring doctor, so every referral stems from a real consultation between
-- them. The UNIQUE constraints added to patients/doctors/appointments exist
-- only as targets for those keys; each is implied by the table's primary key,
-- so no existing row can violate them.
--
-- Rules a constraint cannot express live in referrals_validate():
--   * created 'pending', from an in-progress or completed consultation, by the
--     referring doctor's own active doctor account, to a different active
--     doctor who has a doctor account (no self-referral, even across two
--     doctor records linked to the same account);
--   * pending -> accepted | declined | revoked | expired;
--     accepted -> completed | revoked | expired; everything else is terminal;
--   * accept/decline/complete only by the receiving doctor; revoke only by the
--     referring doctor or clinic management (owner/admin/manager); accept and
--     complete only before expires_at; expire only after it;
--   * transition timestamps are set by the database, never by the caller;
--   * the clinical content, parties and provenance never change after
--     creation — a mistaken referral is revoked and re-issued.
--
-- Auditability:
--   * referrals_audit() records every creation and status transition in
--     audit_events with the acting staff profile. It is taken from the
--     provenance column the validator just checked, because server writes use
--     the service role, where auth.uid() is NULL;
--   * audit rows carry ids and status only — never the reason, handoff note or
--     decline/revocation text: audit_events is readable by non-clinical
--     management;
--   * nobody but the table owner may DELETE a referral; rows only disappear
--     through the existing patient/clinic erasure cascades.
--
-- Access: browser sessions may only SELECT, and only the two doctors on the
-- referral — the receiving doctor while it is open and unexpired, or after
-- they completed it. Every write is server-side (service role).
--
-- Reversible: drop table public.referrals; drop functions
-- public.referrals_validate(), public.referrals_audit() and
-- public.is_linked_doctor(uuid); drop types public.referral_status and
-- public.referral_priority; drop constraints patients_id_clinic_id_key,
-- doctors_id_clinic_id_key and
-- appointments_id_clinic_id_patient_id_doctor_id_key.

-- ---------- 1. Types ----------

create type public.referral_status as enum (
  'pending',
  'accepted',
  'declined',
  'completed',
  'revoked',
  'expired'
);

create type public.referral_priority as enum ('routine', 'urgent');

-- ---------- 2. Same-clinic reference keys on existing tables ----------

alter table public.patients
  add constraint patients_id_clinic_id_key unique (id, clinic_id);

alter table public.doctors
  add constraint doctors_id_clinic_id_key unique (id, clinic_id);

alter table public.appointments
  add constraint appointments_id_clinic_id_patient_id_doctor_id_key
  unique (id, clinic_id, patient_id, doctor_id);

-- ---------- 3. referrals ----------

create table public.referrals (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete cascade,
  patient_id uuid not null,
  referring_doctor_id uuid not null,
  referred_to_doctor_id uuid not null,
  originating_appointment_id uuid not null,
  reason text not null,
  handoff_note text,
  priority public.referral_priority not null default 'routine',
  status public.referral_status not null default 'pending',
  expires_at timestamptz not null default (now() + interval '90 days'),
  created_by uuid not null references public.profiles(id),
  accepted_at timestamptz,
  accepted_by uuid references public.profiles(id),
  declined_at timestamptz,
  declined_by uuid references public.profiles(id),
  declined_reason text,
  completed_at timestamptz,
  completed_by uuid references public.profiles(id),
  revoked_at timestamptz,
  revoked_by uuid references public.profiles(id),
  revoked_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint referrals_patient_same_clinic_fkey
    foreign key (patient_id, clinic_id)
    references public.patients (id, clinic_id) on delete cascade,
  constraint referrals_referring_doctor_same_clinic_fkey
    foreign key (referring_doctor_id, clinic_id)
    references public.doctors (id, clinic_id),
  constraint referrals_referred_to_doctor_same_clinic_fkey
    foreign key (referred_to_doctor_id, clinic_id)
    references public.doctors (id, clinic_id),
  constraint referrals_originating_appointment_fkey
    foreign key (originating_appointment_id, clinic_id, patient_id, referring_doctor_id)
    references public.appointments (id, clinic_id, patient_id, doctor_id),

  constraint referrals_not_self_referral
    check (referring_doctor_id <> referred_to_doctor_id),
  -- Free text must contain something other than whitespace.
  constraint referrals_reason_check
    check (reason ~ '\S' and char_length(reason) <= 2000),
  constraint referrals_handoff_note_check
    check (handoff_note is null or (handoff_note ~ '\S' and char_length(handoff_note) <= 4000)),
  constraint referrals_declined_reason_check
    check (declined_reason is null or (declined_reason ~ '\S' and char_length(declined_reason) <= 1000)),
  constraint referrals_revoked_reason_check
    check (revoked_reason is null or (revoked_reason ~ '\S' and char_length(revoked_reason) <= 1000)),
  -- A referral can never grant open-ended access.
  constraint referrals_expiry_window_check
    check (expires_at > created_at and expires_at <= created_at + interval '365 days'),

  -- Each lifecycle field is set exactly when its status is reached, together
  -- with the acting profile.
  constraint referrals_accepted_state_check
    check (
      (accepted_at is null) = (accepted_by is null)
      and case status
        when 'pending' then accepted_at is null
        when 'declined' then accepted_at is null
        when 'accepted' then accepted_at is not null
        when 'completed' then accepted_at is not null
        else true
      end
    ),
  constraint referrals_declined_state_check
    check (
      (status = 'declined') = (declined_at is not null)
      and (declined_at is null) = (declined_by is null)
      and (declined_reason is null or declined_at is not null)
    ),
  constraint referrals_completed_state_check
    check (
      (status = 'completed') = (completed_at is not null)
      and (completed_at is null) = (completed_by is null)
    ),
  constraint referrals_revoked_state_check
    check (
      (status = 'revoked') = (revoked_at is not null)
      and (revoked_at is null) = (revoked_by is null)
      and (revoked_at is null) = (revoked_reason is null)
    ),
  constraint referrals_timeline_check
    check (
      (accepted_at is null or accepted_at >= created_at)
      and (declined_at is null or declined_at >= created_at)
      and (completed_at is null or completed_at >= accepted_at)
      and (revoked_at is null or revoked_at >= created_at)
    )
);

comment on table public.referrals is
  'Doctor-to-doctor referral within one clinic. reason and handoff_note are clinical free text: never log them, copy them into audit_events or analytics, send them over Telegram, or pass them to the AI layer.';

comment on column public.referrals.originating_appointment_id is
  'The consultation (appointment) in which the referring doctor saw the patient; in progress or completed when the referral is created.';

comment on column public.referrals.expires_at is
  'End of the referral''s validity (at most 365 days after creation). After it the referral can no longer be accepted or completed, and the receiving doctor can no longer read it unless they completed it.';

create index referrals_clinic_status_idx
  on public.referrals (clinic_id, status, created_at desc);

create index referrals_patient_idx
  on public.referrals (patient_id, created_at desc);

create index referrals_referring_doctor_idx
  on public.referrals (referring_doctor_id, status, created_at desc);

create index referrals_referred_to_doctor_idx
  on public.referrals (referred_to_doctor_id, status, created_at desc);

create index referrals_status_expires_idx
  on public.referrals (status, expires_at);

create index referrals_originating_appointment_idx
  on public.referrals (originating_appointment_id);

-- One open referral per patient, referring doctor and receiving doctor:
-- blocks accidental double submission; a new one is possible once the
-- previous one is closed.
create unique index referrals_one_open_per_pair
  on public.referrals (patient_id, referring_doctor_id, referred_to_doctor_id)
  where status in ('pending', 'accepted');

drop trigger if exists referrals_set_updated_at on public.referrals;
create trigger referrals_set_updated_at
  before update on public.referrals
  for each row execute function public.set_updated_at();

-- ---------- 4. Validation and status machine ----------

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

  -- UPDATE: status transitions are the only permitted change.
  if new.status = old.status then
    v_mutable := array['updated_at'];
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

comment on function public.referrals_validate() is
  'Referral business rules and status machine (see migration 20260926000001_referrals.sql); applies to every writer, including the service role.';

drop trigger if exists referrals_validate on public.referrals;
create trigger referrals_validate
  before insert or update on public.referrals
  for each row execute function public.referrals_validate();

-- ---------- 5. Audit (ids and status only, never clinical text) ----------

create or replace function public.referrals_audit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_action text;
  v_actor uuid;
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
    case when tg_op = 'UPDATE' then jsonb_build_object('status', old.status) end,
    jsonb_build_object(
      'status', new.status,
      'priority', new.priority,
      'patient_id', new.patient_id,
      'referring_doctor_id', new.referring_doctor_id,
      'referred_to_doctor_id', new.referred_to_doctor_id,
      'originating_appointment_id', new.originating_appointment_id,
      'expires_at', new.expires_at
    ),
    nullif(current_setting('request.ip', true), '')
  );
  return null;
end;
$$;

drop trigger if exists referrals_audit on public.referrals;
create trigger referrals_audit
  after insert or update on public.referrals
  for each row execute function public.referrals_audit();

-- ---------- 6. Access ----------

-- True when the signed-in user is the active, doctor-role account linked to
-- this doctor record (in the doctor record's own clinic).
create or replace function public.is_linked_doctor(p_doctor_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.doctors d
    join public.staff_roles sr
      on sr.profile_id = d.profile_id
     and sr.clinic_id = d.clinic_id
     and sr.role = 'doctor'::public.staff_role
    where d.id = p_doctor_id
      and d.active
      and d.profile_id = auth.uid()
  );
$$;

-- Only answers about the caller themselves; RLS evaluates it as
-- `authenticated`, so that role keeps EXECUTE.
revoke execute on function public.is_linked_doctor(uuid) from public, anon;
grant execute on function public.is_linked_doctor(uuid) to authenticated, service_role;

alter table public.referrals enable row level security;

create policy "referrals read for referring doctor"
  on public.referrals for select
  to authenticated
  using (public.is_linked_doctor(referring_doctor_id));

create policy "referrals read for receiving doctor"
  on public.referrals for select
  to authenticated
  using (
    public.is_linked_doctor(referred_to_doctor_id)
    and (
      status = 'completed'
      or (status in ('pending', 'accepted') and expires_at > now())
    )
  );

-- No INSERT/UPDATE/DELETE policies, and no such privileges either: browser
-- sessions only read, the server writes through the service role, and no
-- one deletes (withdraw a referral with status 'revoked'). Explicit, so the
-- table does not inherit the blanket grants from 20260813000013_grants.sql.
revoke all on table public.referrals from public, anon, authenticated, service_role;
grant select on table public.referrals to authenticated;
grant select, insert, update on table public.referrals to service_role;

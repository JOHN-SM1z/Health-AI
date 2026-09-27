-- Referral lifecycle hardening: bounded access, recorded expiry, a
-- tenant-safe audit trail.
--
-- WHEN A DOCTOR MAY SEE A PATIENT (public.doctor_patient_access, the one
-- decision behind RLS and the server):
--
--   Own relationship (not referral-based): the doctor has a live — not
--   cancelled — appointment with the patient, or wrote a clinical record for
--   them. Scope: the patient record, their own appointments, the records they
--   wrote. A booking that was cancelled no longer makes anyone "their" doctor.
--
--   Receiving doctor (B), referral-based, only while the referral is
--   pending / accepted / in_progress AND now() < expires_at:
--     pending              → patient record, the originating consultation;
--     accepted/in_progress → + the referring doctor's consultations.
--   Nothing referral-based once declined, revoked, completed or expired — at
--   the moment of the transition, and at expires_at even before the expiry
--   is recorded (the database clock is checked on every read). After
--   completion B keeps only what the own relationship gives them (their own
--   consultation for the referral and the records they wrote in it).
--
--   Referring doctor (A): the follow-up consultation their referral led to
--   while the referral is accepted / in_progress / completed AND
--   now() < expires_at — not after a revocation or expiry, and not forever.
--
--   No referral lasts longer than 180 days (the longest validity the product
--   offers), so no referral-based access is ever open-ended.
--
-- Changes:
--   1. referrals_expiry_window_check: at most 180 days (was 365).
--   2. doctor_patient_access(): own relationship excludes cancelled-only
--      bookings; the referrer's follow-up access is bounded by status and
--      expiry. doctor_can_read_appointment(): own appointments only with an
--      own relationship (server parity: canSeeAppointment).
--   3. Receiving doctor's read policy on referrals: completed referrals only
--      until expires_at.
--   4. expire_due_referrals(): records every lapsed open referral as expired
--      (audited 'referral_expired', actor: system). Called by the scheduled
--      /api/referrals/expire job and lazily on reads.
--   5. Clinical text is server-only: signed-in roles lose direct SELECT on
--      referrals and clinical_records, so every read goes through the
--      authorizing, audited API. The RLS policies stay as a backstop.
--   6. audit_events: patient_id and referral_id columns (every referral and
--      clinical-record event names clinic, actor, patient, referral, action,
--      time); a guard that keeps each row inside its clinic's tenant (the
--      patient and referral must belong to clinic_id) and stamps the
--      database time; append-only (no UPDATE/DELETE for any API role).
--
-- Reversible: restore the functions/policies from 20260928000002 and
-- 20260927000004, the 365-day check, the grants (grant select on referrals,
-- clinical_records to authenticated; grant update, delete on audit_events to
-- authenticated, service_role); drop expire_due_referrals(),
-- audit_events_guard() and the new audit columns/indexes.

-- ---------- 1. Validity window ----------

alter table public.referrals drop constraint referrals_expiry_window_check;
alter table public.referrals
  add constraint referrals_expiry_window_check
  check (expires_at > created_at and expires_at <= created_at + interval '180 days');

-- ---------- 2. The decision ----------

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
    -- Own relationship: a live appointment, or a record the doctor wrote.
    exists (
      select 1
      from public.appointments a
      where a.clinic_id = d.clinic_id
        and a.patient_id = p.id
        and a.doctor_id = d.id
        and a.status <> 'cancelled'
    )
    or exists (
      select 1
      from public.clinical_records cr
      where cr.clinic_id = d.clinic_id
        and cr.patient_id = p.id
        and cr.author_doctor_id = d.id
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
      -- The consultation an open referral to this doctor was raised from…
      select r.originating_appointment_id
      from public.referrals r
      where r.clinic_id = d.clinic_id
        and r.patient_id = p.id
        and r.referred_to_doctor_id = d.id
        and r.status in ('pending', 'accepted', 'in_progress')
        and r.expires_at > now()
      union
      -- …and the follow-up of a referral this doctor made, while it stands.
      select r.follow_up_appointment_id
      from public.referrals r
      where r.clinic_id = d.clinic_id
        and r.patient_id = p.id
        and r.referring_doctor_id = d.id
        and r.follow_up_appointment_id is not null
        and r.status in ('accepted', 'in_progress', 'completed')
        and r.expires_at > now()
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

comment on function public.doctor_patient_access(uuid, uuid) is
  'What an active doctor may see of a patient (see 20260929000001): own relationship (live appointment or authored record); open, unexpired referrals to them; referring doctors whose visits accepted/in-progress referrals share; referral-linked appointments (originating consultation for the receiver, follow-up for the referrer — both bounded by status and expires_at). No row = no access. Server-only.';

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
set search_path = public
as $$
  select exists (
    select 1
    from public.doctor_patient_access(public.current_doctor_id(p_clinic_id), p_patient_id) x
    where (x.own_patient and p_doctor_id = public.current_doctor_id(p_clinic_id))
       or p_doctor_id = any (x.history_doctor_ids)
       or p_appointment_id = any (x.referral_appointment_ids)
  );
$$;

-- ---------- 3. The receiving doctor's view of the referral itself ----------

drop policy if exists "referrals read for receiving doctor" on public.referrals;
create policy "referrals read for receiving doctor"
  on public.referrals for select
  to authenticated
  using (
    public.is_linked_doctor(referred_to_doctor_id)
    and status in ('pending', 'accepted', 'in_progress', 'completed')
    and expires_at > now()
  );

-- ---------- 4. Recording expiry ----------

-- Access already ends at expires_at (every check compares with now()); this
-- records it: status 'expired' and a 'referral_expired' audit row by the
-- system. Idempotent; the database clock decides, never the caller's.
create or replace function public.expire_due_referrals(p_clinic_id uuid default null)
returns integer
language sql
volatile
security invoker
set search_path = public
as $$
  with expired as (
    update public.referrals
       set status = 'expired'
     where status in ('pending', 'accepted', 'in_progress')
       and expires_at <= now()
       and (p_clinic_id is null or clinic_id = p_clinic_id)
    returning 1
  )
  select count(*)::integer from expired;
$$;

revoke all on function public.expire_due_referrals(uuid) from public, anon, authenticated;
grant execute on function public.expire_due_referrals(uuid) to service_role;

-- ---------- 5. Clinical text is read through the server only ----------

-- The API authorizes every read with doctor_patient_access() and audits it;
-- a signed-in session reading these tables directly would be neither. The
-- policies remain as a backstop should a grant ever be re-added.
revoke select on table public.referrals from authenticated;
revoke all on table public.clinical_records from authenticated;

-- ---------- 6. Audit trail ----------

alter table public.audit_events
  add column patient_id uuid,
  add column referral_id uuid;

comment on column public.audit_events.patient_id is
  'The patient the event concerns (same clinic as clinic_id, checked on insert). Ids only — never clinical text.';
comment on column public.audit_events.referral_id is
  'The referral the event concerns (same clinic and patient, checked on insert).';

create index audit_events_patient_idx
  on public.audit_events (clinic_id, patient_id, created_at desc)
  where patient_id is not null;
create index audit_events_referral_idx
  on public.audit_events (clinic_id, referral_id, created_at desc)
  where referral_id is not null;

create or replace function public.audit_events_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- The database clock, never a caller-supplied time.
  new.created_at := now();
  if new.patient_id is not null and not exists (
       select 1 from public.patients p where p.id = new.patient_id and p.clinic_id = new.clinic_id
     ) then
    raise exception 'audit: patient % is not in clinic %', new.patient_id, new.clinic_id;
  end if;
  if new.referral_id is not null and not exists (
       select 1 from public.referrals r
       where r.id = new.referral_id
         and r.clinic_id = new.clinic_id
         and (new.patient_id is null or r.patient_id = new.patient_id)
     ) then
    raise exception 'audit: referral % is not in clinic % for that patient', new.referral_id, new.clinic_id;
  end if;
  return new;
end;
$$;

revoke execute on function public.audit_events_guard() from public, anon, authenticated;

drop trigger if exists audit_events_guard on public.audit_events;
create trigger audit_events_guard
  before insert on public.audit_events
  for each row execute function public.audit_events_guard();

-- Append-only for every API role: rows are written once (service role, and
-- the audit triggers) and read by the clinic's management (RLS). Clinic
-- deletion still cascades (performed as the table owner).
revoke insert, update, delete, truncate on table public.audit_events from anon, authenticated;
revoke update, delete, truncate on table public.audit_events from service_role;

-- Referral events carry the patient and referral as columns; expiry is the
-- system's act (actor null, actor_type 'system').
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

-- Clinical record events carry the patient, and the referral when the record
-- was written in a referral's consultation.
create or replace function public.clinical_records_audit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_referral uuid;
begin
  select r.id into v_referral
    from public.referrals r
   where r.clinic_id = new.clinic_id
     and r.patient_id = new.patient_id
     and r.follow_up_appointment_id = new.appointment_id
   order by r.created_at desc
   limit 1;

  insert into public.audit_events (
    clinic_id, actor_id, actor_type, action, entity_type, entity_id,
    patient_id, referral_id, old_values, new_values
  ) values (
    new.clinic_id,
    new.created_by,
    'staff'::public.actor_type,
    case when new.corrects_record_id is null then 'clinical_record_created' else 'clinical_record_corrected' end,
    'clinical_records',
    new.id::text,
    new.patient_id,
    v_referral,
    null,
    jsonb_build_object(
      'record_type', new.record_type,
      'patient_id', new.patient_id,
      'author_doctor_id', new.author_doctor_id,
      'appointment_id', new.appointment_id,
      'corrects_record_id', new.corrects_record_id
    )
  );
  return new;
end;
$$;

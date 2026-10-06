-- Clinical record governance: author-only versioned corrections, and a
-- patient lifecycle that never destroys clinical, booking or payment records.
--
-- 1. Versions. clinical_records already stored a correction as a new row
--    pointing at the one it corrects (at most one per row, so every record's
--    history is a straight line). Each row now also carries its version
--    number and the id of the first version (its lineage), both set here and
--    never by the caller:
--      * version 1 is an original; a correction of version n is n + 1;
--      * the current version is the one no row corrects; every earlier one
--        is superseded — kept unchanged, never updated or deleted;
--      * a correction must be of the CURRENT version: correcting an already
--        corrected version fails with SQLSTATE CRVER (the server's
--        VERSION_CONFLICT), and two concurrent corrections of the same
--        version cannot both land (unique indexes on corrects_record_id and
--        on (root_record_id, version)).
--
-- 2. Author-only corrections, bound to the person. Before, a correction had
--    to name the same doctor record as the original; a doctor record can be
--    re-linked to a different login, which would have let the new login
--    correct the old one's records. A correction now also needs the same
--    created_by (login) as the version it corrects — SQLSTATE CRNOT (the
--    server's CLINICAL_RECORD_NOT_OWNED) otherwise. A different doctor who
--    disagrees writes their own record in their own consultation. And a
--    doctor record whose clinical records another login wrote can no longer
--    be re-linked to a new login at all (SQLSTATE CRLNK): the new person gets
--    a new doctor record, so no one ever writes under, or is shown as,
--    someone else's authorship.
--
-- 3. The correction audit row names both versions: previous record id and
--    version, new version, lineage, and the original author (ids only —
--    never clinical text).
--
-- 4. Deleting a patient no longer cascades into clinical records, referrals,
--    appointments or payments. Each of those has its own lifecycle
--    (retention, anonymisation) that a person decides; a patient that still
--    has any of them cannot be deleted at all. The foreign keys are NO ACTION
--    rather than RESTRICT so that deleting a whole clinic (which cascades to
--    its patients AND to all of these tables in the same statement) still
--    works. Conversations still cascade: communications are not part of this
--    change (see TASKS.md). A payment still belongs to its appointment
--    (payments_appointment_id_fkey cascades): deleting an appointment — which
--    nothing in the application does — removes its payment.
--
-- 5. public.clinical_record_versions: every version with its status
--    (current / superseded) — the server's history view reads it.
--
-- 6. public.retention_policies: where a clinic records, per data category,
--    the retention rule its confirmed legal policy sets. It is empty — no
--    period is assumed — and nothing deletes or anonymises anything on its
--    basis yet: that job is built once the policy is confirmed.
--
-- Reversible: drop the view, retention_policies and its types; restore
-- clinical_records_validate() from 20260927000005 (+ search_path from
-- 20260930000006) and clinical_records_audit() from 20260929000001; drop
-- trigger doctors_keep_record_authors and its function; drop the
-- version/root_record_id columns, their constraints and index; re-create the
-- four patient foreign keys with ON DELETE CASCADE.

-- ---------------------------------------------------------------------------
-- 1. Version and lineage columns
-- ---------------------------------------------------------------------------

alter table public.clinical_records
  add column version integer,
  add column root_record_id uuid;

comment on column public.clinical_records.version is
  'Version number within the record''s lineage: 1 for an original, n + 1 for a correction of version n. Set by the database.';
comment on column public.clinical_records.root_record_id is
  'The first version of this record (itself for an original). Set by the database.';

-- Backfill the chains that already exist. The validate trigger refuses every
-- UPDATE, so it is switched off for exactly this statement.
alter table public.clinical_records disable trigger clinical_records_validate;

with recursive lineage as (
  select id, id as root_id, 1 as version
  from public.clinical_records
  where corrects_record_id is null
  union all
  select c.id, l.root_id, l.version + 1
  from public.clinical_records c
  join lineage l on c.corrects_record_id = l.id
)
update public.clinical_records r
   set version = l.version, root_record_id = l.root_id
  from lineage l
 where l.id = r.id;

alter table public.clinical_records enable trigger clinical_records_validate;

-- The trigger always sets both; the defaults only keep the insert contract
-- honest (the caller never supplies them). A placeholder root can never
-- stand: it must reference an existing record (foreign key below).
alter table public.clinical_records
  alter column version set default 1,
  alter column root_record_id set default gen_random_uuid(),
  alter column version set not null,
  alter column root_record_id set not null,
  add constraint clinical_records_version_check
    check (
      version >= 1
      and (corrects_record_id is null) = (version = 1)
      and (version > 1 or root_record_id = id)
    ),
  add constraint clinical_records_root_fkey
    foreign key (root_record_id, clinic_id) references public.clinical_records (id, clinic_id);

create unique index clinical_records_lineage_version_key
  on public.clinical_records (root_record_id, version);

-- ---------------------------------------------------------------------------
-- 2. Validation: provenance, consultation state, author-only versioning
-- ---------------------------------------------------------------------------

create or replace function public.clinical_records_validate()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_profile uuid;
  v_active boolean;
  v_status public.appointment_status;
  v_target public.clinical_records;
begin
  if tg_op = 'UPDATE' then
    raise exception 'clinical record: records cannot be edited; add a correction instead';
  end if;

  new.created_at := now();

  select d.profile_id, d.active
    into v_profile, v_active
  from public.doctors d
  where d.id = new.author_doctor_id
    and d.clinic_id = new.clinic_id;
  if not found or not v_active then
    raise exception 'clinical record: the author must be an active doctor of the clinic';
  end if;
  if v_profile is null or new.created_by is distinct from v_profile then
    raise exception 'clinical record: created_by must be the author''s own doctor account';
  end if;
  if not exists (
    select 1
    from public.staff_roles sr
    where sr.profile_id = v_profile
      and sr.clinic_id = new.clinic_id
      and sr.role = 'doctor'
  ) then
    raise exception 'clinical record: the author does not hold the doctor role';
  end if;

  -- The foreign key pins the consultation to the author and the patient;
  -- here it must also actually be taking or have taken place.
  select a.status into v_status
  from public.appointments a
  where a.id = new.appointment_id
    and a.clinic_id = new.clinic_id
    and a.patient_id = new.patient_id
    and a.doctor_id = new.author_doctor_id;
  if found and v_status not in ('in_progress', 'completed') then
    raise exception 'clinical record: the consultation must be in progress or completed (it is %)', v_status;
  end if;

  if new.corrects_record_id is null then
    new.version := 1;
    new.root_record_id := new.id;
    return new;
  end if;

  select * into v_target from public.clinical_records where id = new.corrects_record_id;
  -- Same clinic, same patient, same doctor record AND the same login that
  -- wrote the version being corrected: a re-linked doctor record does not
  -- hand its records to the new login.
  if not found
     or v_target.clinic_id <> new.clinic_id
     or v_target.patient_id <> new.patient_id
     or v_target.author_doctor_id <> new.author_doctor_id
     or v_target.created_by <> new.created_by then
    raise exception using
      errcode = 'CRNOT',
      message = 'clinical record: only the author can correct their own record of the same patient';
  end if;
  if v_target.appointment_id <> new.appointment_id or v_target.record_type <> new.record_type then
    raise exception 'clinical record: a correction keeps the consultation and the record type of the record it corrects';
  end if;
  -- Only the current version can be corrected. A concurrent correction of
  -- the same version that commits first is caught by the unique indexes.
  if exists (select 1 from public.clinical_records c where c.corrects_record_id = v_target.id) then
    raise exception using
      errcode = 'CRVER',
      message = 'clinical record: this version has already been corrected';
  end if;

  new.version := v_target.version + 1;
  new.root_record_id := v_target.root_record_id;
  return new;
end;
$$;

revoke all on function public.clinical_records_validate() from public, anon, authenticated;

-- A doctor record keeps its authors: once another login's clinical records
-- are filed under it, it can't be re-linked to a different login. Unlinking
-- (NULL) and re-linking the records' own author stay possible.
create or replace function public.doctors_keep_record_authors()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.profile_id is not null
     and new.profile_id is distinct from old.profile_id
     and exists (
       select 1
       from public.clinical_records cr
       where cr.author_doctor_id = old.id
         and cr.clinic_id = old.clinic_id
         and cr.created_by <> new.profile_id
     ) then
    raise exception using
      errcode = 'CRLNK',
      message = 'doctor: this doctor record holds clinical records written by another account; create a new doctor record for this account';
  end if;
  return new;
end;
$$;

revoke all on function public.doctors_keep_record_authors() from public, anon, authenticated;

create trigger doctors_keep_record_authors
  before update of profile_id on public.doctors
  for each row execute function public.doctors_keep_record_authors();

-- ---------------------------------------------------------------------------
-- 3. Audit: a correction names both versions (ids and numbers only)
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
    case when new.corrects_record_id is null then 'clinical_record_created' else 'clinical_record_corrected' end,
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

-- ---------------------------------------------------------------------------
-- 4. Deleting a patient never cascades into clinical, referral, booking or
--    payment records
-- ---------------------------------------------------------------------------

alter table public.clinical_records
  drop constraint clinical_records_patient_same_clinic_fkey,
  add constraint clinical_records_patient_same_clinic_fkey
    foreign key (patient_id, clinic_id) references public.patients (id, clinic_id) on delete no action;

alter table public.referrals
  drop constraint referrals_patient_same_clinic_fkey,
  add constraint referrals_patient_same_clinic_fkey
    foreign key (patient_id, clinic_id) references public.patients (id, clinic_id) on delete no action;

alter table public.appointments
  drop constraint appointments_patient_id_fkey,
  add constraint appointments_patient_id_fkey
    foreign key (patient_id, clinic_id) references public.patients (id, clinic_id) on delete no action;

alter table public.payments
  drop constraint payments_patient_id_fkey,
  add constraint payments_patient_id_fkey
    foreign key (patient_id, clinic_id) references public.patients (id, clinic_id) on delete no action;

-- ---------------------------------------------------------------------------
-- 5. Every version with its status
-- ---------------------------------------------------------------------------

create view public.clinical_record_versions
with (security_invoker = true)
as
select
  r.id,
  r.clinic_id,
  r.patient_id,
  r.author_doctor_id,
  r.created_by,
  r.appointment_id,
  r.record_type,
  r.summary,
  r.details,
  r.code,
  r.root_record_id,
  r.version,
  r.corrects_record_id,
  r.created_at,
  s.id as superseded_by_record_id,
  s.created_at as superseded_at,
  case when s.id is null then 'current' else 'superseded' end as status
from public.clinical_records r
left join public.clinical_records s on s.corrects_record_id = r.id;

comment on view public.clinical_record_versions is
  'Every version of every clinical record with its status: current (no later version) or superseded. Server-only, like clinical_records.';

revoke all on table public.clinical_record_versions from public, anon, authenticated, service_role;
grant select on table public.clinical_record_versions to service_role;

-- ---------------------------------------------------------------------------
-- 6. Retention rules, per clinic and data category — none assumed
-- ---------------------------------------------------------------------------

create type public.retention_data_category as enum (
  'patient_identity',
  'bookings',
  'payments',
  'communications',
  'clinical_records',
  'audit_records'
);

create type public.retention_action as enum ('review', 'anonymize', 'delete');

create table public.retention_policies (
  clinic_id uuid not null references public.clinics(id) on delete cascade,
  data_category public.retention_data_category not null,
  -- How long the category is kept after it stops being in use. NULL: kept
  -- until a person decides otherwise.
  retain_for interval,
  -- What happens when the period ends: a person reviews it, or the data is
  -- anonymised or deleted.
  on_expiry public.retention_action not null default 'review',
  -- The confirmed legal or clinic policy this rule implements.
  policy_reference text not null,
  confirmed_by uuid references public.profiles(id),
  confirmed_at timestamptz not null default now(),
  primary key (clinic_id, data_category),
  constraint retention_policies_period_check check (retain_for is null or retain_for > interval '0'),
  constraint retention_policies_reference_check check (policy_reference ~ '\S' and char_length(policy_reference) <= 1000)
);

comment on table public.retention_policies is
  'Retention rule per clinic and data category, as set by the clinic''s confirmed legal policy. Empty by default: no period is assumed, and nothing is deleted or anonymised on its basis until a retention job is built for a confirmed policy.';

alter table public.retention_policies enable row level security;

revoke all on table public.retention_policies from public, anon, authenticated, service_role;
grant select, insert, update on table public.retention_policies to service_role;

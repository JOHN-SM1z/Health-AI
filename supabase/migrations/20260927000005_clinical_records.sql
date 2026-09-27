-- Doctor-authored clinical records.
--
-- Doctors document their own consultations: consultation notes, diagnoses,
-- prescriptions, laboratory results and medical history. Every record keeps
-- its provenance — the authoring doctor, the consultation (appointment) it
-- was written in, the time and the record type — and none of it can come
-- from the browser:
--
--   * a record belongs to exactly one consultation, and the composite
--     foreign key makes that the AUTHOR'S OWN appointment with THIS patient
--     in THIS clinic, so a doctor can never file a record under another
--     doctor's name, another patient or another clinic;
--   * the consultation must be in progress or completed;
--   * created_by must be the author's own doctor account (active, doctor
--     role) and created_at is the database's clock;
--   * records are immutable: no signed-in role may write at all, and even
--     the server may only insert. A mistake is fixed by a correction — a new
--     record by the same author, in the same consultation, pointing at the
--     one it corrects (at most one correction per record);
--   * every insert is audited WITHOUT its clinical text.
--
-- Who may read a record is exactly who may read the consultation it belongs
-- to — public.doctor_can_read_appointment(), i.e. the Phase 3 decision
-- public.doctor_patient_access(): the author (their own patient); a doctor
-- the patient is referred to, for the referring doctor's records while the
-- referral is accepted and unexpired (and the records of the consultation it
-- was raised from while it is active); the referring doctor, for the
-- records of the follow-up visit their referral led to. Nobody else: no
-- operational staff role, no other doctor, no patient-facing path, no AI.

create type public.clinical_record_type as enum (
  'consultation_note',
  'diagnosis',
  'prescription',
  'lab_result',
  'medical_history'
);

create table public.clinical_records (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete cascade,
  patient_id uuid not null,
  author_doctor_id uuid not null,
  -- The consultation the record was written in.
  appointment_id uuid not null,
  record_type public.clinical_record_type not null,
  -- Diagnosis, medication and dose, test and result, history item, or the
  -- note's headline.
  summary text not null,
  details text,
  -- Optional classification code, e.g. ICD-10 for a diagnosis.
  code text,
  corrects_record_id uuid references public.clinical_records(id),
  created_by uuid not null references public.profiles(id),
  -- Client idempotency key: a repeated submission resolves to this record.
  creation_key uuid,
  created_at timestamptz not null default now(),

  constraint clinical_records_patient_same_clinic_fkey
    foreign key (patient_id, clinic_id) references public.patients (id, clinic_id) on delete cascade,
  constraint clinical_records_author_same_clinic_fkey
    foreign key (author_doctor_id, clinic_id) references public.doctors (id, clinic_id),
  -- The author's own consultation with this patient in this clinic.
  constraint clinical_records_consultation_fkey
    foreign key (appointment_id, clinic_id, patient_id, author_doctor_id)
    references public.appointments (id, clinic_id, patient_id, doctor_id),
  constraint clinical_records_summary_check
    check (summary ~ '\S' and char_length(summary) <= 300),
  constraint clinical_records_details_check
    check (details is null or (details ~ '\S' and char_length(details) <= 4000)),
  constraint clinical_records_code_check
    check (code is null or code ~ '^[A-Za-z0-9.\-]{1,16}$'),
  constraint clinical_records_not_self_correction
    check (corrects_record_id is null or corrects_record_id <> id)
);

comment on table public.clinical_records is
  'Doctor-authored clinical records with provenance (author, consultation, time, type). Immutable; corrections are new records. Readable only by doctors doctor_can_read_appointment() admits; never by operational staff, patients or AI.';

create index clinical_records_patient_idx on public.clinical_records (clinic_id, patient_id, created_at desc);
create index clinical_records_author_idx on public.clinical_records (author_doctor_id, created_at desc);
create index clinical_records_appointment_idx on public.clinical_records (appointment_id);
create unique index clinical_records_one_correction on public.clinical_records (corrects_record_id)
  where corrects_record_id is not null;
create unique index clinical_records_creation_key_key on public.clinical_records (clinic_id, author_doctor_id, creation_key)
  where creation_key is not null;

-- ---------------------------------------------------------------------------
-- Validation: provenance, consultation state, immutability
-- ---------------------------------------------------------------------------

create or replace function public.clinical_records_validate()
returns trigger
language plpgsql
security definer
set search_path = public
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

  if new.corrects_record_id is not null then
    select * into v_target from public.clinical_records where id = new.corrects_record_id;
    if not found
       or v_target.clinic_id <> new.clinic_id
       or v_target.patient_id <> new.patient_id
       or v_target.author_doctor_id <> new.author_doctor_id then
      raise exception 'clinical record: only the author can correct their own record of the same patient';
    end if;
    if v_target.appointment_id <> new.appointment_id or v_target.record_type <> new.record_type then
      raise exception 'clinical record: a correction keeps the consultation and the record type of the record it corrects';
    end if;
  end if;

  return new;
end;
$$;

create trigger clinical_records_validate
  before insert or update on public.clinical_records
  for each row execute function public.clinical_records_validate();

-- ---------------------------------------------------------------------------
-- Audit: ids and type only — never the clinical text
-- ---------------------------------------------------------------------------

create or replace function public.clinical_records_audit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.audit_events (
    clinic_id, actor_id, actor_type, action, entity_type, entity_id, old_values, new_values
  ) values (
    new.clinic_id,
    new.created_by,
    'staff'::public.actor_type,
    case when new.corrects_record_id is null then 'clinical_record_created' else 'clinical_record_corrected' end,
    'clinical_records',
    new.id::text,
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

create trigger clinical_records_audit
  after insert on public.clinical_records
  for each row execute function public.clinical_records_audit();

-- ---------------------------------------------------------------------------
-- Access: authorized doctors read; only the server inserts
-- ---------------------------------------------------------------------------

alter table public.clinical_records enable row level security;

create policy "clinical records read for authorized doctors" on public.clinical_records
  for select to authenticated
  using (public.doctor_can_read_appointment(clinic_id, patient_id, author_doctor_id, appointment_id));

revoke all on table public.clinical_records from public, anon, authenticated, service_role;
grant select on table public.clinical_records to authenticated;
grant select, insert on table public.clinical_records to service_role;

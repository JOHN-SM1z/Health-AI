-- 0032: Clinical referral data model (Phase 1).
--
-- Adds the referrals table to model doctor-to-doctor clinical handoffs:
--   Doctor A (referring) -> Patient -> Doctor B (referred_to)
--
-- Strict tenancy & integrity:
--   * clinic_id scopes every referral row.
--   * DB trigger referrals_check_same_clinic() verifies that referring doctor,
--     receiving doctor, patient, and optional originating appointment all belong
--     to the same clinic as referrals.clinic_id.
--   * Check constraint prevents self-referrals (referring <> referred_to).
--   * DB trigger referrals_validate_status_transition() verifies legitimate
--     status transitions and enforces required timestamp / revocation fields.
--   * Automatic change tracking via audit_track_changes() preserves full auditability.

-- ---------- 1. Enum types ----------

do $$
begin
  if not exists (select 1 from pg_type where typname = 'referral_status') then
    create type public.referral_status as enum (
      'pending',
      'accepted',
      'completed',
      'declined',
      'expired',
      'revoked'
    );
  end if;
end $$;

do $$
begin
  if not exists (select 1 from pg_type where typname = 'referral_priority') then
    create type public.referral_priority as enum (
      'routine',
      'urgent',
      'emergency'
    );
  end if;
end $$;

-- ---------- 2. referrals table ----------

create table if not exists public.referrals (
  id                          uuid primary key default gen_random_uuid(),
  clinic_id                   uuid not null references public.clinics(id) on delete cascade,
  patient_id                  uuid not null references public.patients(id) on delete cascade,
  referring_doctor_id         uuid not null references public.doctors(id) on delete restrict,
  referred_to_doctor_id       uuid not null references public.doctors(id) on delete restrict,

  -- Optional link to the originating consultation / appointment in the existing booking model.
  originating_appointment_id  uuid references public.appointments(id) on delete set null,

  -- Clinical reason for referral and detailed handoff note
  referral_reason             text not null check (char_length(referral_reason) between 1 and 1000),
  clinical_handoff_note       text check (clinical_handoff_note is null or char_length(clinical_handoff_note) <= 10000),

  priority                    public.referral_priority not null default 'routine',
  status                      public.referral_status not null default 'pending',

  -- Timestamps
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now(),
  accepted_at                 timestamptz,
  completed_at                timestamptz,
  expires_at                  timestamptz,

  -- Revocation information
  revoked_at                  timestamptz,
  revocation_reason           text check (revocation_reason is null or char_length(revocation_reason) <= 1000),
  revoked_by                  uuid references public.profiles(id) on delete set null,

  -- Audit actors
  created_by                  uuid references public.profiles(id) on delete set null,
  updated_by                  uuid references public.profiles(id) on delete set null,

  -- Idempotency protection
  idempotency_key             text check (idempotency_key is null or char_length(idempotency_key) <= 128),

  -- Constraint: Self-referral rejection
  constraint referrals_distinct_doctors
    check (referring_doctor_id <> referred_to_doctor_id)
);

-- ---------- 3. Indexes ----------
-- Explicit indexes required for clinic_id, patient_id, referring_doctor_id, referred_to_doctor_id, status

create index if not exists referrals_clinic_id_idx
  on public.referrals (clinic_id);

create index if not exists referrals_patient_id_idx
  on public.referrals (patient_id);

create index if not exists referrals_referring_doctor_id_idx
  on public.referrals (referring_doctor_id);

create index if not exists referrals_referred_to_doctor_id_idx
  on public.referrals (referred_to_doctor_id);

create index if not exists referrals_status_idx
  on public.referrals (status);

create index if not exists referrals_clinic_status_idx
  on public.referrals (clinic_id, status);

create index if not exists referrals_originating_appointment_idx
  on public.referrals (originating_appointment_id)
  where originating_appointment_id is not null;

create unique index if not exists referrals_clinic_idempotency_key_idx
  on public.referrals (clinic_id, idempotency_key)
  where idempotency_key is not null;

-- ---------- 4. Tenant isolation trigger ----------
-- Enforces that patient, referring doctor, receiving doctor, and optional
-- originating appointment all belong to the same clinic as referrals.clinic_id.

create or replace function public.referrals_check_same_clinic()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_referring_clinic   uuid;
  v_receiving_clinic   uuid;
  v_patient_clinic     uuid;
  v_appointment_clinic uuid;
  v_apt_patient        uuid;
  v_apt_doctor         uuid;
begin
  select clinic_id into v_referring_clinic
    from public.doctors where id = new.referring_doctor_id;

  select clinic_id into v_receiving_clinic
    from public.doctors where id = new.referred_to_doctor_id;

  select clinic_id into v_patient_clinic
    from public.patients where id = new.patient_id;

  if v_referring_clinic is null then
    raise exception 'referrals: referring doctor % does not exist', new.referring_doctor_id;
  end if;

  if v_receiving_clinic is null then
    raise exception 'referrals: receiving doctor % does not exist', new.referred_to_doctor_id;
  end if;

  if v_patient_clinic is null then
    raise exception 'referrals: patient % does not exist', new.patient_id;
  end if;

  if v_referring_clinic <> new.clinic_id
     or v_receiving_clinic <> new.clinic_id
     or v_patient_clinic   <> new.clinic_id then
    raise exception
      'referrals: referring_doctor, receiving_doctor, and patient must all belong to clinic %',
      new.clinic_id;
  end if;

  if new.originating_appointment_id is not null then
    select clinic_id, patient_id, doctor_id
      into v_appointment_clinic, v_apt_patient, v_apt_doctor
      from public.appointments
     where id = new.originating_appointment_id;

    if v_appointment_clinic is null then
      raise exception 'referrals: originating appointment % does not exist', new.originating_appointment_id;
    end if;

    if v_appointment_clinic <> new.clinic_id then
      raise exception 'referrals: originating appointment belongs to different clinic %', v_appointment_clinic;
    end if;

    if v_apt_patient <> new.patient_id then
      raise exception 'referrals: originating appointment patient % does not match referral patient %',
        v_apt_patient, new.patient_id;
    end if;

    if v_apt_doctor <> new.referring_doctor_id then
      raise exception 'referrals: originating appointment doctor % does not match referring doctor %',
        v_apt_doctor, new.referring_doctor_id;
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists referrals_check_same_clinic on public.referrals;
create trigger referrals_check_same_clinic
  before insert or update on public.referrals
  for each row execute function public.referrals_check_same_clinic();

-- ---------- 5. Status transition validation trigger ----------

create or replace function public.referrals_validate_status_transition()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    if new.status <> 'pending'::public.referral_status then
      raise exception 'referrals: new referrals must be created with status pending, got %', new.status;
    end if;
    return new;
  end if;

  -- On UPDATE: validate state transitions
  if old.status = new.status then
    return new;
  end if;

  case old.status
    when 'pending'::public.referral_status then
      if new.status = 'accepted'::public.referral_status then
        if new.accepted_at is null then
          new.accepted_at := now();
        end if;
      elsif new.status = 'declined'::public.referral_status then
        null;
      elsif new.status = 'revoked'::public.referral_status then
        if new.revoked_at is null then
          new.revoked_at := now();
        end if;
      elsif new.status = 'expired'::public.referral_status then
        null;
      else
        raise exception 'referrals: invalid transition from pending to %', new.status;
      end if;

    when 'accepted'::public.referral_status then
      if new.status = 'completed'::public.referral_status then
        if new.completed_at is null then
          new.completed_at := now();
        end if;
      elsif new.status = 'revoked'::public.referral_status then
        if new.revoked_at is null then
          new.revoked_at := now();
        end if;
      elsif new.status = 'expired'::public.referral_status then
        null;
      else
        raise exception 'referrals: invalid transition from accepted to %', new.status;
      end if;

    when 'completed'::public.referral_status then
      raise exception 'referrals: cannot transition from terminal status completed';

    when 'declined'::public.referral_status then
      raise exception 'referrals: cannot transition from terminal status declined';

    when 'revoked'::public.referral_status then
      raise exception 'referrals: cannot transition from terminal status revoked';

    when 'expired'::public.referral_status then
      raise exception 'referrals: cannot transition from terminal status expired';

    else
      raise exception 'referrals: unrecognized status %', old.status;
  end case;

  return new;
end;
$$;

drop trigger if exists referrals_validate_status_transition on public.referrals;
create trigger referrals_validate_status_transition
  before insert or update on public.referrals
  for each row execute function public.referrals_validate_status_transition();

-- ---------- 6. updated_at and audit triggers ----------

drop trigger if exists referrals_set_updated_at on public.referrals;
create trigger referrals_set_updated_at
  before update on public.referrals
  for each row execute function public.set_updated_at();

drop trigger if exists referrals_audit on public.referrals;
create trigger referrals_audit
  after insert or update or delete on public.referrals
  for each row execute function public.audit_track_changes();

-- ---------- 7. Row Level Security ----------

alter table public.referrals enable row level security;

-- Management and reception staff can read all referrals in their clinic
create policy "referrals read for management and reception"
  on public.referrals for select
  to authenticated
  using (public.is_clinic_staff(clinic_id, array[
    'owner'::public.staff_role,
    'admin'::public.staff_role,
    'manager'::public.staff_role,
    'receptionist'::public.staff_role
  ]));

-- Referring and referred-to doctors can read their own referrals
create policy "referrals read for involved doctors"
  on public.referrals for select
  to authenticated
  using (exists (
    select 1 from public.doctors d
    where d.profile_id = auth.uid()
      and d.clinic_id = referrals.clinic_id
      and (d.id = referrals.referring_doctor_id
           or d.id = referrals.referred_to_doctor_id)
  ));

-- Doctors and staff can insert referrals within their own clinic
create policy "referrals insert for clinic staff"
  on public.referrals for insert
  to authenticated
  with check (
    public.is_clinic_staff(clinic_id, array[
      'owner'::public.staff_role,
      'admin'::public.staff_role,
      'manager'::public.staff_role,
      'receptionist'::public.staff_role,
      'doctor'::public.staff_role
    ])
  );

-- Updating referrals (accept, decline, complete, revoke) is permitted for involved doctors or management
create policy "referrals update for involved doctor or management"
  on public.referrals for update
  to authenticated
  using (
    public.is_clinic_staff(clinic_id, array[
      'owner'::public.staff_role,
      'admin'::public.staff_role,
      'manager'::public.staff_role
    ])
    or exists (
      select 1 from public.doctors d
      where d.profile_id = auth.uid()
        and d.clinic_id = referrals.clinic_id
        and (d.id = referrals.referring_doctor_id
             or d.id = referrals.referred_to_doctor_id)
    )
  )
  with check (
    public.is_clinic_staff(clinic_id, array[
      'owner'::public.staff_role,
      'admin'::public.staff_role,
      'manager'::public.staff_role
    ])
    or exists (
      select 1 from public.doctors d
      where d.profile_id = auth.uid()
        and d.clinic_id = referrals.clinic_id
        and (d.id = referrals.referring_doctor_id
             or d.id = referrals.referred_to_doctor_id)
    )
  );

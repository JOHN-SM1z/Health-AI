-- 0005: Appointments and payments.
-- Double-booking protection lives HERE at the database level:
-- a partial exclusion constraint prevents any two ACTIVE appointments for
-- the same doctor from overlapping in time. Cancelled/no-show rows do not
-- block future slots. btree_gist provides the uuid equality operator.

create table public.appointments (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete cascade,
  patient_id uuid not null references public.patients(id) on delete cascade,
  doctor_id uuid not null references public.doctors(id) on delete restrict,
  service_id uuid not null references public.services(id) on delete restrict,
  start_at timestamptz not null,
  end_at timestamptz not null,
  status public.appointment_status not null default 'pending',
  source public.appointment_source not null default 'telegram_mini_app',
  notes text,
  cancelled_at timestamptz,
  cancelled_reason text,
  cancelled_by uuid references public.profiles(id) on delete set null,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (end_at > start_at),
  constraint no_overlapping_active_appointments exclude using gist (
    doctor_id with =,
    tstzrange(start_at, end_at, '[)') with &&
  ) where (status not in ('cancelled', 'no_show'))
);

-- One payment row per appointment. The row is created at booking time with
-- status 'unpaid' and transitions are audited.
create table public.payments (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete cascade,
  appointment_id uuid not null references public.appointments(id) on delete cascade,
  patient_id uuid not null references public.patients(id) on delete cascade,
  amount numeric(12, 2) not null check (amount >= 0),
  currency text not null default 'UZS',
  status public.payment_status not null default 'unpaid',
  provider public.payment_provider not null default 'manual',
  provider_reference text,
  payment_url text,
  paid_at timestamptz,
  paid_by uuid references public.profiles(id) on delete set null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (appointment_id)
);

create index appointments_clinic_start_idx on public.appointments (clinic_id, start_at);
create index appointments_doctor_start_idx on public.appointments (doctor_id, start_at);
create index appointments_patient_start_idx on public.appointments (patient_id, start_at);
create index appointments_status_idx on public.appointments (status);
create index payments_clinic_status_idx on public.payments (clinic_id, status);
create index payments_provider_ref_idx on public.payments (provider, provider_reference)
  where provider_reference is not null;
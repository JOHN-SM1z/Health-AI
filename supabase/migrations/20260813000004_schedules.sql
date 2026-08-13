-- 0004: Doctor schedules — working hours and time blocks

create table public.doctor_working_hours (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete cascade,
  doctor_id uuid not null references public.doctors(id) on delete cascade,
  -- ISO weekday: 1 = Monday ... 7 = Sunday
  weekday smallint not null check (weekday between 1 and 7),
  start_time time not null,
  end_time time not null,
  unique (doctor_id, weekday),
  check (end_time > start_time)
);

-- Blocks: breaks, absences, admin reservations, and walk-in capacity holds.
-- A block removes the covered range from available slots.
create table public.doctor_time_blocks (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete cascade,
  doctor_id uuid not null references public.doctors(id) on delete cascade,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  reason public.time_block_reason not null default 'absence',
  note text,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  check (ends_at > starts_at)
);

create index doctor_working_hours_doctor_idx on public.doctor_working_hours (doctor_id);
create index doctor_time_blocks_doctor_idx on public.doctor_time_blocks (doctor_id, starts_at, ends_at);
create index doctor_time_blocks_clinic_idx on public.doctor_time_blocks (clinic_id);
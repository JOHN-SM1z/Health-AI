-- 0003: Service catalog — specialties, services, doctors, doctor_services

create table public.specialties (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete cascade,
  name text not null,
  description text,
  sort_order int not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (clinic_id, name)
);

create table public.services (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete cascade,
  specialty_id uuid references public.specialties(id) on delete set null,
  name text not null,
  description text,
  duration_minutes int not null check (duration_minutes between 5 and 480),
  price numeric(12, 2) not null default 0 check (price >= 0),
  preparation_text text,
  active boolean not null default true,
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (clinic_id, name)
);

create table public.doctors (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete cascade,
  -- When set, this staff account can access the doctor dashboard.
  profile_id uuid references public.profiles(id) on delete set null,
  specialty_id uuid references public.specialties(id) on delete set null,
  name text not null,
  title text,
  bio text,
  photo_url text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Which services each doctor performs. If a doctor has no rows here,
-- they are treated as offering every active service of the clinic.
create table public.doctor_services (
  doctor_id uuid not null references public.doctors(id) on delete cascade,
  service_id uuid not null references public.services(id) on delete cascade,
  price_override numeric(12, 2) check (price_override is null or price_override >= 0),
  duration_override_minutes int check (duration_override_minutes is null or (duration_override_minutes between 5 and 480)),
  primary key (doctor_id, service_id)
);

create index services_clinic_active_idx on public.services (clinic_id, active);
create index doctors_clinic_active_idx on public.doctors (clinic_id, active);
create index doctors_specialty_idx on public.doctors (specialty_id);
create index specialties_clinic_idx on public.specialties (clinic_id);
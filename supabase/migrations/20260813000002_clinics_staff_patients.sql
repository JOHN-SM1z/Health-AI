-- 0002: Clinics, staff profiles, staff roles, patients

create table public.clinics (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique,
  timezone text not null default 'Asia/Tashkent',
  phone text,
  address text,
  email text,
  currency text not null default 'UZS',
  opening_hours jsonb not null default '{}'::jsonb,
  privacy_notice text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Staff members only. Patients are NOT Supabase Auth users; they are
-- identified by their verified Telegram identity in the patients table.
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text,
  phone text,
  avatar_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.staff_roles (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete cascade,
  profile_id uuid not null references public.profiles(id) on delete cascade,
  role public.staff_role not null,
  created_at timestamptz not null default now(),
  unique (clinic_id, profile_id)
);

create table public.patients (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete cascade,
  -- Verified Telegram identity. NULL only for walk-ins created by staff.
  telegram_user_id bigint,
  telegram_username text,
  telegram_first_name text,
  telegram_last_name text,
  full_name text,
  phone text,
  consent_given boolean not null default false,
  consent_given_at timestamptz,
  preferred_language text not null default 'uz',
  last_seen_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (clinic_id, telegram_user_id),
  check (consent_given_at is null or consent_given)
);

create index patients_telegram_idx on public.patients (telegram_user_id) where telegram_user_id is not null;
create index patients_clinic_idx on public.patients (clinic_id);
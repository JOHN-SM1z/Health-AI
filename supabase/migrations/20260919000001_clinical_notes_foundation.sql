-- Missing foundation for the existing clinician-authored history routes.
-- Authorized product scope: clinician entry only; no AI clinical access.
create table public.clinical_notes (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete restrict,
  patient_id uuid not null references public.patients(id) on delete restrict,
  doctor_id uuid not null references public.doctors(id) on delete restrict,
  appointment_id uuid references public.appointments(id) on delete restrict,
  title text not null check (char_length(title) between 1 and 200),
  content text not null check (char_length(content) between 1 and 10000),
  note_type text not null default 'clinical_note',
  is_private boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.clinical_notes enable row level security;
-- All access initially server-only; clinical authorization is installed later.
create index clinical_notes_patient_history_idx on public.clinical_notes(clinic_id,patient_id,created_at desc);

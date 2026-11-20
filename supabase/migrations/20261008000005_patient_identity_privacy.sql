-- Patient identity is stored in our database and used by the server; no employee reads it (owner decision 2026-10-08).
--
-- Before this migration every signed-in owner, admin, manager and receptionist could read document_number (passport/ID),
-- pinfl (JSHSHIR), date_of_birth and sex of every patient in their clinic with their own login token — straight from
-- PostgREST (/rest/v1/patients?select=document_number,…) and GraphQL — and a doctor could for their own and referred
-- patients. The screens masked these values, but the database did not: 20260813000013 granted table-wide SELECT to
-- `authenticated` and 20260930000002 only revoked the writes.
--
-- Owner decision: staff see a patient's NAME and PHONE (and clinical data where the existing clinical-access rules already
-- allow it). Passport/ID number, JSHSHIR, date of birth, sex and home address stay in our database and are used by the
-- server only — for the desk's lookup (passport/JSHSHIR + date of birth, compared on the server), duplicate checks,
-- age-specific lab reference ranges and the patient's own Mini App. Where clinical work needs it (lab result entry, the lab
-- queue, a merge preview) the server sends an AGE, never the date itself.
--
-- How: the same pattern as payments in 20261005000021 — revoke the table-wide SELECT and grant back only the columns a
-- signed-in screen reads today (src/app/admin/page.tsx, admin/appointments, admin/calendar, admin/conversations,
-- doctor/page.tsx: full_name, phone, telegram_username, telegram_first_name; id/clinic_id for the joins). A column added
-- later is invisible to signed-in roles until someone grants it on purpose. Row-level policies are unchanged; they still
-- decide WHICH patients a role sees. GraphQL (pg_graphql) follows the same column privileges.
--
-- Also adds patients.home_address (optional, ≤300 characters), never granted to any signed-in role.
--
-- Rollback: `grant select on public.patients to authenticated;` restores the old (leaking) behaviour; drop home_address only
-- if it holds no data.

alter table public.patients
  add column home_address text check (home_address is null or (home_address ~ '\S' and char_length(home_address) <= 300));

comment on column public.patients.home_address is
  'Where the patient lives. Server-only: never granted to a signed-in role, never shown to staff.';
comment on column public.patients.document_number is
  'Normalised passport/ID number. Server-only lookup and duplicate key: never granted to a signed-in role, never shown to staff.';
comment on column public.patients.pinfl is
  'JSHSHIR. Server-only lookup and duplicate key: never granted to a signed-in role, never shown to staff.';
comment on column public.patients.date_of_birth is
  'Server-only: compared on the server at the desk, used for age-specific lab ranges; staff see an age at most.';
comment on column public.patients.sex is
  'Server-only: selects lab reference ranges; shown only as clinical context on lab result entry.';

revoke select on public.patients from authenticated;
grant select (id, clinic_id, patient_number, full_name, phone, telegram_username, telegram_first_name, preferred_language, merged_into_patient_id)
  on public.patients to authenticated;

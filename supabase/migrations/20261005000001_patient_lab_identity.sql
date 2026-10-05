-- Laboratory (Phase 2, 1 of 4): patient identity for lab work.
--
-- docs/labs/PHASE_1_DOMAIN_MODEL.md §2.1, owner decisions 2026-10-05:
--   * date_of_birth and sex select configured reference ranges. sex is a
--     clinical attribute and may stay NULL (unknown) — staff are never forced
--     to guess. Lab orders require a date of birth (enforced when an order is
--     created, 20261005000003); existing patients simply have none yet.
--   * document_number (passport / ID card) and pinfl are unique WITHIN A
--     CLINIC (O1) — the same passport in two clinics is two valid patients.
--     Values are normalised before they are stored or compared: trimmed,
--     spaces and dashes removed, upper-cased.
--
-- O1 rollout order: add the columns, normalise any existing values, list
-- duplicates per clinic (the migration refuses to continue and names them
-- rather than guessing which record wins), then create the unique indexes.
-- The columns are new, so the duplicate check is expected to find nothing;
-- it stays as the guard the decision asked for.
--
-- Nothing here is readable by more roles than before: patients keeps its
-- existing policies and grants (signed-in roles cannot write it).

create type public.patient_sex as enum ('female', 'male');

comment on type public.patient_sex is
  'Clinical sex used only to select configured lab reference ranges. NULL on patients.sex means unknown / not recorded.';

alter table public.patients
  add column date_of_birth date,
  add column sex public.patient_sex,
  add column document_number text,
  add column pinfl text;

alter table public.patients
  add constraint patients_date_of_birth_check
    check (date_of_birth is null or (date_of_birth >= date '1900-01-01' and date_of_birth <= current_date)),
  add constraint patients_document_number_check
    check (document_number is null or document_number ~ '^[A-Z0-9]{5,20}$'),
  add constraint patients_pinfl_check
    check (pinfl is null or pinfl ~ '^[0-9]{14}$');

comment on column public.patients.date_of_birth is 'Required before a lab order is created; selects age-dependent reference ranges.';
comment on column public.patients.sex is 'NULL = unknown. Never defaulted or guessed.';
comment on column public.patients.document_number is 'Passport / ID card number, normalised (no spaces or dashes, upper-case). Unique per clinic.';
comment on column public.patients.pinfl is 'Personal identification number (14 digits), normalised. Unique per clinic.';

-- ---------- Normalisation ----------

create or replace function public.normalize_identity_document(p_value text)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select nullif(upper(regexp_replace(btrim(p_value), '[[:space:]-]+', '', 'g')), '');
$$;

comment on function public.normalize_identity_document(text) is
  'Canonical form of a passport / ID / PINFL value: trimmed, spaces and dashes removed, upper-case; empty becomes NULL.';

create or replace function public.patients_normalize_identity()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  new.document_number := public.normalize_identity_document(new.document_number);
  new.pinfl := public.normalize_identity_document(new.pinfl);
  return new;
end;
$$;

create trigger patients_normalize_identity
  before insert or update of document_number, pinfl on public.patients
  for each row execute function public.patients_normalize_identity();

revoke all on function public.patients_normalize_identity() from public, anon, authenticated;

-- ---------- O1: normalise, refuse on duplicates, then enforce ----------

update public.patients
set document_number = public.normalize_identity_document(document_number),
    pinfl = public.normalize_identity_document(pinfl)
where document_number is not null or pinfl is not null;

do $$
declare
  v_report text;
begin
  select string_agg(format('%s %s in clinic %s: patients %s', kind, value, clinic_id, ids), '; ')
    into v_report
  from (
    select 'document_number' as kind, document_number as value, clinic_id, string_agg(id::text, ', ') as ids
    from public.patients
    where document_number is not null
    group by clinic_id, document_number
    having count(*) > 1
    union all
    select 'pinfl', pinfl, clinic_id, string_agg(id::text, ', ')
    from public.patients
    where pinfl is not null
    group by clinic_id, pinfl
    having count(*) > 1
  ) duplicates;
  if v_report is not null then
    raise exception 'patients: duplicate identity documents must be resolved before uniqueness is enforced — %', v_report;
  end if;
end;
$$;

create unique index patients_clinic_document_number_key
  on public.patients (clinic_id, document_number)
  where document_number is not null;

create unique index patients_clinic_pinfl_key
  on public.patients (clinic_id, pinfl)
  where pinfl is not null;

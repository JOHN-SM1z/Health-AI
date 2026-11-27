-- Structured prescribing: drug catalogue and search, clinic formulary, ICD-10
-- catalogue, patient allergies, prescriptions with sign / replace / cancel and
-- doctor-owned templates. Technical specification v1.1 (2026-11-14) §9.2–9.3
-- and §14: DW-02, DW-03, RX-01…RX-07 (workstream W13).
--
-- Rules this migration holds in the database, not only in the server:
--
--   * No AI anywhere (RX-03). Nothing here is generated: the catalogue comes
--     from a named source and version (RX-02), templates and recents are the
--     doctor's own rows, and the allergy warning is an exact match of recorded
--     data against the catalogue.
--   * A controlled medicine cannot be put on a prescription at all (RX-04).
--   * A prescription is the doctor's own consultation with this patient in
--     this clinic — the same composite foreign key clinical_records uses.
--   * Signing is one transaction: it writes the doctor-authored
--     clinical_records entry (DW-01), freezes the items with a snapshot of the
--     catalogue values, and stores only the HASH of the verification code.
--   * A signed prescription is immutable (RX-06). Changing it is a new signed
--     prescription that names the old one and a reason; cancelling it is a
--     correction record with a reason. The national e-prescription number is
--     the one annotation a signed prescription accepts afterwards (RX-05).
--   * Every table is server-only: RLS on, no grant to anon or authenticated,
--     so the access decision (doctor_patient_access) and the read audit stay
--     in one place — the server. Audit rows carry ids, never clinical text.
--
-- Drug interaction checking is out of scope (RX-08); nothing here implies it.

-- ---------------------------------------------------------------------------
-- 0. Trigram search
-- ---------------------------------------------------------------------------

create schema if not exists extensions;
create extension if not exists pg_trgm with schema extensions;

do $$
declare
  v_schema text;
begin
  select n.nspname into v_schema
  from pg_extension e
  join pg_namespace n on n.oid = e.extnamespace
  where e.extname = 'pg_trgm';
  if v_schema is distinct from 'extensions' then
    raise exception 'structured prescribing: pg_trgm must live in the extensions schema (found in %). Run "alter extension pg_trgm set schema extensions" first.', v_schema;
  end if;
end;
$$;

grant usage on schema extensions to service_role;

-- One search key for Latin and Cyrillic spellings: lower case, Uzbek/Russian
-- Cyrillic written in Uzbek Latin, apostrophes dropped, everything else that
-- is not a letter or digit becomes a space, and doubled letters collapse
-- ("amoksitsillin" = "amoksitsilin"). "ан" and "an" give the same key.
-- Different-language spellings of one medicine (amoxicillin / amoksitsillin)
-- are the catalogue's aliases and the trigram match, not this function.
create or replace function public.rx_search_key(p_text text)
returns text
language sql
immutable
parallel safe
set search_path = pg_catalog, pg_temp
as $$
  select btrim(regexp_replace(
    regexp_replace(
      regexp_replace(
        translate(
          replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(
          replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(
            lower(coalesce(p_text, '')),
            'щ', 'sh'), 'ш', 'sh'), 'ч', 'ch'), 'ю', 'yu'), 'я', 'ya'), 'ё', 'yo'), 'ц', 'ts'), 'ж', 'j'), 'ғ', 'g'), 'ў', 'o'),
            'Щ', 'sh'), 'Ш', 'sh'), 'Ч', 'ch'), 'Ю', 'yu'), 'Я', 'ya'), 'Ё', 'yo'), 'Ц', 'ts'), 'Ж', 'j'), 'Ғ', 'g'), 'Ў', 'o'),
          'абвгдезийклмнопрстуфхыэқҳАБВГДЕЗИЙКЛМНОПРСТУФХЫЭҚҲъьЪЬʻʼ’‘`''',
          'abvgdeziyklmnoprstufxieqhabvgdeziyklmnoprstufxieqh'),
        '[^a-z0-9]+', ' ', 'g'),
      '([a-z])\1+', '\1', 'g'),
    '\s+', ' ', 'g'));
$$;

revoke all on function public.rx_search_key(text) from public, anon, authenticated;
grant execute on function public.rx_search_key(text) to service_role;
comment on function public.rx_search_key(text) is
  'Script-insensitive search key (Latin and Cyrillic give the same key). Used for the drug and ICD-10 search and for the deterministic allergy match.';

-- ---------------------------------------------------------------------------
-- 1. Where reference data came from (RX-02: source and version are shown)
-- ---------------------------------------------------------------------------

create table public.reference_data_imports (
  id uuid primary key default gen_random_uuid(),
  dataset text not null,
  source text not null,
  source_version text not null,
  -- SHA-256 of the imported file, so an import can be tied to the file that was reviewed.
  checksum text,
  row_count integer not null default 0,
  imported_at timestamptz not null default now(),

  constraint reference_data_imports_dataset_check check (dataset in ('drug_catalog', 'icd10')),
  constraint reference_data_imports_source_check
    check (source ~ '^[a-z0-9][a-z0-9_.-]{1,62}$' and source <> 'clinic_formulary'),
  constraint reference_data_imports_version_check
    check (source_version ~ '\S' and char_length(source_version) <= 64),
  constraint reference_data_imports_checksum_check
    check (checksum is null or checksum ~ '^[0-9a-f]{64}$')
);

comment on table public.reference_data_imports is
  'One row per import of a reference dataset (drug catalogue, ICD-10): the named source, its version and the checksum of the file. No patient or clinic data.';

create index reference_data_imports_dataset_idx on public.reference_data_imports (dataset, imported_at desc);

-- ---------------------------------------------------------------------------
-- 2. Drug catalogue (RX-01) and the clinic's own formulary (RX-02, option 3)
-- ---------------------------------------------------------------------------

create table public.drug_catalog (
  id uuid primary key default gen_random_uuid(),
  -- NULL: the shared catalogue from a named source. Set: an entry one clinic
  -- keeps itself until an official or licensed catalogue is loaded.
  --
  -- Not named clinic_id on purpose: this is reference data, not a tenant table.
  -- A clinic row may point at a shared entry, so the references to this table
  -- cannot carry clinic_id the way references between tenant tables do
  -- (tenant-integrity rule). The same guarantee — never another clinic's own
  -- entry — is held by a trigger on each referencing table (clinic_formulary,
  -- patient_allergies, prescription_items) and tested there.
  owner_clinic_id uuid references public.clinics(id) on delete cascade,
  inn text not null,
  -- The international Latin spelling of the INN, when the source has one.
  inn_latin text,
  trade_name text,
  form text,
  strength text,
  manufacturer text,
  registration_number text,
  -- Pharmacological class as the source names it; used only for the allergy match.
  drug_class text,
  -- Common spellings the source or the clinic lists for this medicine.
  aliases text[] not null default '{}',
  rx_only boolean not null default false,
  controlled boolean not null default false,
  active boolean not null default true,
  source text not null,
  source_version text not null,
  import_id uuid references public.reference_data_imports(id),
  imported_at timestamptz not null default now(),
  created_by uuid references public.profiles(id),
  updated_at timestamptz not null default now(),

  constraint drug_catalog_inn_check check (inn ~ '\S' and char_length(inn) <= 160),
  constraint drug_catalog_inn_latin_check check (inn_latin is null or (inn_latin ~ '\S' and char_length(inn_latin) <= 160)),
  constraint drug_catalog_trade_name_check check (trade_name is null or (trade_name ~ '\S' and char_length(trade_name) <= 160)),
  constraint drug_catalog_form_check check (form is null or (form ~ '\S' and char_length(form) <= 80)),
  constraint drug_catalog_strength_check check (strength is null or (strength ~ '\S' and char_length(strength) <= 80)),
  constraint drug_catalog_manufacturer_check check (manufacturer is null or (manufacturer ~ '\S' and char_length(manufacturer) <= 160)),
  constraint drug_catalog_registration_check
    check (registration_number is null or (registration_number ~ '\S' and char_length(registration_number) <= 64)),
  constraint drug_catalog_class_check check (drug_class is null or (drug_class ~ '\S' and char_length(drug_class) <= 120)),
  constraint drug_catalog_aliases_check check (cardinality(aliases) <= 20),
  constraint drug_catalog_version_check check (source_version ~ '\S' and char_length(source_version) <= 64),
  -- A shared entry always names the import it came from; a clinic entry always names who typed it.
  constraint drug_catalog_scope_check check (
    (owner_clinic_id is null and source <> 'clinic_formulary' and import_id is not null and created_by is null)
    or (owner_clinic_id is not null and source = 'clinic_formulary' and import_id is null and created_by is not null)
  )
);

comment on table public.drug_catalog is
  'Medicines a doctor can prescribe: the shared catalogue from a named source and version (owner_clinic_id null) and entries a clinic keeps itself (owner_clinic_id set). Never AI-generated. Read through the server only.';
comment on column public.drug_catalog.controlled is
  'Narcotic or psychotropic medicine under special control: it cannot be put on a Health AI prescription (RX-04).';
comment on column public.drug_catalog.rx_only is
  'Prescription-only: the legally valid prescription is the national Elektron retsept record, not the Health AI printout (RX-05).';

create unique index drug_catalog_registration_key
  on public.drug_catalog (source, registration_number)
  where owner_clinic_id is null and registration_number is not null;
create unique index drug_catalog_natural_key
  on public.drug_catalog (
    coalesce(owner_clinic_id, '00000000-0000-0000-0000-000000000000'::uuid),
    source,
    public.rx_search_key(inn),
    public.rx_search_key(coalesce(trade_name, '')),
    public.rx_search_key(coalesce(form, '')),
    public.rx_search_key(coalesce(strength, '')),
    public.rx_search_key(coalesce(manufacturer, ''))
  )
  where registration_number is null;
create index drug_catalog_owner_clinic_idx on public.drug_catalog (owner_clinic_id) where owner_clinic_id is not null;
create index drug_catalog_import_idx on public.drug_catalog (import_id) where import_id is not null;

-- Search terms: every name of a medicine and every word of it, as search keys.
-- "C" collation makes prefix search a plain index range.
create table public.drug_search_terms (
  drug_id uuid not null references public.drug_catalog(id) on delete cascade,
  term text collate "C" not null,
  kind text not null,
  primary key (drug_id, term, kind),
  constraint drug_search_terms_kind_check check (kind in ('inn', 'inn_latin', 'trade', 'alias', 'class')),
  constraint drug_search_terms_term_check check (char_length(term) >= 2)
);

comment on table public.drug_search_terms is
  'Search keys of drug_catalog (maintained by trigger): each name and each word of it. Prefix search is an index range, misspellings use the trigram index.';

create index drug_search_terms_term_idx on public.drug_search_terms (term);
create index drug_search_terms_trgm_idx on public.drug_search_terms using gin (term extensions.gin_trgm_ops);

create or replace function public.drug_catalog_index_terms()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'UPDATE' then
    delete from public.drug_search_terms where drug_id = new.id;
  end if;

  insert into public.drug_search_terms (drug_id, term, kind)
  select distinct new.id, w.term, s.kind
  from (
    values ('inn', new.inn), ('inn_latin', new.inn_latin), ('trade', new.trade_name), ('class', new.drug_class)
    union all
    select 'alias', a.value from unnest(new.aliases) as a(value)
  ) as s(kind, value)
  cross join lateral (
    select public.rx_search_key(s.value) as term
    union
    select t.word from regexp_split_to_table(public.rx_search_key(s.value), ' ') as t(word)
  ) as w
  where s.value is not null
    and char_length(w.term) >= 2
  on conflict do nothing;

  return null;
end;
$$;

revoke all on function public.drug_catalog_index_terms() from public, anon, authenticated;

create trigger drug_catalog_index_terms
  after insert or update of inn, inn_latin, trade_name, drug_class, aliases on public.drug_catalog
  for each row execute function public.drug_catalog_index_terms();

create trigger drug_catalog_updated_at
  before update on public.drug_catalog
  for each row execute function public.set_updated_at();

-- The clinic's preferred medicines and their order (shown first in search).
create table public.clinic_formulary (
  clinic_id uuid not null references public.clinics(id) on delete cascade,
  drug_id uuid not null references public.drug_catalog(id) on delete cascade,
  sort_order integer not null default 0,
  active boolean not null default true,
  added_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now(),
  primary key (clinic_id, drug_id),
  constraint clinic_formulary_sort_check check (sort_order between 0 and 100000)
);

comment on table public.clinic_formulary is
  'A clinic''s preferred medicines and their order. An entry points at the shared catalogue or at the clinic''s own entry, never at another clinic''s.';

create index clinic_formulary_drug_idx on public.clinic_formulary (drug_id);

create or replace function public.clinic_formulary_validate()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_owner uuid;
  v_found boolean;
begin
  select true, d.owner_clinic_id into v_found, v_owner from public.drug_catalog d where d.id = new.drug_id;
  if v_found is not true then
    raise exception 'formulary: the medicine does not exist';
  end if;
  if v_owner is not null and v_owner <> new.clinic_id then
    raise exception 'formulary: the medicine belongs to another clinic';
  end if;
  if tg_op = 'UPDATE' and (new.clinic_id <> old.clinic_id or new.drug_id <> old.drug_id) then
    raise exception 'formulary: an entry cannot be moved to another clinic or medicine';
  end if;
  return new;
end;
$$;

revoke all on function public.clinic_formulary_validate() from public, anon, authenticated;

create trigger clinic_formulary_validate
  before insert or update on public.clinic_formulary
  for each row execute function public.clinic_formulary_validate();

-- ---------------------------------------------------------------------------
-- 3. ICD-10 catalogue (DW-02): the doctor picks the code, nothing proposes one
-- ---------------------------------------------------------------------------

create table public.icd10_codes (
  code text collate "C" primary key,
  name_uz text,
  name_ru text,
  active boolean not null default true,
  source text not null,
  source_version text not null,
  import_id uuid not null references public.reference_data_imports(id),
  imported_at timestamptz not null default now(),
  search_key text generated always as (public.rx_search_key(coalesce(name_uz, '') || ' ' || coalesce(name_ru, ''))) stored,

  constraint icd10_codes_code_check check (code ~ '^[A-Z][0-9]{2}(\.[0-9A-Z]{1,4})?$'),
  constraint icd10_codes_name_check check (
    (name_uz is not null or name_ru is not null)
    and (name_uz is null or (name_uz ~ '\S' and char_length(name_uz) <= 300))
    and (name_ru is null or (name_ru ~ '\S' and char_length(name_ru) <= 300))
  )
);

comment on table public.icd10_codes is
  'ICD-10 codes with Uzbek and Russian names from a named source and version. The doctor chooses the diagnosis code; the system never proposes one.';

create index icd10_codes_search_idx on public.icd10_codes using gin (search_key extensions.gin_trgm_ops);

-- ---------------------------------------------------------------------------
-- 4. Patient allergies (DW-03)
-- ---------------------------------------------------------------------------

create table public.patient_allergies (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete cascade,
  patient_id uuid not null,
  -- The substance as the doctor recorded it: an INN, a class, or other wording.
  substance text not null,
  substance_kind text not null default 'inn',
  substance_key text generated always as (public.rx_search_key(substance)) stored,
  -- The catalogue entry the doctor picked, when they picked one. Deferred: erasing a
  -- whole clinic removes its own catalogue entries and its allergy rows in one transaction.
  drug_id uuid references public.drug_catalog(id) deferrable initially deferred,
  reaction text,
  severity text not null default 'unknown',
  recorded_by_doctor_id uuid not null,
  recorded_by uuid not null references public.profiles(id),
  recorded_at timestamptz not null default now(),
  inactive_at timestamptz,
  inactivated_by uuid references public.profiles(id),
  inactive_reason text,
  -- Client idempotency key: a repeated submission resolves to this row.
  creation_key uuid,

  constraint patient_allergies_id_clinic_id_key unique (id, clinic_id),
  constraint patient_allergies_patient_same_clinic_fkey
    foreign key (patient_id, clinic_id) references public.patients (id, clinic_id) on delete cascade,
  constraint patient_allergies_doctor_same_clinic_fkey
    foreign key (recorded_by_doctor_id, clinic_id) references public.doctors (id, clinic_id),
  constraint patient_allergies_substance_check check (substance ~ '\S' and char_length(substance) <= 160),
  constraint patient_allergies_kind_check check (substance_kind in ('inn', 'class', 'other')),
  constraint patient_allergies_reaction_check check (reaction is null or (reaction ~ '\S' and char_length(reaction) <= 300)),
  constraint patient_allergies_severity_check check (severity in ('mild', 'moderate', 'severe', 'unknown')),
  constraint patient_allergies_inactive_check check (
    (inactive_at is null and inactivated_by is null and inactive_reason is null)
    or (inactive_at is not null and inactivated_by is not null
        and inactive_reason is not null and inactive_reason ~ '\S' and char_length(inactive_reason) <= 300)
  )
);

comment on table public.patient_allergies is
  'Allergies recorded by a doctor on the patient card: substance (INN or class), reaction, severity as recorded, who and when. A row is never edited: it is marked inactive with a reason and a new row is written. Read through the server only; never shown to reception, owners or AI.';

create index patient_allergies_patient_idx on public.patient_allergies (clinic_id, patient_id) where inactive_at is null;
create unique index patient_allergies_creation_key_key on public.patient_allergies (clinic_id, recorded_by_doctor_id, creation_key)
  where creation_key is not null;

create or replace function public.patient_allergies_validate()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_profile uuid;
  v_active boolean;
  v_drug_clinic uuid;
  v_drug_found boolean;
begin
  if tg_op = 'UPDATE' then
    -- The one change a recorded allergy accepts: being marked inactive, once.
    if old.inactive_at is not null then
      raise exception 'allergy: an inactive allergy cannot be changed';
    end if;
    -- substance_key is generated after this trigger runs, so it is left out of the comparison.
    if new.inactive_at is null
       or (to_jsonb(new) - array['inactive_at', 'inactivated_by', 'inactive_reason', 'substance_key'])
          is distinct from (to_jsonb(old) - array['inactive_at', 'inactivated_by', 'inactive_reason', 'substance_key']) then
      raise exception 'allergy: a recorded allergy cannot be edited; mark it inactive and record a new one';
    end if;
    new.inactive_at := now();
    if not exists (
      select 1 from public.doctors d
      where d.profile_id = new.inactivated_by and d.clinic_id = new.clinic_id and d.active
    ) then
      raise exception 'allergy: only an active doctor of the clinic can mark an allergy inactive';
    end if;
    return new;
  end if;

  new.recorded_at := now();

  select d.profile_id, d.active into v_profile, v_active
  from public.doctors d
  where d.id = new.recorded_by_doctor_id and d.clinic_id = new.clinic_id;
  if not found or not v_active then
    raise exception 'allergy: the recorder must be an active doctor of the clinic';
  end if;
  if v_profile is null or new.recorded_by is distinct from v_profile then
    raise exception 'allergy: recorded_by must be the recording doctor''s own account';
  end if;
  if not exists (
    select 1 from public.staff_roles sr
    where sr.profile_id = v_profile and sr.clinic_id = new.clinic_id and sr.role = 'doctor'
  ) then
    raise exception 'allergy: the recorder does not hold the doctor role';
  end if;
  -- Same decision as every clinical read: own patient or an active referral.
  if not exists (
    select 1 from public.doctor_patient_access(new.recorded_by_doctor_id, new.patient_id) a
    where a.own_patient or cardinality(a.active_referral_ids) > 0
  ) then
    raise exception 'allergy: the doctor has no clinical relationship with this patient';
  end if;
  if new.drug_id is not null then
    select true, d.owner_clinic_id into v_drug_found, v_drug_clinic from public.drug_catalog d where d.id = new.drug_id;
    if v_drug_found is not true or (v_drug_clinic is not null and v_drug_clinic <> new.clinic_id) then
      raise exception 'allergy: the medicine is not in this clinic''s catalogue';
    end if;
  end if;
  return new;
end;
$$;

revoke all on function public.patient_allergies_validate() from public, anon, authenticated;

create trigger patient_allergies_validate
  before insert or update on public.patient_allergies
  for each row execute function public.patient_allergies_validate();

-- Kept like the rest of the clinical history: an allergy row goes only with its whole clinic.
create or replace function public.patient_allergies_no_delete()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if public.lab_clinic_is_being_erased(old.clinic_id) then
    return old;
  end if;
  raise exception 'allergy: a recorded allergy cannot be deleted; mark it inactive';
end;
$$;

revoke all on function public.patient_allergies_no_delete() from public, anon, authenticated;

create trigger patient_allergies_no_delete
  before delete on public.patient_allergies
  for each row execute function public.patient_allergies_no_delete();

create or replace function public.patient_allergies_audit()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  -- Ids only: the substance and the reaction never reach the audit trail.
  insert into public.audit_events (clinic_id, actor_id, actor_type, action, entity_type, entity_id, patient_id, new_values)
  values (
    new.clinic_id,
    case when tg_op = 'INSERT' then new.recorded_by else new.inactivated_by end,
    'staff'::public.actor_type,
    case when tg_op = 'INSERT' then 'patient_allergy_recorded' else 'patient_allergy_inactivated' end,
    'patient_allergies',
    new.id::text,
    new.patient_id,
    jsonb_build_object('recorded_by_doctor_id', new.recorded_by_doctor_id, 'severity', new.severity, 'substance_kind', new.substance_kind)
  );
  return new;
end;
$$;

revoke all on function public.patient_allergies_audit() from public, anon, authenticated;

create trigger patient_allergies_audit
  after insert or update on public.patient_allergies
  for each row execute function public.patient_allergies_audit();

-- ---------------------------------------------------------------------------
-- 5. Prescriptions
-- ---------------------------------------------------------------------------

create type public.prescription_status as enum ('draft', 'signed', 'replaced', 'cancelled');

create table public.prescriptions (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete cascade,
  patient_id uuid not null,
  doctor_id uuid not null,
  -- The consultation the prescription is written in.
  appointment_id uuid not null,
  status public.prescription_status not null default 'draft',
  -- The signed prescription this one replaces, and why (RX-06).
  replaces_id uuid,
  replace_reason text,
  signed_at timestamptz,
  -- The doctor-authored record signing wrote (DW-01). Deferred, like cancel_record_id:
  -- erasing a whole clinic removes the records and the prescriptions in one transaction.
  clinical_record_id uuid,
  -- SHA-256 of the code printed in the QR link; the code itself is never stored (RX-07).
  verification_code_hash text,
  -- The number the national Elektron retsept system gave, once the doctor has issued it there (RX-05).
  national_rx_number text,
  national_rx_recorded_at timestamptz,
  national_rx_recorded_by uuid references public.profiles(id),
  cancelled_at timestamptz,
  cancel_reason text,
  cancel_record_id uuid,
  created_by uuid not null references public.profiles(id),
  -- Client idempotency key: a repeated submission resolves to this prescription.
  creation_key uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint prescriptions_id_clinic_id_key unique (id, clinic_id),
  constraint prescriptions_patient_same_clinic_fkey
    foreign key (patient_id, clinic_id) references public.patients (id, clinic_id) on delete cascade,
  constraint prescriptions_doctor_same_clinic_fkey
    foreign key (doctor_id, clinic_id) references public.doctors (id, clinic_id),
  -- The author's own consultation with this patient in this clinic.
  constraint prescriptions_consultation_fkey
    foreign key (appointment_id, clinic_id, patient_id, doctor_id)
    references public.appointments (id, clinic_id, patient_id, doctor_id),
  -- Same clinic by construction: a prescription can only replace, and only point at records of, its own clinic.
  constraint prescriptions_replaces_same_clinic_fkey
    foreign key (replaces_id, clinic_id) references public.prescriptions (id, clinic_id),
  constraint prescriptions_record_same_clinic_fkey
    foreign key (clinical_record_id, clinic_id) references public.clinical_records (id, clinic_id) deferrable initially deferred,
  constraint prescriptions_cancel_record_same_clinic_fkey
    foreign key (cancel_record_id, clinic_id) references public.clinical_records (id, clinic_id) deferrable initially deferred,
  constraint prescriptions_not_self_replacement check (replaces_id is null or replaces_id <> id),
  constraint prescriptions_replace_reason_check
    check (replace_reason is null or (replace_reason ~ '\S' and char_length(replace_reason) <= 300)),
  constraint prescriptions_cancel_reason_check
    check (cancel_reason is null or (cancel_reason ~ '\S' and char_length(cancel_reason) <= 300)),
  constraint prescriptions_verification_hash_check
    check (verification_code_hash is null or verification_code_hash ~ '^[0-9a-f]{64}$'),
  constraint prescriptions_national_number_check
    check (national_rx_number is null or national_rx_number ~ '^[A-Za-z0-9][A-Za-z0-9./-]{3,39}$'),
  constraint prescriptions_national_recorded_check check (
    (national_rx_number is null and national_rx_recorded_at is null and national_rx_recorded_by is null)
    or (national_rx_number is not null and national_rx_recorded_at is not null and national_rx_recorded_by is not null)
  ),
  constraint prescriptions_signed_check check (
    status = 'draft'
    or (signed_at is not null and clinical_record_id is not null and verification_code_hash is not null)
  ),
  constraint prescriptions_draft_check check (
    status <> 'draft'
    or (signed_at is null and clinical_record_id is null and verification_code_hash is null and national_rx_number is null)
  ),
  constraint prescriptions_cancelled_check check (
    (status = 'cancelled' and cancelled_at is not null and cancel_reason is not null and cancel_record_id is not null)
    or (status <> 'cancelled' and cancelled_at is null and cancel_reason is null and cancel_record_id is null)
  ),
  constraint prescriptions_replacement_reason_required check (
    replaces_id is null or status = 'draft' or replace_reason is not null
  )
);

comment on table public.prescriptions is
  'A doctor''s structured prescription in their own consultation: draft, then signed (immutable, with the clinical_records entry it wrote), then possibly replaced or cancelled. Server-only: readable where its clinical record is. Not a legal prescription for prescription-only medicines — that is the national Elektron retsept record.';

create index prescriptions_patient_idx on public.prescriptions (clinic_id, patient_id, created_at desc);
create index prescriptions_doctor_idx on public.prescriptions (clinic_id, doctor_id, created_at desc);
create index prescriptions_appointment_idx on public.prescriptions (appointment_id);
create index prescriptions_record_idx on public.prescriptions (clinical_record_id) where clinical_record_id is not null;
create index prescriptions_cancel_record_idx on public.prescriptions (cancel_record_id) where cancel_record_id is not null;
create unique index prescriptions_verification_hash_key on public.prescriptions (verification_code_hash)
  where verification_code_hash is not null;
create unique index prescriptions_creation_key_key on public.prescriptions (clinic_id, doctor_id, creation_key)
  where creation_key is not null;
-- A signed prescription has at most one signed successor.
create unique index prescriptions_one_replacement on public.prescriptions (replaces_id)
  where replaces_id is not null and status <> 'draft';

create table public.prescription_items (
  id uuid primary key default gen_random_uuid(),
  prescription_id uuid not null,
  clinic_id uuid not null,
  position integer not null,
  drug_id uuid not null references public.drug_catalog(id) deferrable initially deferred,
  -- What the catalogue said when the item was written: a signed item never changes with the catalogue.
  inn_snapshot text not null,
  trade_name_snapshot text,
  form_snapshot text,
  strength_snapshot text,
  rx_only_snapshot boolean not null,
  dose numeric(10, 3) not null,
  dose_unit text not null,
  route text not null,
  -- "1×1", "2×1", "3×1" or the doctor's own wording.
  frequency text not null,
  timing text not null default 'any',
  days integer not null,
  quantity numeric(10, 2) not null,
  -- The doctor's free-text instruction to the patient.
  instructions text,
  -- Why the doctor prescribed despite a recorded allergy, and which allergy rows matched at signing.
  allergy_override_reason text,
  allergy_ids uuid[] not null default '{}',

  constraint prescription_items_prescription_fkey
    foreign key (prescription_id, clinic_id) references public.prescriptions (id, clinic_id) on delete cascade,
  constraint prescription_items_position_key unique (prescription_id, position),
  constraint prescription_items_position_check check (position between 1 and 20),
  constraint prescription_items_dose_check check (dose > 0),
  constraint prescription_items_dose_unit_check check (dose_unit ~ '\S' and char_length(dose_unit) <= 20),
  constraint prescription_items_route_check check (route ~ '\S' and char_length(route) <= 40),
  constraint prescription_items_frequency_check check (frequency ~ '\S' and char_length(frequency) <= 40),
  constraint prescription_items_timing_check check (timing in ('before_food', 'after_food', 'with_food', 'any')),
  constraint prescription_items_days_check check (days between 1 and 365),
  constraint prescription_items_quantity_check check (quantity > 0),
  constraint prescription_items_instructions_check
    check (instructions is null or (instructions ~ '\S' and char_length(instructions) <= 500)),
  constraint prescription_items_override_check
    check (allergy_override_reason is null or (allergy_override_reason ~ '\S' and char_length(allergy_override_reason) <= 300))
);

comment on table public.prescription_items is
  'The medicines of a prescription with the doctor''s own dose, schedule and instruction, and a snapshot of the catalogue values. Frozen once the prescription is signed.';

create index prescription_items_drug_idx on public.prescription_items (drug_id);

-- ---------- Immutability ----------

create or replace function public.prescriptions_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_fixed text[] := array['status', 'cancelled_at', 'cancel_reason', 'cancel_record_id',
                          'national_rx_number', 'national_rx_recorded_at', 'national_rx_recorded_by', 'updated_at'];
begin
  if tg_op = 'DELETE' then
    -- Retention (20261008000004): a signed prescription is kept. It goes only with its whole
    -- clinic, the same rule as laboratory results; a draft is the doctor's to discard.
    if old.status = 'draft' or public.lab_clinic_is_being_erased(old.clinic_id) then
      return old;
    end if;
    raise exception 'prescription: a signed prescription cannot be deleted';
  end if;

  if tg_op = 'INSERT' then
    if new.status <> 'draft' then
      raise exception 'prescription: a prescription starts as a draft and is signed by sign_prescription()';
    end if;
    new.created_at := now();
    new.updated_at := now();
    return new;
  end if;

  if new.id <> old.id or new.clinic_id <> old.clinic_id or new.patient_id <> old.patient_id
     or new.doctor_id <> old.doctor_id or new.appointment_id <> old.appointment_id
     or new.created_by <> old.created_by or new.created_at <> old.created_at then
    raise exception 'prescription: clinic, patient, doctor, consultation and author cannot change';
  end if;

  if old.status = 'draft' then
    if new.status not in ('draft', 'signed') then
      raise exception 'prescription: a draft can only be signed';
    end if;
  elsif old.status = 'signed' then
    if new.status not in ('signed', 'replaced', 'cancelled') then
      raise exception 'prescription: a signed prescription can only be replaced or cancelled';
    end if;
    -- A signed prescription is immutable: only its outcome and the national number may be set.
    if (to_jsonb(new) - v_fixed) is distinct from (to_jsonb(old) - v_fixed) then
      raise exception 'prescription: a signed prescription cannot be edited; replace it instead';
    end if;
    if new.status <> 'signed'
       and (new.national_rx_number is distinct from old.national_rx_number) then
      raise exception 'prescription: the national number is recorded on the current prescription only';
    end if;
  else
    raise exception 'prescription: a replaced or cancelled prescription cannot change';
  end if;

  new.updated_at := now();
  return new;
end;
$$;

revoke all on function public.prescriptions_guard() from public, anon, authenticated;

create trigger prescriptions_guard
  before insert or update or delete on public.prescriptions
  for each row execute function public.prescriptions_guard();

create or replace function public.prescription_items_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_status public.prescription_status;
  v_id uuid := case when tg_op = 'DELETE' then old.prescription_id else new.prescription_id end;
begin
  select p.status into v_status from public.prescriptions p where p.id = v_id;
  -- No parent: the prescription itself is being deleted (its own guard decided that).
  if found and v_status <> 'draft'
     and not (tg_op = 'DELETE' and public.lab_clinic_is_being_erased(old.clinic_id)) then
    raise exception 'prescription: the items of a signed prescription cannot change';
  end if;
  -- Never another clinic's own catalogue entry, whichever code path writes the row.
  if tg_op <> 'DELETE' and not exists (
       select 1 from public.drug_catalog d
       where d.id = new.drug_id and (d.owner_clinic_id is null or d.owner_clinic_id = new.clinic_id)
     ) then
    raise exception 'prescription: the medicine is not in this clinic''s catalogue';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

revoke all on function public.prescription_items_guard() from public, anon, authenticated;

create trigger prescription_items_guard
  before insert or update or delete on public.prescription_items
  for each row execute function public.prescription_items_guard();

-- The record a prescription wrote is changed through the prescription, never
-- through the free-text correction of a clinical record.
create or replace function public.clinical_records_prescription_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.corrects_record_id is not null
     and coalesce(current_setting('health_ai.prescription_write', true), '') <> 'on'
     and exists (
       select 1 from public.prescriptions p
       where p.clinical_record_id = new.corrects_record_id or p.cancel_record_id = new.corrects_record_id
     ) then
    raise exception 'clinical record: a structured prescription is replaced or cancelled through the prescription itself';
  end if;
  return new;
end;
$$;

revoke all on function public.clinical_records_prescription_guard() from public, anon, authenticated;

create trigger clinical_records_prescription_guard
  before insert on public.clinical_records
  for each row execute function public.clinical_records_prescription_guard();

-- ---------- Templates: the doctor's own, never generated ----------

create table public.prescription_templates (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete cascade,
  doctor_id uuid not null,
  name text not null,
  -- [{ drugId, dose, doseUnit, route, frequency, timing, days, quantity, instructions }]
  items jsonb not null,
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint prescription_templates_doctor_same_clinic_fkey
    foreign key (doctor_id, clinic_id) references public.doctors (id, clinic_id) on delete cascade,
  constraint prescription_templates_name_check check (name ~ '\S' and char_length(name) <= 80),
  constraint prescription_templates_items_check check (
    jsonb_typeof(items) = 'array' and jsonb_array_length(items) between 1 and 20 and pg_column_size(items) <= 32768
  )
);

comment on table public.prescription_templates is
  'A doctor''s own saved set of prescription items ("Angina — kattalar"). Owned by one doctor; re-validated against the catalogue every time it is used.';

create unique index prescription_templates_name_key on public.prescription_templates (doctor_id, lower(name));

create trigger prescription_templates_updated_at
  before update on public.prescription_templates
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- 6. Search
-- ---------------------------------------------------------------------------

-- Medicines matching what the doctor typed (two characters or more). The
-- first word is matched as a prefix of any name or word of a name — Latin or
-- Cyrillic — and, from four characters, by trigram similarity for misspellings.
-- Further words narrow the result by name, strength or form. The clinic's
-- formulary and the doctor's own recent choices come first.
create or replace function public.search_drug_catalog(
  p_clinic_id uuid,
  p_doctor_id uuid,
  p_query text,
  p_limit integer default 20
)
returns table (
  id uuid,
  inn text,
  inn_latin text,
  trade_name text,
  form text,
  strength text,
  manufacturer text,
  drug_class text,
  rx_only boolean,
  controlled boolean,
  clinic_owned boolean,
  in_formulary boolean,
  recent boolean,
  match text,
  source text,
  source_version text
)
language plpgsql
stable
set search_path = public, extensions, pg_temp
as $$
declare
  v_key text := public.rx_search_key(p_query);
  v_tokens text[] := string_to_array(v_key, ' ');
  v_first text;
  v_rest text[];
  v_limit integer := least(greatest(coalesce(p_limit, 20), 1), 50);
begin
  if p_clinic_id is null or p_doctor_id is null then
    raise exception 'drug search: clinic and doctor are required';
  end if;
  if v_key is null or char_length(v_key) < 2 or cardinality(v_tokens) > 6 then
    return;
  end if;
  v_first := v_tokens[1];
  v_rest := v_tokens[2:];
  if char_length(v_first) < 2 then
    return;
  end if;

  return query
  with prefix_hits as (
    select t.drug_id,
           min(case when t.kind in ('inn', 'inn_latin') then 0 else 1 end) as kind_rank,
           1::real as score
    from public.drug_search_terms t
    -- Keys hold only [a-z0-9 ], so "{" (the byte after "z") bounds the prefix range.
    where t.term >= v_first and t.term < v_first || '{'
    group by t.drug_id
  ),
  fuzzy_hits as (
    select t.drug_id, 2 as kind_rank, max(similarity(t.term, v_first)) as score
    from public.drug_search_terms t
    where char_length(v_first) >= 4
      and t.term % v_first
      and not exists (select 1 from prefix_hits p where p.drug_id = t.drug_id)
    group by t.drug_id
  ),
  hits as (
    select * from prefix_hits
    union all
    select * from fuzzy_hits
  ),
  recent_use as (
    select i.drug_id, max(p.signed_at) as last_used
    from public.prescriptions p
    join public.prescription_items i on i.prescription_id = p.id
    where p.clinic_id = p_clinic_id
      and p.doctor_id = p_doctor_id
      and p.status <> 'draft'
      and p.signed_at > now() - interval '180 days'
    group by i.drug_id
  )
  select d.id, d.inn, d.inn_latin, d.trade_name, d.form, d.strength, d.manufacturer, d.drug_class,
         d.rx_only, d.controlled,
         d.owner_clinic_id is not null,
         f.drug_id is not null,
         r.drug_id is not null,
         case when h.kind_rank = 2 then 'similar' else 'prefix' end,
         d.source, d.source_version
  from hits h
  join public.drug_catalog d on d.id = h.drug_id
  left join public.clinic_formulary f on f.clinic_id = p_clinic_id and f.drug_id = d.id and f.active
  left join recent_use r on r.drug_id = d.id
  where d.active
    and (d.owner_clinic_id is null or d.owner_clinic_id = p_clinic_id)
    and not exists (
      select 1
      from unnest(v_rest) as k(token)
      where char_length(k.token) > 0
        and not exists (
          select 1 from public.drug_search_terms t2
          where t2.drug_id = d.id and t2.term >= k.token and t2.term < k.token || '{'
        )
        and position(k.token in public.rx_search_key(coalesce(d.strength, '') || ' ' || coalesce(d.form, ''))) = 0
    )
  order by (h.kind_rank = 2),
           (f.drug_id is null),
           (r.drug_id is null),
           h.kind_rank,
           h.score desc,
           f.sort_order nulls last,
           r.last_used desc nulls last,
           d.inn, d.trade_name nulls first, d.strength nulls first, d.id
  limit v_limit;
end;
$$;

revoke all on function public.search_drug_catalog(uuid, uuid, text, integer) from public, anon, authenticated;
grant execute on function public.search_drug_catalog(uuid, uuid, text, integer) to service_role;
comment on function public.search_drug_catalog(uuid, uuid, text, integer) is
  'Drug autocomplete for the prescribing screen: prefix and trigram match over INN, trade names and aliases in Latin or Cyrillic; the clinic formulary and the doctor''s recent choices first. No AI.';

create or replace function public.search_icd10(p_query text, p_limit integer default 20)
returns table (code text, name_uz text, name_ru text)
language plpgsql
stable
set search_path = public, extensions, pg_temp
as $$
declare
  v_code text := upper(regexp_replace(coalesce(p_query, ''), '\s', '', 'g'));
  v_key text := public.rx_search_key(p_query);
  v_limit integer := least(greatest(coalesce(p_limit, 20), 1), 50);
begin
  if v_code ~ '^[A-Z][0-9][0-9A-Z.]{0,6}$' then
    return query
    select c.code::text, c.name_uz, c.name_ru
    from public.icd10_codes c
    where c.active and c.code >= v_code and c.code < v_code || '{'
    order by c.code
    limit v_limit;
    if found then
      return;
    end if;
  end if;
  if v_key is null or char_length(v_key) < 2 then
    return;
  end if;
  return query
  select c.code::text, c.name_uz, c.name_ru
  from public.icd10_codes c
  -- The key holds only [a-z0-9 ]: it cannot carry a LIKE wildcard.
  where c.active and c.search_key like '%' || v_key || '%'
  order by (c.search_key like v_key || '%' or c.search_key like '% ' || v_key || '%') desc, c.code
  limit v_limit;
end;
$$;

revoke all on function public.search_icd10(text, integer) from public, anon, authenticated;
grant execute on function public.search_icd10(text, integer) to service_role;
comment on function public.search_icd10(text, integer) is
  'ICD-10 picker: by code prefix ("J06") or by words of the Uzbek/Russian name, Latin or Cyrillic. The doctor chooses; nothing is proposed.';

-- ---------------------------------------------------------------------------
-- 7. Writing a prescription
-- ---------------------------------------------------------------------------

-- The doctor acting as themselves in their own started consultation with this patient.
create or replace function public.prescription_author_check(
  p_clinic_id uuid,
  p_doctor_id uuid,
  p_actor uuid,
  p_patient_id uuid,
  p_appointment_id uuid
)
returns text
language plpgsql
stable
set search_path = public, pg_temp
as $$
declare
  v_status public.appointment_status;
begin
  if not exists (
    select 1 from public.doctors d
    where d.id = p_doctor_id and d.clinic_id = p_clinic_id and d.profile_id = p_actor and d.active
  ) or not exists (
    select 1 from public.staff_roles sr
    where sr.profile_id = p_actor and sr.clinic_id = p_clinic_id and sr.role = 'doctor'
  ) then
    raise exception 'prescription: written by the doctor themselves';
  end if;

  select a.status into v_status
  from public.appointments a
  where a.id = p_appointment_id
    and a.clinic_id = p_clinic_id
    and a.patient_id = p_patient_id
    and a.doctor_id = p_doctor_id;
  if not found then
    return 'consultation_not_found';
  end if;
  if v_status not in ('in_progress', 'completed') then
    return 'consultation_not_active';
  end if;
  return null;
end;
$$;

revoke all on function public.prescription_author_check(uuid, uuid, uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.prescription_author_check(uuid, uuid, uuid, uuid, uuid) to service_role;

-- Creates the doctor's draft or replaces the items of their existing draft.
-- Items: [{ drug_id, dose, dose_unit, route, frequency, timing, days, quantity, instructions, allergy_override_reason }]
create or replace function public.save_prescription_draft(
  p_clinic_id uuid,
  p_doctor_id uuid,
  p_actor uuid,
  p_patient_id uuid,
  p_appointment_id uuid,
  p_prescription_id uuid,
  p_items jsonb,
  p_replaces_id uuid,
  p_creation_key uuid
)
returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_error text;
  v_rx public.prescriptions;
  v_old public.prescriptions;
  v_item jsonb;
  v_position integer := 0;
  v_drug public.drug_catalog;
begin
  v_error := public.prescription_author_check(p_clinic_id, p_doctor_id, p_actor, p_patient_id, p_appointment_id);
  if v_error is not null then
    return jsonb_build_object('prescription_id', null, 'error_code', v_error);
  end if;

  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) not between 1 and 20 then
    return jsonb_build_object('prescription_id', null, 'error_code', 'items_invalid');
  end if;

  if p_replaces_id is not null then
    select * into v_old from public.prescriptions p
    where p.id = p_replaces_id and p.clinic_id = p_clinic_id and p.doctor_id = p_doctor_id
      and p.patient_id = any (public.patient_record_group(p_patient_id));
    if not found then
      return jsonb_build_object('prescription_id', null, 'error_code', 'replaced_not_found');
    end if;
    if v_old.status <> 'signed' then
      return jsonb_build_object('prescription_id', null, 'error_code', 'replaced_not_current');
    end if;
  end if;

  if p_prescription_id is null and p_creation_key is not null then
    select * into v_rx from public.prescriptions p
    where p.clinic_id = p_clinic_id and p.doctor_id = p_doctor_id and p.creation_key = p_creation_key
    for update;
    if found and (v_rx.patient_id <> p_patient_id or v_rx.appointment_id <> p_appointment_id) then
      return jsonb_build_object('prescription_id', null, 'error_code', 'idempotency_key_reused');
    end if;
  elsif p_prescription_id is not null then
    select * into v_rx from public.prescriptions p
    where p.id = p_prescription_id and p.clinic_id = p_clinic_id and p.doctor_id = p_doctor_id
      and p.patient_id = p_patient_id and p.appointment_id = p_appointment_id
    for update;
    if not found then
      return jsonb_build_object('prescription_id', null, 'error_code', 'prescription_not_found');
    end if;
  end if;

  if v_rx.id is not null and v_rx.status <> 'draft' then
    return jsonb_build_object('prescription_id', v_rx.id, 'error_code', 'not_a_draft');
  end if;

  if v_rx.id is null then
    insert into public.prescriptions (clinic_id, patient_id, doctor_id, appointment_id, replaces_id, created_by, creation_key)
    values (p_clinic_id, p_patient_id, p_doctor_id, p_appointment_id, p_replaces_id, p_actor, p_creation_key)
    returning * into v_rx;
  else
    update public.prescriptions set replaces_id = p_replaces_id where id = v_rx.id;
    delete from public.prescription_items where prescription_id = v_rx.id;
  end if;

  for v_item in select value from jsonb_array_elements(p_items) loop
    v_position := v_position + 1;
    select * into v_drug from public.drug_catalog d
    where d.id = (v_item ->> 'drug_id')::uuid
      and d.active
      and (d.owner_clinic_id is null or d.owner_clinic_id = p_clinic_id);
    if not found then
      raise exception 'prescription_item_rejected:drug_not_available:%', v_position using errcode = 'P0001';
    end if;
    -- RX-04: a controlled medicine needs the special form or the national procedure.
    if v_drug.controlled then
      raise exception 'prescription_item_rejected:controlled_not_allowed:%', v_position using errcode = 'P0001';
    end if;

    insert into public.prescription_items (
      prescription_id, clinic_id, position, drug_id,
      inn_snapshot, trade_name_snapshot, form_snapshot, strength_snapshot, rx_only_snapshot,
      dose, dose_unit, route, frequency, timing, days, quantity, instructions, allergy_override_reason
    ) values (
      v_rx.id, p_clinic_id, v_position, v_drug.id,
      v_drug.inn, v_drug.trade_name, v_drug.form, v_drug.strength, v_drug.rx_only,
      (v_item ->> 'dose')::numeric,
      btrim(v_item ->> 'dose_unit'),
      btrim(v_item ->> 'route'),
      btrim(v_item ->> 'frequency'),
      coalesce(nullif(v_item ->> 'timing', ''), 'any'),
      (v_item ->> 'days')::integer,
      (v_item ->> 'quantity')::numeric,
      nullif(btrim(coalesce(v_item ->> 'instructions', '')), ''),
      nullif(btrim(coalesce(v_item ->> 'allergy_override_reason', '')), '')
    );
  end loop;

  return jsonb_build_object('prescription_id', v_rx.id, 'error_code', null);
end;
$$;

revoke all on function public.save_prescription_draft(uuid, uuid, uuid, uuid, uuid, uuid, jsonb, uuid, uuid) from public, anon, authenticated;
grant execute on function public.save_prescription_draft(uuid, uuid, uuid, uuid, uuid, uuid, jsonb, uuid, uuid) to service_role;
comment on function public.save_prescription_draft(uuid, uuid, uuid, uuid, uuid, uuid, jsonb, uuid, uuid) is
  'Creates the doctor''s draft prescription in their own consultation, or replaces the items of their draft. Refuses controlled and unavailable medicines. Nothing is signed.';

-- Recorded allergies of the patient that match a prescription's items.
-- Deterministic: the allergy's catalogue entry, or its search key equal to a
-- name, word, alias or class of the medicine. Not AI.
create or replace function public.prescription_allergy_matches(p_prescription_id uuid)
returns table (item_position integer, drug_id uuid, allergy_ids uuid[])
language sql
stable
set search_path = public, pg_temp
as $$
  select i.position, i.drug_id, array_agg(distinct a.id order by a.id)
  from public.prescriptions p
  join public.prescription_items i on i.prescription_id = p.id
  join public.patient_allergies a
    on a.clinic_id = p.clinic_id
   and a.patient_id = any (public.patient_record_group(p.patient_id))
   and a.inactive_at is null
  where p.id = p_prescription_id
    and (
      a.drug_id = i.drug_id
      or exists (
        select 1 from public.drug_search_terms t
        where t.drug_id = i.drug_id and t.term = a.substance_key
      )
    )
  group by i.position, i.drug_id;
$$;

revoke all on function public.prescription_allergy_matches(uuid) from public, anon, authenticated;
grant execute on function public.prescription_allergy_matches(uuid) to service_role;

-- Signs the doctor's draft: one transaction writes the clinical record,
-- freezes the items and, for a replacement, retires the old prescription.
create or replace function public.sign_prescription(
  p_clinic_id uuid,
  p_doctor_id uuid,
  p_actor uuid,
  p_prescription_id uuid,
  p_verification_code_hash text,
  p_replace_reason text
)
returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_rx public.prescriptions;
  v_old public.prescriptions;
  v_error text;
  v_conflicts jsonb;
  v_blocked jsonb;
  v_summary text;
  v_details text;
  v_record uuid;
  v_corrects uuid;
  v_reason text := nullif(btrim(coalesce(p_replace_reason, '')), '');
  v_needs_national boolean;
begin
  select * into v_rx from public.prescriptions p
  where p.id = p_prescription_id and p.clinic_id = p_clinic_id and p.doctor_id = p_doctor_id
  for update;
  if not found then
    return jsonb_build_object('error_code', 'prescription_not_found');
  end if;
  if v_rx.status <> 'draft' then
    return jsonb_build_object('error_code', 'not_a_draft');
  end if;

  v_error := public.prescription_author_check(p_clinic_id, p_doctor_id, p_actor, v_rx.patient_id, v_rx.appointment_id);
  if v_error is not null then
    return jsonb_build_object('error_code', v_error);
  end if;

  if p_verification_code_hash is null or p_verification_code_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'prescription: a verification code hash is required to sign';
  end if;

  if not exists (select 1 from public.prescription_items i where i.prescription_id = v_rx.id) then
    return jsonb_build_object('error_code', 'items_invalid');
  end if;

  -- The catalogue may have changed since the draft: refresh the snapshot and re-check.
  select jsonb_agg(jsonb_build_object(
           'position', i.position,
           'reason', case when d.id is null or not d.active or (d.owner_clinic_id is not null and d.owner_clinic_id <> p_clinic_id)
                          then 'drug_not_available' else 'controlled_not_allowed' end)
           order by i.position)
    into v_blocked
  from public.prescription_items i
  left join public.drug_catalog d on d.id = i.drug_id
  where i.prescription_id = v_rx.id
    and (d.id is null or not d.active or d.controlled or (d.owner_clinic_id is not null and d.owner_clinic_id <> p_clinic_id));
  if v_blocked is not null then
    return jsonb_build_object('error_code', 'items_not_allowed', 'items', v_blocked);
  end if;

  update public.prescription_items i
     set inn_snapshot = d.inn,
         trade_name_snapshot = d.trade_name,
         form_snapshot = d.form,
         strength_snapshot = d.strength,
         rx_only_snapshot = d.rx_only,
         allergy_ids = '{}'
    from public.drug_catalog d
   where i.prescription_id = v_rx.id and d.id = i.drug_id;

  -- DW-03: a recorded allergy blocks signing until the doctor gives a reason for that item.
  update public.prescription_items i
     set allergy_ids = m.allergy_ids
    from public.prescription_allergy_matches(v_rx.id) m
   where i.prescription_id = v_rx.id and i.position = m.item_position;

  select jsonb_agg(jsonb_build_object('position', i.position, 'drug_id', i.drug_id, 'allergy_ids', to_jsonb(i.allergy_ids))
                   order by i.position)
    into v_conflicts
  from public.prescription_items i
  where i.prescription_id = v_rx.id
    and cardinality(i.allergy_ids) > 0
    and i.allergy_override_reason is null;
  if v_conflicts is not null then
    -- Still a draft: only its snapshot and matched allergy ids were refreshed, and both
    -- are recomputed on the next attempt.
    return jsonb_build_object('error_code', 'allergy_conflict', 'conflicts', v_conflicts);
  end if;

  if v_rx.replaces_id is not null then
    select * into v_old from public.prescriptions p
    where p.id = v_rx.replaces_id and p.clinic_id = p_clinic_id and p.doctor_id = p_doctor_id
    for update;
    if not found or v_old.status <> 'signed' then
      return jsonb_build_object('error_code', 'replaced_not_current');
    end if;
    if v_reason is null or char_length(v_reason) < 3 then
      return jsonb_build_object('error_code', 'replace_reason_required');
    end if;
    -- The clinical record is a correction only inside the same consultation.
    if v_old.appointment_id = v_rx.appointment_id then
      v_corrects := v_old.clinical_record_id;
    end if;
  end if;

  select left('Retsept: ' || string_agg(i.inn_snapshot || coalesce(' ' || i.strength_snapshot, ''), '; ' order by i.position), 300),
         left(
           coalesce('Oldingi retsept o‘rniga. Sabab: ' || v_reason || E'\n', '') ||
           string_agg(
             i.position || '. ' || i.inn_snapshot
               || coalesce(' (' || i.trade_name_snapshot || ')', '')
               || coalesce(', ' || i.form_snapshot, '')
               || coalesce(' ' || i.strength_snapshot, '')
               || ' — ' || trim_scale(i.dose) || ' ' || i.dose_unit
               || ', ' || i.route
               || ', ' || i.frequency
               || case i.timing
                    when 'before_food' then ', ovqatdan oldin'
                    when 'after_food' then ', ovqatdan keyin'
                    when 'with_food' then ', ovqat bilan'
                    else ''
                  end
               || ', ' || i.days || ' kun'
               || ', jami ' || trim_scale(i.quantity)
               || coalesce('. ' || i.instructions, '')
               || case when i.allergy_override_reason is not null
                       then '. Allergiya qayd etilgan — shifokor izohi: ' || i.allergy_override_reason else '' end,
             E'\n' order by i.position),
           4000),
         bool_or(i.rx_only_snapshot)
    into v_summary, v_details, v_needs_national
  from public.prescription_items i
  where i.prescription_id = v_rx.id;

  perform set_config('health_ai.prescription_write', 'on', true);
  insert into public.clinical_records (
    clinic_id, patient_id, author_doctor_id, appointment_id, record_type, summary, details, corrects_record_id, created_by
  ) values (
    p_clinic_id, v_rx.patient_id, p_doctor_id, v_rx.appointment_id, 'prescription', v_summary, v_details, v_corrects, p_actor
  )
  returning id into v_record;
  perform set_config('health_ai.prescription_write', '', true);

  update public.prescriptions
     set status = 'signed',
         signed_at = now(),
         clinical_record_id = v_record,
         verification_code_hash = p_verification_code_hash,
         replace_reason = case when v_rx.replaces_id is not null then v_reason end
   where id = v_rx.id
   returning * into v_rx;

  if v_old.id is not null then
    update public.prescriptions set status = 'replaced' where id = v_old.id;
  end if;

  -- Ids only: no medicine, dose or reason reaches the audit trail.
  insert into public.audit_events (clinic_id, actor_id, actor_type, action, entity_type, entity_id, patient_id, new_values)
  values (
    p_clinic_id, p_actor, 'staff',
    case when v_old.id is null then 'prescription_signed' else 'prescription_replaced' end,
    'prescriptions', v_rx.id::text, v_rx.patient_id,
    jsonb_build_object(
      'doctor_id', p_doctor_id,
      'appointment_id', v_rx.appointment_id,
      'clinical_record_id', v_record,
      'replaces_id', v_old.id,
      'item_count', (select count(*) from public.prescription_items i where i.prescription_id = v_rx.id),
      'national_rx_required', v_needs_national
    )
  );
  insert into public.audit_events (clinic_id, actor_id, actor_type, action, entity_type, entity_id, patient_id, new_values)
  select p_clinic_id, p_actor, 'staff', 'prescription_allergy_override', 'prescription_items', i.id::text, v_rx.patient_id,
         jsonb_build_object('prescription_id', v_rx.id, 'drug_id', i.drug_id, 'allergy_ids', to_jsonb(i.allergy_ids))
  from public.prescription_items i
  where i.prescription_id = v_rx.id and cardinality(i.allergy_ids) > 0;

  return jsonb_build_object(
    'error_code', null,
    'prescription_id', v_rx.id,
    'clinical_record_id', v_record,
    'signed_at', v_rx.signed_at,
    'replaced_id', v_old.id,
    'national_rx_required', v_needs_national
  );
end;
$$;

revoke all on function public.sign_prescription(uuid, uuid, uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.sign_prescription(uuid, uuid, uuid, uuid, text, text) to service_role;
comment on function public.sign_prescription(uuid, uuid, uuid, uuid, text, text) is
  'Signs the doctor''s own draft in one transaction: re-checks the catalogue and controlled medicines, blocks on a recorded allergy without a reason, writes the doctor-authored clinical record, freezes the items and retires the prescription it replaces.';

create or replace function public.cancel_prescription(
  p_clinic_id uuid,
  p_doctor_id uuid,
  p_actor uuid,
  p_prescription_id uuid,
  p_reason text
)
returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_rx public.prescriptions;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_record uuid;
begin
  if not exists (
    select 1 from public.doctors d
    where d.id = p_doctor_id and d.clinic_id = p_clinic_id and d.profile_id = p_actor and d.active
  ) then
    raise exception 'prescription: cancelled by the doctor themselves';
  end if;

  select * into v_rx from public.prescriptions p
  where p.id = p_prescription_id and p.clinic_id = p_clinic_id and p.doctor_id = p_doctor_id
  for update;
  if not found then
    return jsonb_build_object('error_code', 'prescription_not_found');
  end if;
  if v_rx.status <> 'signed' then
    return jsonb_build_object('error_code', 'not_current');
  end if;
  if v_reason is null or char_length(v_reason) < 3 or char_length(v_reason) > 300 then
    return jsonb_build_object('error_code', 'reason_required');
  end if;

  perform set_config('health_ai.prescription_write', 'on', true);
  insert into public.clinical_records (
    clinic_id, patient_id, author_doctor_id, appointment_id, record_type, summary, details, corrects_record_id, created_by
  ) values (
    p_clinic_id, v_rx.patient_id, p_doctor_id, v_rx.appointment_id, 'prescription',
    'Retsept bekor qilindi', 'Sabab: ' || v_reason, v_rx.clinical_record_id, p_actor
  )
  returning id into v_record;
  perform set_config('health_ai.prescription_write', '', true);

  update public.prescriptions
     set status = 'cancelled', cancelled_at = now(), cancel_reason = v_reason, cancel_record_id = v_record
   where id = v_rx.id;

  insert into public.audit_events (clinic_id, actor_id, actor_type, action, entity_type, entity_id, patient_id, new_values)
  values (p_clinic_id, p_actor, 'staff', 'prescription_cancelled', 'prescriptions', v_rx.id::text, v_rx.patient_id,
          jsonb_build_object('doctor_id', p_doctor_id, 'clinical_record_id', v_record));

  return jsonb_build_object('error_code', null, 'prescription_id', v_rx.id, 'clinical_record_id', v_record);
end;
$$;

revoke all on function public.cancel_prescription(uuid, uuid, uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.cancel_prescription(uuid, uuid, uuid, uuid, text) to service_role;
comment on function public.cancel_prescription(uuid, uuid, uuid, uuid, text) is
  'Cancels the doctor''s own signed prescription with a reason: writes the correction record and marks the prescription cancelled. Nothing is deleted.';

-- RX-05, phase 1: the doctor issues prescription-only items in the national
-- system with their own login and records the number it gave here.
create or replace function public.record_national_rx_number(
  p_clinic_id uuid,
  p_doctor_id uuid,
  p_actor uuid,
  p_prescription_id uuid,
  p_number text
)
returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_rx public.prescriptions;
  v_number text := upper(btrim(coalesce(p_number, '')));
begin
  if not exists (
    select 1 from public.doctors d
    where d.id = p_doctor_id and d.clinic_id = p_clinic_id and d.profile_id = p_actor and d.active
  ) then
    raise exception 'prescription: the national number is recorded by the doctor themselves';
  end if;

  select * into v_rx from public.prescriptions p
  where p.id = p_prescription_id and p.clinic_id = p_clinic_id and p.doctor_id = p_doctor_id
  for update;
  if not found then
    return jsonb_build_object('error_code', 'prescription_not_found');
  end if;
  if v_rx.status <> 'signed' then
    return jsonb_build_object('error_code', 'not_current');
  end if;
  if v_number !~ '^[A-Za-z0-9][A-Za-z0-9./-]{3,39}$' then
    return jsonb_build_object('error_code', 'number_invalid');
  end if;
  if not exists (select 1 from public.prescription_items i where i.prescription_id = v_rx.id and i.rx_only_snapshot) then
    return jsonb_build_object('error_code', 'national_rx_not_required');
  end if;

  update public.prescriptions
     set national_rx_number = v_number, national_rx_recorded_at = now(), national_rx_recorded_by = p_actor
   where id = v_rx.id;

  insert into public.audit_events (clinic_id, actor_id, actor_type, action, entity_type, entity_id, patient_id, new_values)
  values (p_clinic_id, p_actor, 'staff', 'prescription_national_number_recorded', 'prescriptions', v_rx.id::text, v_rx.patient_id,
          jsonb_build_object('doctor_id', p_doctor_id, 'changed', v_rx.national_rx_number is not null));

  return jsonb_build_object('error_code', null, 'prescription_id', v_rx.id);
end;
$$;

revoke all on function public.record_national_rx_number(uuid, uuid, uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.record_national_rx_number(uuid, uuid, uuid, uuid, text) to service_role;
comment on function public.record_national_rx_number(uuid, uuid, uuid, uuid, text) is
  'Records the national Elektron retsept number on the doctor''s own current prescription that has prescription-only items.';

-- RX-07: what the public verification page may say about a code — that the
-- document is genuine and current. Never a medicine, never the patient.
create or replace function public.verify_prescription_code(p_code_hash text)
returns table (clinic_name text, doctor_name text, signed_at timestamptz, clinic_timezone text, status text)
language sql
stable
set search_path = public, pg_temp
as $$
  select c.name, d.name, p.signed_at, c.timezone, p.status::text
  from public.prescriptions p
  join public.clinics c on c.id = p.clinic_id
  join public.doctors d on d.id = p.doctor_id
  where p_code_hash ~ '^[0-9a-f]{64}$'
    and p.verification_code_hash = p_code_hash
    and p.status <> 'draft';
$$;

revoke all on function public.verify_prescription_code(text) from public, anon, authenticated;
grant execute on function public.verify_prescription_code(text) to service_role;
comment on function public.verify_prescription_code(text) is
  'Authenticity check for a printed prescription: clinic, doctor, date and whether it is current, replaced or cancelled. No medicines and no patient.';

-- ---------------------------------------------------------------------------
-- 8. Imports (run by the operator with a reviewed file; never from the browser)
-- ---------------------------------------------------------------------------

-- Rows: [{ inn, inn_latin, trade_name, form, strength, manufacturer, registration_number,
--          drug_class, aliases: [..], rx_only, controlled }]
create or replace function public.import_drug_catalog(
  p_source text,
  p_source_version text,
  p_checksum text,
  p_rows jsonb,
  p_deactivate_missing boolean
)
returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_import uuid;
  v_row jsonb;
  v_id uuid;
  v_reg text;
  v_inserted integer := 0;
  v_updated integer := 0;
  v_deactivated integer := 0;
begin
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 then
    raise exception 'drug import: no rows';
  end if;
  if p_deactivate_missing is null then
    raise exception 'drug import: say explicitly whether medicines missing from the file are deactivated';
  end if;

  insert into public.reference_data_imports (dataset, source, source_version, checksum, row_count)
  values ('drug_catalog', p_source, p_source_version, p_checksum, jsonb_array_length(p_rows))
  returning id into v_import;

  for v_row in select value from jsonb_array_elements(p_rows) loop
    v_reg := nullif(btrim(coalesce(v_row ->> 'registration_number', '')), '');
    v_id := null;
    if v_reg is not null then
      select d.id into v_id from public.drug_catalog d
      where d.owner_clinic_id is null and d.source = p_source and d.registration_number = v_reg;
    else
      select d.id into v_id from public.drug_catalog d
      where d.owner_clinic_id is null and d.source = p_source and d.registration_number is null
        and public.rx_search_key(d.inn) = public.rx_search_key(v_row ->> 'inn')
        and public.rx_search_key(coalesce(d.trade_name, '')) = public.rx_search_key(coalesce(v_row ->> 'trade_name', ''))
        and public.rx_search_key(coalesce(d.form, '')) = public.rx_search_key(coalesce(v_row ->> 'form', ''))
        and public.rx_search_key(coalesce(d.strength, '')) = public.rx_search_key(coalesce(v_row ->> 'strength', ''))
        and public.rx_search_key(coalesce(d.manufacturer, '')) = public.rx_search_key(coalesce(v_row ->> 'manufacturer', ''));
    end if;

    if v_id is null then
      insert into public.drug_catalog (
        inn, inn_latin, trade_name, form, strength, manufacturer, registration_number, drug_class, aliases,
        rx_only, controlled, active, source, source_version, import_id
      ) values (
        btrim(v_row ->> 'inn'),
        nullif(btrim(coalesce(v_row ->> 'inn_latin', '')), ''),
        nullif(btrim(coalesce(v_row ->> 'trade_name', '')), ''),
        nullif(btrim(coalesce(v_row ->> 'form', '')), ''),
        nullif(btrim(coalesce(v_row ->> 'strength', '')), ''),
        nullif(btrim(coalesce(v_row ->> 'manufacturer', '')), ''),
        v_reg,
        nullif(btrim(coalesce(v_row ->> 'drug_class', '')), ''),
        coalesce(array(select btrim(a) from jsonb_array_elements_text(coalesce(v_row -> 'aliases', '[]'::jsonb)) as a where btrim(a) <> ''), '{}'),
        (v_row ->> 'rx_only')::boolean,
        (v_row ->> 'controlled')::boolean,
        true, p_source, p_source_version, v_import
      );
      v_inserted := v_inserted + 1;
    else
      update public.drug_catalog
         set inn = btrim(v_row ->> 'inn'),
             inn_latin = nullif(btrim(coalesce(v_row ->> 'inn_latin', '')), ''),
             trade_name = nullif(btrim(coalesce(v_row ->> 'trade_name', '')), ''),
             form = nullif(btrim(coalesce(v_row ->> 'form', '')), ''),
             strength = nullif(btrim(coalesce(v_row ->> 'strength', '')), ''),
             manufacturer = nullif(btrim(coalesce(v_row ->> 'manufacturer', '')), ''),
             drug_class = nullif(btrim(coalesce(v_row ->> 'drug_class', '')), ''),
             aliases = coalesce(array(select btrim(a) from jsonb_array_elements_text(coalesce(v_row -> 'aliases', '[]'::jsonb)) as a where btrim(a) <> ''), '{}'),
             rx_only = (v_row ->> 'rx_only')::boolean,
             controlled = (v_row ->> 'controlled')::boolean,
             active = true,
             source_version = p_source_version,
             import_id = v_import,
             imported_at = now()
       where id = v_id;
      v_updated := v_updated + 1;
    end if;
  end loop;

  if p_deactivate_missing then
    -- Never deleted: signed prescriptions keep pointing at the entry.
    update public.drug_catalog
       set active = false
     where owner_clinic_id is null and source = p_source and import_id <> v_import and active;
    get diagnostics v_deactivated = row_count;
  end if;

  return jsonb_build_object('import_id', v_import, 'inserted', v_inserted, 'updated', v_updated, 'deactivated', v_deactivated);
end;
$$;

revoke all on function public.import_drug_catalog(text, text, text, jsonb, boolean) from public, anon, authenticated;
grant execute on function public.import_drug_catalog(text, text, text, jsonb, boolean) to service_role;
comment on function public.import_drug_catalog(text, text, text, jsonb, boolean) is
  'Loads the shared drug catalogue from a named source and version in one transaction. Every row must say rx_only and controlled explicitly. Missing entries are deactivated only when asked, never deleted.';

-- Rows: [{ code, name_uz, name_ru }]
create or replace function public.import_icd10_codes(
  p_source text,
  p_source_version text,
  p_checksum text,
  p_rows jsonb,
  p_deactivate_missing boolean
)
returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_import uuid;
  v_upserted integer;
  v_deactivated integer := 0;
begin
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 then
    raise exception 'icd10 import: no rows';
  end if;
  if p_deactivate_missing is null then
    raise exception 'icd10 import: say explicitly whether codes missing from the file are deactivated';
  end if;

  insert into public.reference_data_imports (dataset, source, source_version, checksum, row_count)
  values ('icd10', p_source, p_source_version, p_checksum, jsonb_array_length(p_rows))
  returning id into v_import;

  insert into public.icd10_codes (code, name_uz, name_ru, active, source, source_version, import_id)
  select upper(btrim(r.value ->> 'code')),
         nullif(btrim(coalesce(r.value ->> 'name_uz', '')), ''),
         nullif(btrim(coalesce(r.value ->> 'name_ru', '')), ''),
         true, p_source, p_source_version, v_import
  from jsonb_array_elements(p_rows) as r(value)
  on conflict (code) do update
    set name_uz = excluded.name_uz,
        name_ru = excluded.name_ru,
        active = true,
        source = excluded.source,
        source_version = excluded.source_version,
        import_id = excluded.import_id,
        imported_at = now();
  get diagnostics v_upserted = row_count;

  if p_deactivate_missing then
    update public.icd10_codes set active = false where import_id <> v_import and active;
    get diagnostics v_deactivated = row_count;
  end if;

  return jsonb_build_object('import_id', v_import, 'upserted', v_upserted, 'deactivated', v_deactivated);
end;
$$;

revoke all on function public.import_icd10_codes(text, text, text, jsonb, boolean) from public, anon, authenticated;
grant execute on function public.import_icd10_codes(text, text, text, jsonb, boolean) to service_role;
comment on function public.import_icd10_codes(text, text, text, jsonb, boolean) is
  'Loads ICD-10 codes with Uzbek/Russian names from a named source and version in one transaction.';

-- ---------------------------------------------------------------------------
-- 9. Access: every table is server-only
-- ---------------------------------------------------------------------------

alter table public.reference_data_imports enable row level security;
alter table public.drug_catalog enable row level security;
alter table public.drug_search_terms enable row level security;
alter table public.clinic_formulary enable row level security;
alter table public.icd10_codes enable row level security;
alter table public.patient_allergies enable row level security;
alter table public.prescriptions enable row level security;
alter table public.prescription_items enable row level security;
alter table public.prescription_templates enable row level security;

revoke all on table public.reference_data_imports from public, anon, authenticated, service_role;
revoke all on table public.drug_catalog from public, anon, authenticated, service_role;
revoke all on table public.drug_search_terms from public, anon, authenticated, service_role;
revoke all on table public.clinic_formulary from public, anon, authenticated, service_role;
revoke all on table public.icd10_codes from public, anon, authenticated, service_role;
revoke all on table public.patient_allergies from public, anon, authenticated, service_role;
revoke all on table public.prescriptions from public, anon, authenticated, service_role;
revoke all on table public.prescription_items from public, anon, authenticated, service_role;
revoke all on table public.prescription_templates from public, anon, authenticated, service_role;

-- The server reads and writes exactly what each workflow needs. Nothing is
-- deleted except a doctor's own draft and template and a formulary entry.
grant select, insert on table public.reference_data_imports to service_role;
grant select, insert, update on table public.drug_catalog to service_role;
grant select on table public.drug_search_terms to service_role;
grant select, insert, update, delete on table public.clinic_formulary to service_role;
grant select, insert, update on table public.icd10_codes to service_role;
grant select, insert, update on table public.patient_allergies to service_role;
grant select, insert, update, delete on table public.prescriptions to service_role;
grant select, insert, update, delete on table public.prescription_items to service_role;
grant select, insert, update, delete on table public.prescription_templates to service_role;

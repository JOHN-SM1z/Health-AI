-- Phone normalization that cannot match two different people.
--
-- The first version (20261002000001) read every 9-digit number as Uzbek —
-- "+298 123456" (the Faroe Islands) became 998298123456 — and let junk match:
-- "123" or forty nines are "the same number" for any two patients that typed
-- them. A wrong match is the dangerous direction (the website reuses a record
-- by phone + name; reception is asked to pick "the same patient"), a missed one
-- merely leaves a duplicate for reception to reconcile.
--
-- Rules now (public.normalize_phone(), mirrored by normalizePhone() in
-- src/lib/patients/phone.ts, and tested for parity):
--   1. No digits → NULL.
--   2. An explicit international marker — a "+" before the first digit, or a
--      leading "00" — means the digits that follow are a full international
--      number (country code first) and are kept exactly: no national-number
--      guessing, whatever their length.
--   3. Without such a marker the number is read as an Uzbek national number
--      (the clinics' region): 9 digits get 998; 10 digits with the trunk prefix
--      8 or 0 lose it and get 998; 12 digits starting 998 stay; anything else
--      stays as typed.
--   4. A result that is not a phone number we can match on — fewer than 7 or
--      more than 15 digits (E.164 allows at most 15) — is NULL: such a patient is
--      simply never offered as a duplicate. The number as typed stays in
--      patients.phone.
--
-- Still assumed: a number typed without "+" or "00" is Uzbek. A per-clinic
-- country is a later change (the generated column below cannot read another table).
--
-- phone_normalized is a stored generated column, so a new function body does not
-- recompute it: the column is dropped and added again (rewrites patients once;
-- no other object depends on it).
--
-- Reversible: re-create the function and column as in 20261002000001.

create or replace function public.normalize_phone(p_phone text)
returns text
language sql
immutable
parallel safe
set search_path = pg_catalog
as $$
  select case when length(n) between 7 and 15 then n else null end
  from (
    select case
      when raw = '' then ''
      -- "+" before the first digit, or a leading 00: international, kept as it is.
      when p_phone ~ '^[^0-9]*\+' then raw
      when raw like '00%' then substr(raw, 3)
      -- Otherwise an Uzbek national number: 9 digits, or 10 with the trunk prefix 8 / 0.
      when length(raw) = 9 then '998' || raw
      when length(raw) = 10 and left(raw, 1) in ('8', '0') then '998' || substr(raw, 2)
      else raw
    end as n
    from (select regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g') as raw) s
  ) t;
$$;

comment on function public.normalize_phone(text) is
  'Digits for matching one phone number however typed: a + before the first digit or a leading 00 marks an international number (kept as is); otherwise it is read as an Uzbek national number (9 digits, or 10 with trunk prefix 8/0, get 998). NULL when there are no digits or fewer than 7 / more than 15 of them.';

drop index if exists public.patients_clinic_phone_normalized_idx;
alter table public.patients drop column phone_normalized;
alter table public.patients
  add column phone_normalized text generated always as (public.normalize_phone(phone)) stored;
create index patients_clinic_phone_normalized_idx
  on public.patients (clinic_id, phone_normalized)
  where phone_normalized is not null;

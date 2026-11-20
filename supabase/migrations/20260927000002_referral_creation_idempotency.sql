-- Referral creation idempotency.
--
-- A doctor's accidental repeat of the same submission (double click, a
-- request retried after its response was lost) must not create a second
-- referral or a second audit event. The client sends one random key per
-- intended referral; the key is stored with the referral and is unique per
-- referring doctor, so a repeat of the request resolves to the referral it
-- already created (see createReferral in src/lib/referrals/service.ts).
--
-- The key is set once on insert: referrals_validate() treats every column
-- outside its per-transition allow-list as immutable, so it can never be
-- changed or cleared afterwards. It is not written to audit_events.

alter table public.referrals add column creation_key uuid;

comment on column public.referrals.creation_key is
  'Client-generated idempotency key of the request that created the referral; unique per referring doctor, immutable.';

-- Scoped to the referring doctor: one doctor's key can never resolve to, or
-- collide with, another doctor's referral.
create unique index referrals_creation_key_key
  on public.referrals (clinic_id, referring_doctor_id, creation_key)
  where creation_key is not null;

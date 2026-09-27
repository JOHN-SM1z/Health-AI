-- Clinical handoff (1 of 2): new enum values.
--
-- Kept in a migration of their own: a value added with ALTER TYPE … ADD VALUE
-- cannot be used in the transaction that added it, and
-- 20260928000002_clinical_handoff.sql uses them.
--
--   referral_status 'in_progress'  — the receiving doctor's consultation for
--     the referral has started (PENDING → ACCEPTED → IN_PROGRESS → COMPLETED).
--   clinical_record_type 'assessment' — the doctor's current assessment in
--     this consultation (distinct from a diagnosis).
--   clinical_record_type 'lab_order'  — a laboratory test ordered (distinct
--     from 'lab_result').
--   clinical_record_type 'follow_up'  — the follow-up plan / onward referral
--     note of the consultation.
--
-- Reversible only by recreating the types (Postgres cannot drop enum values);
-- nothing else depends on the new values until 20260928000002.

alter type public.referral_status add value if not exists 'in_progress' after 'accepted';

alter type public.clinical_record_type add value if not exists 'assessment' before 'diagnosis';
alter type public.clinical_record_type add value if not exists 'lab_order' before 'lab_result';
alter type public.clinical_record_type add value if not exists 'follow_up';

-- 0033: Clinical handoff workflow — Phase 2.
--
-- Adds the in_progress referral status to support the full lifecycle:
--   PENDING → ACCEPTED → IN_PROGRESS → COMPLETED
--   PENDING → DECLINED  (terminal)
--
-- Also:
--   * Adds referral_id FK on clinical_notes so notes created during a
--     referral consultation can be explicitly linked to that referral.
--   * Extends clinical_notes.note_type to the full clinical record set.
--   * Updates the status-transition trigger to allow accepted → in_progress
--     and in_progress → completed.
--   * Updates the patients RLS policy to grant referral-based doctor read
--     access for in_progress referrals (in addition to pending/accepted).

-- ---------- 1. Add in_progress to referral_status enum ----------
-- ALTER TYPE ... ADD VALUE is irreversible and cannot be done inside a
-- transaction on some PostgreSQL versions; use DO block defensively.

do $$
begin
  if not exists (
    select 1
    from pg_enum
    where enumtypid = 'public.referral_status'::regtype
      and enumlabel  = 'in_progress'
  ) then
    alter type public.referral_status add value 'in_progress' after 'accepted';
  end if;
end $$;

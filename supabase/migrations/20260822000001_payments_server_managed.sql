-- 0027: Payments become fully server-managed (audit finding, Phase 2).
--
-- Problem: the "payments update for management" RLS policy (0024) only
-- checks clinic membership + role (owner/admin/manager) — it places no
-- constraint on which columns or values can be written. Any management
-- role's authenticated (browser) session can therefore issue a raw
-- `supabase.from("payments").update({ status: "paid" })` and it succeeds,
-- completely bypassing transitionPaymentStatus() (src/lib/payments/status.ts)
-- — its legal-transition check, audit trail, and paid_at/paid_by bookkeeping.
-- This directly contradicts AGENTS.md: "Payment status is server-controlled.
-- A browser request can never mark payment as paid." It was previously
-- provable via the codebase's own test suite (role-authorization.test.ts,
-- "manager updates payments" asserted this write as *passing*).
--
-- A repo-wide grep confirms zero legitimate call sites update `payments`
-- via anything but the service-role client (every real mutation flows
-- through transitionPaymentStatus()). So rather than allow-listing "safe"
-- columns (the appointments_doctor_status_only pattern, needed there
-- because doctors legitimately change one column), this blocks direct
-- authenticated writes to `payments` outright — service-role (no JWT) is
-- untouched, exactly like the existing appointments_doctor_status_only
-- trigger's server-side bypass.
--
-- Reversible: `drop trigger payments_block_direct_write on public.payments;
-- drop function public.payments_block_direct_write();` in a follow-up
-- migration. Safe for existing records: only fires on UPDATE, never
-- touches existing rows, and never affects service-role (server API)
-- writes — the only path that has ever legitimately written this table.

create or replace function public.payments_block_direct_write()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Server-side code (service role, no JWT) is unrestricted — this is the
  -- ONLY legitimate path for a payment write. coalesce() matters: without
  -- JWT claims auth.role() is NULL, and `NULL <> 'authenticated'` is NULL
  -- (false), which would wrongly apply this restriction to server-side
  -- calls (mirrors appointments_doctor_status_only's guard, 20260818000025).
  if coalesce(auth.role(), '') <> 'authenticated' then
    return new;
  end if;

  -- No authenticated staff session — owner, admin, or manager — has any
  -- legitimate reason to update a payment row directly; every real
  -- mutation goes through the server-side payment API
  -- (transitionPaymentStatus()), which applies the legal-transition check,
  -- audit trail and idempotency this trigger cannot recreate. Block
  -- outright rather than allow-listing columns.
  raise exception 'Payments are server-managed; use the payment API';
end;
$$;

drop trigger if exists payments_block_direct_write on public.payments;
create trigger payments_block_direct_write
  before update on public.payments
  for each row execute function public.payments_block_direct_write();

comment on function public.payments_block_direct_write() is
  'Blocks any authenticated-session UPDATE on payments; only the service-role payment API (transitionPaymentStatus) may write this table.';

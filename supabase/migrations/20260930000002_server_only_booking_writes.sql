-- Appointments, patients and payments are written by the server only.
--
-- Every write the product makes to these tables goes through a server route
-- with the service-role client, after the route has authorized the caller:
-- bookings and walk-ins through book_appointment(), rescheduling through
-- reschedule_appointment(), cancellations and status changes through
-- /api/admin/appointments/[id] (notifications, audit and analytics included),
-- consultation starts through start_consultation(), payments through
-- transitionPaymentStatus(), patients through /api/admin/appointments,
-- /api/admin/patients and the Telegram identity code. No page writes them
-- with the signed-in user's token.
--
-- The role-based policies from 20260818000024 still let a signed-in staff
-- token write them directly over PostgREST (/rest/v1/...), bypassing all of
-- that:
--
--   * a manager could INSERT a payment already marked 'paid' — the rule is
--     that no browser request can mark a payment paid (payments_block_direct_write
--     only covers UPDATE);
--   * operational staff could INSERT appointments or move them (start_at,
--     doctor, patient) outside the transactional booking engine, set any
--     status with no notification to the patient, and write created_by /
--     cancelled_by as someone else;
--   * operational staff could create or edit patients outside the server's
--     validation.
--
-- This migration removes those write policies and the table-level write
-- grants for anon/authenticated. Reads are unchanged (RLS read policies stay),
-- the doctor's own appointment-status path was already server-only
-- (20260927000004), and the server's service-role writes are unaffected
-- (service_role bypasses RLS and keeps its grants).
--
-- Rollback: re-create the six policies exactly as in
-- 20260818000024_role_based_rls.sql and
-- `grant insert, update on public.appointments, public.patients, public.payments to authenticated;`.

drop policy if exists "appointments insert for operational staff" on public.appointments;
drop policy if exists "appointments update for operational staff" on public.appointments;
drop policy if exists "patients insert for operational staff" on public.patients;
drop policy if exists "patients update for operational staff" on public.patients;
drop policy if exists "payments insert for management" on public.payments;
drop policy if exists "payments update for management" on public.payments;

revoke insert, update, delete, truncate on public.appointments from anon, authenticated;
revoke insert, update, delete, truncate on public.patients from anon, authenticated;
revoke insert, update, delete, truncate on public.payments from anon, authenticated;

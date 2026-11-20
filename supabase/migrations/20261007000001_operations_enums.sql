-- Outpatient pilot enum values: a cashier staff role, distinct from reception,
-- and the queue-ticket notification.
--
-- Owner decision 2026-10-07 (docs/decisions/2026-10-07-retention-tenancy-refunds.md):
-- registration and cash collection are separate permissions even when a small
-- clinic gives both to one person; a cashier may refund only with a grant from
-- a manager or the owner (20261007000002).
--
-- An enum value cannot be used in the transaction that adds it, so it has its
-- own migration. Placed after 'receptionist' so the role order stays
-- owner, manager, admin, receptionist, cashier, lab, doctor.

alter type public.staff_role add value if not exists 'cashier' after 'receptionist';

-- The patient's digital queue ticket (no paper talon, owner 2026-10-07): sent
-- to the patient's own verified Telegram chat when a walk-in visit is queued
-- (20261007000002). Delivered by the existing notification worker, which
-- records the real delivery status.
alter type public.notification_job_type add value if not exists 'queue_ticket';

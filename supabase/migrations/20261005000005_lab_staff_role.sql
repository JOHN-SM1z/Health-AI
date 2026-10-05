-- Laboratory (Phase 3, 1 of 2): the lab staff role.
--
-- docs/labs/PHASE_1_DOMAIN_MODEL.md §2.2. Kept in a migration of its own: a
-- value added with ALTER TYPE … ADD VALUE cannot be used in the transaction
-- that added it, and 20261005000006 uses it.
--
--   lab — laboratory staff ("Laboratoriya xodimi"): sees the lab work queue
--         and the lab data needed to perform tests and enter results; never
--         patient lists, appointments, conversations, payments, analytics or
--         doctors' clinical text. Every existing policy on those tables names
--         its roles explicitly, so the new value gains nothing there.
--
-- Reversible only by recreating the type (Postgres cannot drop enum values).

alter type public.staff_role add value if not exists 'lab' after 'receptionist';

-- Online payment providers (Slice C, owner decision 2026-10-08: Rahmat). Separate from 20261008000012 because a new
-- enum value cannot be used in the transaction that adds it.
--   * rahmat      — the clinic's online payment provider. Its adapter fails closed until Rahmat's merchant API
--                   documentation, webhook signature scheme and credentials are in place.
--   * test_online — a signed test provider for local development and E2E only; production refuses to start with it.
alter type public.payment_provider add value if not exists 'rahmat';
alter type public.payment_provider add value if not exists 'test_online';

-- 0013: Table privileges.
--
-- The app talks to Postgres through supabase-js with two roles:
--   service_role — server-side (Next.js API routes) — bypasses RLS by design
--   authenticated — staff sessions (admin/doctor panels) — constrained by RLS
--
-- Without these grants, every API call fails with 42501 (permission denied).
-- Anonymous role intentionally receives NO table privileges; patients are
-- never anon SQL users.

grant select, insert, update, delete on all tables in schema public to service_role;
grant select, insert, update, delete on all tables in schema public to authenticated;

grant usage on schema public to service_role, authenticated;

-- New tables created later get the same grants automatically.
alter default privileges in schema public
  grant select, insert, update, delete on tables to service_role;

alter default privileges in schema public
  grant select, insert, update, delete on tables to authenticated;
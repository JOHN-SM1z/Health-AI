-- The anonymous role has no table privileges in public — as 20260813000013
-- always intended ("Anonymous role intentionally receives NO table
-- privileges"), now also on a real Supabase project.
--
-- A Supabase project grants anon (and authenticated, service_role) privileges
-- on every table postgres creates in public through its own default
-- privileges; 20260813000013 only added grants and never took anon's away.
-- RLS still returned no rows to an anonymous request (no anon policy exists),
-- but the table was reachable: an anonymous `GET /rest/v1/patients` answered
-- 200 [] instead of being refused. Found by running the suites on the Supabase
-- CLI stack in CI.
--
-- Nothing reads a table with the anon role: patients use the server APIs,
-- staff sessions are `authenticated`, and the health check only asks for the
-- API root. anon keeps USAGE on the schema (PostgREST needs it to answer at
-- all) and EXECUTE on the functions that already allow it.
--
-- Rollback: `grant select, insert, update, delete on all tables in schema public to anon;`
-- (Supabase's default) — not recommended.

revoke all on all tables in schema public from anon;
revoke all on all sequences in schema public from anon;

-- Tables and sequences created later by this role (every migration) as well.
alter default privileges in schema public revoke all on tables from anon;
alter default privileges in schema public revoke all on sequences from anon;

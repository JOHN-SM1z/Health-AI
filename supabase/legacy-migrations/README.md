# Archived pilot migrations

`clinic-operations-pilot/` preserves 19 conflicting pilot migration files, unchanged, with a SHA-256 manifest. They are outside the Supabase migration directory and must never be replayed automatically alongside the canonical history.

The canonical baseline is remote `main` commit `990d082274575baadc402e9c7732d27fc56b1f45` (84 migrations). `supabase/migration-lineage.json` pins their original bytes. The active directory adds 10 forward migrations, including the final convergence of `set_updated_at()` to a `pg_catalog` search path. Historical canonical migrations were not rewritten. The generated `supabase/full-db-setup.sql` contains the same 94 active migrations.

`npm run test:schema-rehearsal` proves that a fresh install, an upgrade from that canonical baseline, and the generated SQL-editor bundle produce equivalent public tables, constraints, functions, indexes, triggers, RLS policies and role grants. It creates and removes uniquely named disposable databases; set an explicit loopback `SUPABASE_DB_URL` for a local PostgreSQL administrator. It does not load app environment files.

An installation that actually applied the archived pilot lineage is a different upgrade source. Inspect its migration ledger and data first, then prepare a separate, reviewed data-conversion migration. Do not delete its ledger entries, mark the canonical migrations applied without conversion, replay this archive, or use the SQL-editor bundle to overwrite a populated database. This repair did not connect to or migrate production.

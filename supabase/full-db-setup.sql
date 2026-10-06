-- RETIRED: the previous concatenated setup was stale and unsafe to run as one transaction.
-- Use the Supabase migration runner with supabase/migrations in filename order.
-- For local development: npm run db:reset-local (destructive to LOCAL dev data).
-- For existing deployments: inspect migration history and reconcile before applying.
-- Do not paste all migrations into one SQL Editor transaction: enum changes need commits.
do $$ begin raise exception 'Use the ordered migration runner; full-db-setup.sql is retired'; end $$;

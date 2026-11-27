begin;
select tablename from pg_tables where schemaname='public' and not rowsecurity;
rollback;

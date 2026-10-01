-- Post-migration checks of the upgrade rehearsal: every count must be 0 (the last one is information).
-- Retention, RLS, grants and search_path invariants of AGENTS.md, on the migrated, populated database.
\pset format aligned
select 'FKs not validated' as check, count(*) from pg_constraint where contype='f' and not convalidated;
select 'cascade FKs from retained domains to clinics/patients/appointments' as check, count(*) from pg_constraint
 where contype='f' and confdeltype='c' and conrelid::regclass::text in ('clinical_records','referrals','appointments','payments','conversations','messages','voice_messages','audit_events','retention_policies')
   and confrelid::regclass::text in ('clinics','patients','appointments');
select 'public tables without RLS' as check, count(*) from pg_tables t join pg_class c on c.relname=t.tablename and c.relnamespace='public'::regnamespace
 where t.schemaname='public' and not c.relrowsecurity;
select 'authenticated/anon SELECT on clinical tables' as check, count(*) from information_schema.role_table_grants
 where table_schema='public' and table_name in ('clinical_records','referrals') and grantee in ('authenticated','anon') and privilege_type='SELECT';
select 'authenticated/anon EXECUTE on new/privileged functions' as check, count(*) from information_schema.role_routine_grants
 where routine_schema='public' and routine_name in ('doctor_patient_access','review_referral_warning','department_has_receiving_doctor','start_consultation','start_walk_in_consultation') and grantee in ('authenticated','anon','PUBLIC');
select 'SECURITY DEFINER functions without a fixed search_path' as check, count(*) from pg_proc p where p.pronamespace='public'::regnamespace and p.prosecdef and not exists (select 1 from unnest(coalesce(p.proconfig,'{}')) c where c like 'search_path=%');
select 'phone_normalized out of range' as check, count(*) from public.patients where phone_normalized is not null and length(phone_normalized) not between 7 and 15;
select 'patients created before 20261002000002 (created_via null; information only)' as check, count(*) from public.patients where created_via is null;

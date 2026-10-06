begin;
select proname,has_function_privilege('authenticated',p.oid,'EXECUTE'),has_function_privilege('anon',p.oid,'EXECUTE') from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and proname in ('claim_due_notification_jobs','claim_webhook_update','finish_webhook_update','release_webhook_update','book_appointment','reschedule_appointment') order by proname;
rollback;

begin;
set local role anon;select clinic_id,count(*) from claim_due_notification_jobs(200) group by clinic_id;
rollback;

begin;
update notification_jobs set status='in_progress',updated_at=now()-interval '1 day' where id='00000000-0000-4000-8000-000000000091';select count(*) from claim_due_notification_jobs(200) where id='00000000-0000-4000-8000-000000000091';
rollback;

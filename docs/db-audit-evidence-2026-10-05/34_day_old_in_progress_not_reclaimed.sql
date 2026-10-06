begin;
insert into notification_jobs(id,clinic_id,type,scheduled_for,idempotency_key,status,updated_at)
values ('00000000-0000-4000-8000-000000000093','00000000-0000-4000-8000-000000000001','reminder_2h',now()-interval '2 days','audit-orphan','in_progress',now()-interval '1 day');
select updated_at < now()-interval '12 hours' from notification_jobs where id='00000000-0000-4000-8000-000000000093';
select count(*) from claim_due_notification_jobs(200) where id='00000000-0000-4000-8000-000000000093';
rollback;

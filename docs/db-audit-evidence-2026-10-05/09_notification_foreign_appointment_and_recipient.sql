begin;
set local role authenticated; set local request.jwt.claim.role='authenticated'; set local request.jwt.claim.sub='00000000-0000-4000-8000-000000000012';update notification_jobs set appointment_id='00000000-0000-4000-8000-000000000062',patient_telegram_user_id=100000003 where id='00000000-0000-4000-8000-000000000091';select appointment_id='00000000-0000-4000-8000-000000000062',patient_telegram_user_id=100000003 from notification_jobs where id='00000000-0000-4000-8000-000000000091';
rollback;

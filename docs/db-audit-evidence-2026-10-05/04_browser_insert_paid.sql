begin;
set local role authenticated; set local request.jwt.claim.role='authenticated'; set local request.jwt.claim.sub='00000000-0000-4000-8000-000000000012';insert into payments(clinic_id,appointment_id,patient_id,amount,status) values ('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000061','00000000-0000-4000-8000-000000000031',1,'paid');select status,amount,paid_at is null from payments where appointment_id='00000000-0000-4000-8000-000000000061';
rollback;

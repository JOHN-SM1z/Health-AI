begin;
set local role authenticated; set local request.jwt.claim.role='authenticated'; set local request.jwt.claim.sub='00000000-0000-4000-8000-000000000012';insert into payments(clinic_id,appointment_id,patient_id,amount) values ('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000061','00000000-0000-4000-8000-000000000032',100);select patient_id='00000000-0000-4000-8000-000000000032' from payments where appointment_id='00000000-0000-4000-8000-000000000061';
rollback;

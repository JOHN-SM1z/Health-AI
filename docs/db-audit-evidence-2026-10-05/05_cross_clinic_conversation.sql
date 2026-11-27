begin;
set local role authenticated; set local request.jwt.claim.role='authenticated'; set local request.jwt.claim.sub='00000000-0000-4000-8000-000000000012';insert into conversations(clinic_id,patient_id,channel) values ('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000032','mini_app');select count(*) from conversations where clinic_id='00000000-0000-4000-8000-000000000001' and patient_id='00000000-0000-4000-8000-000000000032';
rollback;

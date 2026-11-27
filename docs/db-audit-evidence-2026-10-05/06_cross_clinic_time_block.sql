begin;
set local role authenticated; set local request.jwt.claim.role='authenticated'; set local request.jwt.claim.sub='00000000-0000-4000-8000-000000000012';insert into doctor_time_blocks(clinic_id,doctor_id,starts_at,ends_at) values ('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000023','2030-01-07 11:00+00','2030-01-07 12:00+00');select count(*) from doctor_time_blocks where doctor_id='00000000-0000-4000-8000-000000000023';
rollback;

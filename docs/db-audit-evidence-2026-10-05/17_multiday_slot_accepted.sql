begin;
set local role authenticated; set local request.jwt.claim.role='authenticated'; set local request.jwt.claim.sub='00000000-0000-4000-8000-000000000011';insert into appointments(clinic_id,doctor_id,patient_id,service_id,start_at,end_at,status) values ('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000021','00000000-0000-4000-8000-000000000031','00000000-0000-4000-8000-000000000041','2030-01-08 10:00+00','2030-01-09 10:30+00','confirmed');select count(*) from appointments where end_at-start_at>interval '24 hours';
rollback;

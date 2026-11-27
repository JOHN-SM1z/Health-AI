begin;
set local role authenticated; set local request.jwt.claim.role='authenticated'; set local request.jwt.claim.sub='00000000-0000-4000-8000-000000000012';insert into doctor_services(doctor_id,service_id) values ('00000000-0000-4000-8000-000000000021','00000000-0000-4000-8000-000000000042');
rollback;

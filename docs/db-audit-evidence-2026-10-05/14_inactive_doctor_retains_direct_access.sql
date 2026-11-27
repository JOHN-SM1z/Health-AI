begin;
update doctors set active=false where id='00000000-0000-4000-8000-000000000021';set local role authenticated; set local request.jwt.claim.role='authenticated'; set local request.jwt.claim.sub='00000000-0000-4000-8000-000000000013';select count(*) from patients where id='00000000-0000-4000-8000-000000000031';select count(*) from appointments where id='00000000-0000-4000-8000-000000000061';
rollback;

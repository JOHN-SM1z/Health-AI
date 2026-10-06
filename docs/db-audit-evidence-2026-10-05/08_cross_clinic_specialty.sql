begin;
set local role authenticated; set local request.jwt.claim.role='authenticated'; set local request.jwt.claim.sub='00000000-0000-4000-8000-000000000012';update services set specialty_id='00000000-0000-4000-8000-000000000051' where id='00000000-0000-4000-8000-000000000041';select specialty_id='00000000-0000-4000-8000-000000000051' from services where id='00000000-0000-4000-8000-000000000041';
rollback;

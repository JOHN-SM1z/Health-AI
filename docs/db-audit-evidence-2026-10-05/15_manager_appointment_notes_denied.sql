begin;
set local role authenticated; set local request.jwt.claim.role='authenticated'; set local request.jwt.claim.sub='00000000-0000-4000-8000-000000000012';update appointments set notes='Synthetic operational note' where id='00000000-0000-4000-8000-000000000061';
rollback;

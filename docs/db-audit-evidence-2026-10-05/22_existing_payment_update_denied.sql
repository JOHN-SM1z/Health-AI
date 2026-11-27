begin;
set local role authenticated; set local request.jwt.claim.role='authenticated'; set local request.jwt.claim.sub='00000000-0000-4000-8000-000000000012';update payments set status='paid' where id='00000000-0000-4000-8000-000000000072';
rollback;

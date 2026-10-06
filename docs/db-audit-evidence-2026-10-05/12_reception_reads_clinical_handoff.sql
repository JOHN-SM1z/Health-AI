begin;
set local role authenticated; set local request.jwt.claim.role='authenticated'; set local request.jwt.claim.sub='00000000-0000-4000-8000-000000000015';select clinical_handoff_note='SYNTHETIC_CLINICAL_CONTENT' from referrals where id='00000000-0000-4000-8000-000000000101';
rollback;

begin;
set local role authenticated; set local request.jwt.claim.role='authenticated'; set local request.jwt.claim.sub='00000000-0000-4000-8000-000000000012';select count(*) from audit_events where new_values->>'clinical_handoff_note'='SYNTHETIC_CLINICAL_CONTENT';
rollback;

-- Read-only compatibility gate for codex/clinic-operations-pilot.
-- Run as the migration administrator. Returns schema metadata only, never patients.
-- Any row is a BLOCKER. No rows means these prerequisites exist; it does NOT
-- replace migration-history reconciliation, RLS tests, or workflow verification.
with required_columns(table_name, column_name) as (values
  ('patients', 'patient_number'),
  ('visits', 'clinic_id'), ('visits', 'patient_id'),
  ('payments', 'visit_id'),
  ('clinical_notes', 'content'), ('clinical_notes', 'visit_id'),
  ('referrals', 'referral_reason'), ('referrals', 'clinical_handoff_note'),
  ('referrals', 'updated_by'), ('referrals', 'idempotency_key'),
  ('referrals', 'revocation_reason'),
  ('lab_orders', 'created_by'), ('lab_orders', 'fingerprint'),
  ('lab_specimens', 'order_id'),
  ('lab_order_tests', 'order_id'), ('lab_result_drafts', 'order_id')
), required_rpcs(signature) as (values
  ('public.register_walk_in(uuid,uuid,uuid,uuid,text,text,uuid,uuid)'),
  ('public.transition_visit(uuid,uuid,uuid,text,text)'),
  ('public.doctor_patient_access(uuid,uuid,uuid)'),
  ('public.set_manual_visit_payment(uuid,uuid,uuid,public.payment_status,public.payment_status,text,text)'),
  ('public.operations_summary(uuid,uuid,date)'),
  ('public.lab_workbench(uuid,uuid,text,jsonb)')
)
select 'missing_column' as blocker, r.table_name || '.' || r.column_name as object
from required_columns r
where not exists (
  select 1 from information_schema.columns c
  where c.table_schema='public' and c.table_name=r.table_name and c.column_name=r.column_name
)
union all
select 'missing_rpc', signature from required_rpcs where to_regprocedure(signature) is null
union all
select 'rls_disabled', c.relname from pg_class c
join pg_namespace n on n.oid=c.relnamespace
where n.nspname='public' and c.relkind in ('r','p') and not c.relrowsecurity
order by blocker, object;

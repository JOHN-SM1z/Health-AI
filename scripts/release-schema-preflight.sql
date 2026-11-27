-- Read-only canonical schema compatibility gate. Returns metadata only.
-- Any row blocks release. No rows is necessary but does not replace tests.
with required_columns(table_name, column_name) as (values
  ('patients','patient_number'), ('patients','merged_into_patient_id'),
  ('visits','clinic_id'), ('visits','patient_id'), ('visits','kind'),
  ('appointments','queue_encounter'), ('clinical_records','appointment_id'),
  ('clinical_records','author_doctor_id'), ('clinical_records','corrects_record_id'),
  ('referrals','reason'), ('referrals','handoff_note'), ('referrals','expires_at'),
  ('visit_charges','clinic_id'), ('visit_transactions','clinic_id'),
  ('lab_order_items','clinic_id'), ('lab_results','clinic_id'),
  ('notification_jobs','claim_token'), ('notification_jobs','lease_until'),
  -- Structured prescribing (20261126000001): the doctor screens and the public verification page read these.
  ('drug_catalog','controlled'), ('drug_catalog','rx_only'), ('patient_allergies','substance_key'),
  ('prescriptions','clinical_record_id'), ('prescriptions','verification_code_hash'), ('prescription_items','rx_only_snapshot')
), required_rpcs(signature) as (values
  ('public.register_arrival(uuid,uuid,uuid,uuid,jsonb,uuid,uuid[])'),
  ('public.record_visit_payment(uuid,uuid,uuid,uuid,jsonb,numeric)'),
  ('public.transition_visit(uuid,uuid,uuid,text,text,text)'),
  ('public.start_visit_consultation(uuid,uuid,uuid,text)'),
  ('public.open_queue_encounter(uuid,uuid,uuid,uuid,uuid)'),
  ('public.doctor_patient_access(uuid,uuid)'),
  ('public.renew_notification_job_claim(uuid,uuid,uuid)'),
  ('public.finish_notification_job_claim(uuid,uuid,uuid,public.notification_job_status,text,bigint)'),
  ('public.search_drug_catalog(uuid,uuid,text,integer)'),
  ('public.search_icd10(text,integer)'),
  ('public.save_prescription_draft(uuid,uuid,uuid,uuid,uuid,uuid,jsonb,uuid,uuid)'),
  ('public.sign_prescription(uuid,uuid,uuid,uuid,text,text)'),
  ('public.cancel_prescription(uuid,uuid,uuid,uuid,text)'),
  ('public.record_national_rx_number(uuid,uuid,uuid,uuid,text)'),
  ('public.verify_prescription_code(text)')
), functions as (
  select signature, to_regprocedure(signature) as oid from required_rpcs
)
select 'missing_column' as blocker, r.table_name || '.' || r.column_name as object
from required_columns r where not exists (
  select 1 from information_schema.columns c where c.table_schema='public'
    and c.table_name=r.table_name and c.column_name=r.column_name
)
union all select 'missing_rpc', signature from functions where oid is null
union all select 'browser_rpc_grant', signature from functions
where oid is not null and (has_function_privilege('anon',oid,'execute') or has_function_privilege('authenticated',oid,'execute'))
union all select 'rls_disabled', c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace
where n.nspname='public' and c.relkind in ('r','p') and not c.relrowsecurity
union all select 'legacy_schema_present','clinical_notes' where to_regclass('public.clinical_notes') is not null
order by blocker, object;

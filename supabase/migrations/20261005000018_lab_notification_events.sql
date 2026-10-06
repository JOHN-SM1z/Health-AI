-- Laboratory (Phase 16): the lab lifecycle events as notification job types.
-- Enum values are added in their own migration (a new value cannot be used
-- in the transaction that adds it); 20261005000019 uses them.
--
--   lab_order_created     LAB_ORDER_CREATED
--   lab_sample_collected  LAB_SAMPLE_COLLECTED
--   lab_result_entered    LAB_RESULT_ENTERED (submitted for verification)
--   lab_result_verified   LAB_RESULT_VERIFIED
--   lab_result_ready      LAB_RESULT_READY (Phase 12, the patient's message)
--   lab_result_corrected  LAB_RESULT_CORRECTED
--   lab_order_cancelled   LAB_ORDER_CANCELLED

alter type public.notification_job_type add value if not exists 'lab_order_created';
alter type public.notification_job_type add value if not exists 'lab_sample_collected';
alter type public.notification_job_type add value if not exists 'lab_result_entered';
alter type public.notification_job_type add value if not exists 'lab_result_verified';
alter type public.notification_job_type add value if not exists 'lab_result_corrected';
alter type public.notification_job_type add value if not exists 'lab_order_cancelled';

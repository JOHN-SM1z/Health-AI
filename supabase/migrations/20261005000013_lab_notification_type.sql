-- Laboratory (Phase 12): a notification type for "your lab result is ready".
-- (An enum value is added in its own migration: it cannot be used in the
-- same transaction that adds it.)

alter type public.notification_job_type add value if not exists 'lab_result_ready';

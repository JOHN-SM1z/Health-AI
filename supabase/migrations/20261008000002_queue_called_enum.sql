-- Telegram queue follow-up (owner decision 2026-10-08): the "you are called"
-- message, sent when the desk, the doctor or the laboratory calls the
-- patient's number (20261008000003). Delivered by the existing notification
-- worker, which claims each job atomically and records the real delivery.
--
-- An enum value cannot be used in the transaction that adds it, so it has its
-- own migration.

alter type public.notification_job_type add value if not exists 'queue_called';

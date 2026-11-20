-- NT-03: a job whose claim lease expired is quarantined for human review,
-- never resent automatically. Separate migration: a new enum value must be
-- committed before it is used.
alter type public.notification_job_status add value if not exists 'quarantined';

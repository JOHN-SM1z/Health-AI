-- Scheduled jobs, run by the production Supabase project itself (pg_cron + pg_net).
--
-- Not a migration: local and CI databases have no pg_cron, and the app URL is
-- specific to one deployment. Run it in the production SQL editor. Re-running
-- replaces the jobs (pg_cron updates a job scheduled again under its name).
--
--   health-ai-process-notifications  */15 * * * *  POST /api/notifications/process
--                                    (reminders; also purges voice messages
--                                    past their retention)
--   health-ai-expire-referrals       7 * * * *     POST /api/referrals/expire
--   health-ai-cron-history-cleanup   17 3 * * *    keeps 7 days of cron.job_run_details
--
-- Both endpoints require `Authorization: Bearer <CRON_SECRET>`. The secret is
-- read from Supabase Vault each time a job runs — it never appears in the job
-- definition, cron.job_run_details or this file. Store it once, with the same
-- value as the app's CRON_SECRET (Dashboard → Project Settings → Vault, or the
-- SQL editor):
--
--   select vault.create_secret('<CRON_SECRET>', 'health_ai_cron_secret');
--
-- To rotate: select vault.update_secret(id, '<new CRON_SECRET>')
--            from vault.secrets where name = 'health_ai_cron_secret';
--
-- pg_net's request queue briefly holds the Authorization header. Supabase
-- installs pg_net with grants to anon/authenticated that the project's
-- postgres role cannot revoke; the `net` schema is not exposed through the
-- API (keep it out of the exposed schemas), so API callers cannot reach it.
--
-- The app must be reachable from the internet at app_url: Vercel Deployment
-- Protection must not cover the production domain, or every call gets the
-- Vercel login page (HTTP 200, HTML) instead of reaching the app.
--
-- Check the last runs (pg_net keeps responses for 6 hours):
--
--   select id, status_code, left(content, 200) as body, created
--     from net._http_response order by id desc limit 10;
--   -- expected: 200 {"ok":true,...}; 401 = Vault secret missing or not equal
--   -- to CRON_SECRET; 200 with an HTML body = blocked by Deployment Protection.
--
--   select jobname, schedule, active from cron.job order by jobname;

create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron with schema pg_catalog;

do $$
declare
  -- The production URL of the app, without a trailing slash.
  v_app_url constant text := 'https://health-ai-handly.vercel.app';
  v_call constant text := $call$
    select net.http_post(
      url := %L,
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || coalesce(
          (select decrypted_secret from vault.decrypted_secrets where name = 'health_ai_cron_secret' limit 1),
          ''
        )
      ),
      body := '{}'::jsonb,
      timeout_milliseconds := 60000
    );
  $call$;
begin
  if v_app_url !~ '^https://[^/]+$' then
    raise exception 'scheduled jobs: app URL must be https://host without a trailing slash (got %)', v_app_url;
  end if;

  perform cron.schedule(
    'health-ai-process-notifications',
    '*/15 * * * *',
    format(v_call, v_app_url || '/api/notifications/process')
  );
  perform cron.schedule(
    'health-ai-expire-referrals',
    '7 * * * *',
    format(v_call, v_app_url || '/api/referrals/expire')
  );
  perform cron.schedule(
    'health-ai-cron-history-cleanup',
    '17 3 * * *',
    $cleanup$ delete from cron.job_run_details where end_time < now() - interval '7 days' $cleanup$
  );
end;
$$;

select jobname, schedule, active from cron.job where jobname like 'health-ai-%' order by jobname;

-- 0030: Recover orphaned Telegram webhook idempotency claims (Phase 3
-- Telegram audit).
--
-- claim_webhook_update() inserts a 'processing' row and nothing revisits it
-- unless the SAME request's own try/catch later calls
-- release_webhook_update() (on a thrown error) or finish_webhook_update()
-- (on success) — see src/app/api/telegram/webhook/route.ts. If the
-- serverless function is killed mid-request before either runs (the route's
-- own maxDuration=60 timeout, an OOM, a mid-deploy restart, a hung outbound
-- fetch with no client-side timeout), the row is stuck at
-- status='processing' forever: Telegram's automatic retry of that
-- update_id then finds claim_webhook_update() returning false (ON CONFLICT
-- DO NOTHING sees the existing row) and the webhook route reports it as an
-- already-handled duplicate. The update is never actually processed and
-- the patient's message is silently dropped, with no further retry from
-- either side.
--
-- Fix: a claim still 'processing' after 5 minutes is treated as abandoned
-- and becomes reclaimable. Real handlers complete in low single-digit
-- seconds; 5 minutes is comfortably past the route's own 60s hard cutoff
-- (so it never reclaims a request that could still legitimately be
-- running) while short enough that a genuinely stuck message recovers on
-- Telegram's own webhook retry instead of being lost forever. Purely
-- additive to the existing INSERT .. ON CONFLICT DO NOTHING claim: the
-- concurrent-delivery race (exactly one winner) and the
-- already-finished-never-reprocessed guarantee are both unchanged for any
-- claim inside the 5-minute window. Reversible by restoring the prior
-- DO NOTHING body from 20260813000014_release_blockers.sql.

create or replace function public.claim_webhook_update(p_source text, p_external_id text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.processed_webhooks (source, external_id, status)
  values (p_source, p_external_id, 'processing')
  on conflict (source, external_id) do update
    set status = 'processing', processed_at = now()
  where
    public.processed_webhooks.status = 'processing'
    and public.processed_webhooks.processed_at < now() - interval '5 minutes';
  return found;
end;
$$;

comment on function public.claim_webhook_update(text, text) is
  'Atomically claims a webhook update for processing (INSERT .. ON CONFLICT DO NOTHING semantics for a fresh or truly-concurrent id). Also reclaims a prior claim stuck in processing for over 5 minutes — an orphaned claim left by a killed/crashed request — so that update is not silently lost forever.';

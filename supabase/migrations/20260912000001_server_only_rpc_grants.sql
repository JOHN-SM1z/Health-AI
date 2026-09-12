-- Server-only RPCs must not be callable from a browser.
--
-- claim_due_notification_jobs, claim_webhook_update, finish_webhook_update and
-- release_webhook_update are SECURITY DEFINER job/idempotency primitives called
-- exclusively by server code through the service-role client
-- (src/lib/notifications/processor.ts, src/lib/telegram/idempotency.ts). They
-- shipped with PostgreSQL's default PUBLIC EXECUTE plus Supabase's blanket
-- anon/authenticated grants, which left them reachable UNAUTHENTICATED over
-- PostgREST at /rest/v1/rpc/<name> with nothing but the publishable anon key.
--
-- Before this migration anyone on the internet could:
--
--   * claim_due_notification_jobs(p_limit) — claim pending reminder rows,
--     both READING their patient-directed payload and flipping them to
--     'in_progress' so the real worker skips them and the patient never gets
--     the appointment reminder;
--   * claim_webhook_update('telegram', <update_id>) — pre-claim update ids so
--     genuine Telegram deliveries are discarded as duplicates and the bot
--     silently stops answering patients;
--   * release_/finish_webhook_update(...) — corrupt that same idempotency
--     ledger, re-opening the double-send window the claim exists to close.
--
-- service_role keeps EXECUTE: it is the only caller anywhere in the codebase.
--
-- Deliberately NOT touched here (smallest safe change):
--   * is_clinic_staff() / is_platform_admin() — read-only predicates about the
--     CURRENT session that return false for an anonymous caller, so they leak
--     nothing. RLS evaluates them as the invoking role, so `authenticated`
--     MUST keep EXECUTE or every policy built on them starts erroring on
--     legitimate traffic.
--   * the trigger functions (appointments_validate_slot, payments_block_direct_write,
--     audit_track_changes, …) — they return `trigger`, which PostgREST cannot
--     expose as an RPC and which Postgres refuses to call directly
--     ("trigger functions can only be called as triggers"), so the grant is
--     not actually reachable. Revoking it would buy no measurable protection
--     while putting the booking and payment write paths at risk, so it is
--     left for a change that can be exercised against a disposable database
--     first.

revoke execute on function public.claim_due_notification_jobs(integer) from public, anon, authenticated;
grant execute on function public.claim_due_notification_jobs(integer) to service_role;

revoke execute on function public.claim_webhook_update(text, text) from public, anon, authenticated;
grant execute on function public.claim_webhook_update(text, text) to service_role;

revoke execute on function public.finish_webhook_update(text, text) from public, anon, authenticated;
grant execute on function public.finish_webhook_update(text, text) to service_role;

revoke execute on function public.release_webhook_update(text, text) from public, anon, authenticated;
grant execute on function public.release_webhook_update(text, text) to service_role;

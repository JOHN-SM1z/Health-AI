import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { logger } from "@/lib/logger";

/**
 * Atomic idempotency for webhook deliveries. Telegram retries failed
 * webhook calls; duplicate deliveries must not dispatch work twice.
 *
 * The claim is a single INSERT .. ON CONFLICT DO NOTHING in the database
 * (claim_webhook_update), so concurrent deliveries of the same update_id
 * race for one row: exactly one wins and the rest are duplicates.
 *
 * Failure is NOT swallowed: a handler failure releases the claim so the
 * next delivery claims and retries it. Only a claimed (processing) row may
 * be finished or released; a fully processed id stays immutable.
 *
 * Every claim returns a claim token (20261116000001). Finish and release pass
 * it back, so a worker whose claim expired and was re-claimed by another
 * worker can no longer finish or delete that newer claim.
 */
export type WebhookClaim = string;

/** Claims an update. Returns the claim token, or null for a duplicate. */
export async function claimWebhookProcessing(source: string, externalId: string): Promise<WebhookClaim | null> {
  const supabase = createAdminClient();
  const { data, error } = await supabase.rpc("claim_webhook_update_token", {
    p_source: source,
    p_external_id: externalId,
  });
  if (error) {
    logger.error("webhook claim failed", { source, externalId, error: error.message });
    throw new Error("webhook claim failed");
  }
  return typeof data === "string" && data.length > 0 ? data : null;
}

/** Marks a claimed update processed. Safe to call once per claim. */
export async function finishWebhookProcessing(source: string, externalId: string, claim: WebhookClaim): Promise<void> {
  const supabase = createAdminClient();
  const { data, error } = await supabase.rpc("finish_webhook_update", {
    p_source: source,
    p_external_id: externalId,
    p_claim_token: claim,
  });
  if (error) {
    logger.error("webhook finish failed", { source, externalId, error: error.message });
    throw new Error("webhook finish failed");
  }
  if (data !== true) {
    // Our claim expired and another worker owns the update now; it will finish it.
    logger.warn("webhook finish skipped: claim no longer owned", { source, externalId });
  }
}

/** Releases a claimed update so the next delivery can retry it. */
export async function releaseWebhookProcessing(source: string, externalId: string, claim: WebhookClaim): Promise<void> {
  const supabase = createAdminClient();
  const { error } = await supabase.rpc("release_webhook_update", {
    p_source: source,
    p_external_id: externalId,
    p_claim_token: claim,
  });
  if (error) {
    logger.error("webhook release failed", { source, externalId, error: error.message });
  }
}

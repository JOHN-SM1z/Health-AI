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
 * next delivery claims and retries it. Every claim carries an ownership
 * token (claim_webhook, 20261116000003): only the worker holding the token of
 * the current claim may finish or release it, so a slow worker can never
 * finish or release a newer worker's claim. A processed id stays immutable.
 */
/** Claims an update. Returns the claim token, or null when another worker holds it or it was already processed. */
export async function claimWebhookProcessing(source: string, externalId: string): Promise<string | null> {
  const supabase = createAdminClient();
  const { data, error } = await supabase.rpc("claim_webhook", {
    p_source: source,
    p_external_id: externalId,
  });
  if (error) {
    logger.error("webhook claim failed", { source, error: error.message });
    throw new Error("webhook claim failed");
  }
  return typeof data === "string" && data.length > 0 ? data : null;
}

/** Marks a claimed update processed. Only the holder of the claim token can. */
export async function finishWebhookProcessing(source: string, externalId: string, claimToken: string): Promise<void> {
  const supabase = createAdminClient();
  const { data, error } = await supabase.rpc("finish_webhook", {
    p_source: source,
    p_external_id: externalId,
    p_claim_token: claimToken,
  });
  if (error) {
    logger.error("webhook finish failed", { source, error: error.message });
    throw new Error("webhook finish failed");
  }
  if (data !== true) logger.warn("webhook finish: claim no longer held", { source });
}

/** Releases a claimed update so the next delivery can retry it. Only the holder of the claim token can. */
export async function releaseWebhookProcessing(source: string, externalId: string, claimToken: string): Promise<void> {
  const supabase = createAdminClient();
  const { error } = await supabase.rpc("release_webhook", {
    p_source: source,
    p_external_id: externalId,
    p_claim_token: claimToken,
  });
  if (error) {
    logger.error("webhook release failed", { source, error: error.message });
  }
}

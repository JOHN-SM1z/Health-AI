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
 */
export async function claimWebhookProcessing(source: string, externalId: string): Promise<boolean> {
  const supabase = createAdminClient();
  const { data, error } = await supabase.rpc("claim_webhook_update", {
    p_source: source,
    p_external_id: externalId,
  });
  if (error) {
    logger.error("webhook claim failed", { source, externalId, error: error.message });
    throw new Error("webhook claim failed");
  }
  return data === true;
}

/** Marks a claimed update processed. Safe to call once per claim. */
export async function finishWebhookProcessing(source: string, externalId: string): Promise<void> {
  const supabase = createAdminClient();
  const { error } = await supabase.rpc("finish_webhook_update", {
    p_source: source,
    p_external_id: externalId,
  });
  if (error) {
    logger.error("webhook finish failed", { source, externalId, error: error.message });
    throw new Error("webhook finish failed");
  }
}

/** Releases a claimed update so the next delivery can retry it. */
export async function releaseWebhookProcessing(source: string, externalId: string): Promise<void> {
  const supabase = createAdminClient();
  const { error } = await supabase.rpc("release_webhook_update", {
    p_source: source,
    p_external_id: externalId,
  });
  if (error) {
    logger.error("webhook release failed", { source, externalId, error: error.message });
  }
}

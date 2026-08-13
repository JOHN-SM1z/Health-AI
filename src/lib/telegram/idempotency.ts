import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Idempotency for webhook deliveries. Telegram retries failed webhook calls;
 * duplicate deliveries must not create duplicate records or send duplicate
 * messages. Every processed update is marked in processed_webhooks.
 */
export async function isWebhookProcessed(source: string, externalId: string): Promise<boolean> {
  try {
    const supabase = createAdminClient();
    const { data } = await supabase
      .from("processed_webhooks")
      .select("source")
      .eq("source", source)
      .eq("external_id", externalId)
      .maybeSingle();
    return !!data;
  } catch {
    return false;
  }
}

export async function markWebhookProcessed(source: string, externalId: string): Promise<void> {
  try {
    const supabase = createAdminClient();
    await supabase
      .from("processed_webhooks")
      .upsert({ source, external_id: externalId }, { onConflict: "source,external_id" });
  } catch {
    // Best-effort: if this fails the next delivery re-processes idempotently.
  }
}
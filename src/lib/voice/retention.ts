import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { logger } from "@/lib/logger";

/** What a quoted transcript becomes once its voice message has expired. */
export const EXPIRED_VOICE_TEXT = "[Ovozli xabar saqlash muddati tugagani uchun o‘chirildi]";

/**
 * Enforces the retention the privacy page promises for voice messages: once
 * a voice message's expires_at (retention_days after transcription) has
 * passed, its audio is deleted from private storage, the transcripts and the
 * Telegram file reference are removed from its row, and the conversation
 * message that quoted the transcript is redacted. The row itself stays, so
 * the conversation still shows that a voice message was received.
 *
 * Run by the scheduled job (POST /api/notifications/process). A row whose
 * audio could not be deleted is left untouched and retried on the next run.
 */
export async function purgeExpiredVoiceMessages(limit = 200): Promise<{ purged: number; failed: number }> {
  const supabase = createAdminClient();
  const { data: due, error } = await supabase
    .from("voice_messages")
    .select("id, clinic_id, storage_path")
    .lte("expires_at", new Date().toISOString())
    .is("purged_at", null)
    .order("expires_at", { ascending: true })
    .limit(limit);
  if (error) {
    logger.error("voice retention: could not list expired voice messages", { code: error.code });
    return { purged: 0, failed: 0 };
  }

  let purged = 0;
  let failed = 0;
  for (const row of due ?? []) {
    if (row.storage_path) {
      const { error: removeError } = await supabase.storage.from("voice-messages").remove([row.storage_path]);
      if (removeError) {
        failed++;
        logger.error("voice retention: audio not deleted, will retry", { voiceMessageId: row.id, error: removeError.message });
        continue;
      }
    }
    const { error: clearError } = await supabase
      .from("voice_messages")
      .update({
        storage_path: null,
        transcription: null,
        corrected_transcription: null,
        telegram_file_id: null,
        telegram_file_unique_id: null,
        purged_at: new Date().toISOString(),
      })
      .eq("id", row.id)
      .eq("clinic_id", row.clinic_id);
    const { error: redactError } = await supabase
      .from("messages")
      .update({ content: EXPIRED_VOICE_TEXT })
      .eq("voice_message_id", row.id)
      .eq("clinic_id", row.clinic_id);
    if (clearError || redactError) {
      failed++;
      logger.error("voice retention: transcript not removed, will retry", {
        voiceMessageId: row.id,
        code: clearError?.code ?? redactError?.code,
      });
      continue;
    }
    purged++;
  }
  if (purged || failed) logger.info("voice retention run", { purged, failed });
  return { purged, failed };
}

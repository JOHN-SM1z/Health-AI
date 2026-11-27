import "server-only";
import { logger } from "@/lib/logger";
import type { createAdminClient } from "@/lib/supabase/admin";
import type { Database } from "@/lib/supabase/database.types";

type WorkerClient = ReturnType<typeof createAdminClient>;
export type NotificationClaim = Pick<Database["public"]["Tables"]["notification_jobs"]["Row"], "id" | "clinic_id" | "claim_token">;
export type WorkerOutcome = "pending" | "sent" | "failed" | "skipped" | "quarantined";

/** Never send when the DB cannot verify the current claim and extend its lease. */
export async function renewNotificationClaim(db: WorkerClient, job: NotificationClaim): Promise<boolean> {
  if (!job.claim_token) return false;
  try {
    const { data, error } = await db.rpc("renew_notification_job_claim", {
      p_clinic_id: job.clinic_id,
      p_job_id: job.id,
      p_claim_token: job.claim_token,
    });
    if (error) logger.error("notification claim renewal failed", { jobId: job.id, code: error.code });
    return !error && data === true;
  } catch {
    logger.error("notification claim renewal unavailable", { jobId: job.id });
    return false;
  }
}

/** All outcomes are fenced, including skip/retry, and DB errors are not success. */
export async function finishNotificationClaim(
  db: WorkerClient,
  job: NotificationClaim,
  status: WorkerOutcome,
  errorCode: string | null = null,
  telegramMessageId?: number,
): Promise<boolean> {
  if (!job.claim_token) return false;
  try {
    const { data, error } = await db.rpc("finish_notification_job_claim", {
      p_clinic_id: job.clinic_id,
      p_job_id: job.id,
      p_claim_token: job.claim_token,
      p_status: status,
      p_error: errorCode ?? undefined,
      p_telegram_message_id: telegramMessageId,
    });
    if (error || data !== true) {
      // No unguarded fallback UPDATE: leave uncertain bookkeeping for quarantine.
      logger.error("notification claim outcome not recorded", { jobId: job.id, status, code: error?.code });
      return false;
    }
    return true;
  } catch {
    logger.error("notification claim finalization unavailable", { jobId: job.id, status });
    return false;
  }
}

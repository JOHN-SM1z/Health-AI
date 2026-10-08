import "server-only";
import { after } from "next/server";
import { logger } from "@/lib/logger";
import { processDueNotificationJobs } from "@/lib/notifications/processor";

/**
 * Delivers a clinic's due notification jobs right after this response,
 * instead of waiting for the scheduled worker (every 15 minutes) — a queue
 * ticket or "you are called" is useless a quarter of an hour late. Safe to
 * call any number of times: jobs are claimed atomically (FOR UPDATE SKIP
 * LOCKED), so this run and the scheduled one never send the same job twice.
 * Outside a request (scripts, tests) it does nothing and the scheduled
 * worker delivers as before.
 */
export function deliverClinicNotificationsSoon(clinicId: string): void {
  try {
    after(async () => {
      try {
        await processDueNotificationJobs(20, [clinicId]);
      } catch (e) {
        logger.error("notifications: immediate delivery failed", { clinicId, error: e instanceof Error ? e.message : String(e) });
      }
    });
  } catch {
    // Not inside a request: the scheduled worker delivers.
  }
}

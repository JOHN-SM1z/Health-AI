import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { isCronRequest } from "@/lib/cron-auth";
import { processDueNotificationJobs } from "@/lib/notifications/processor";
import { purgeExpiredVoiceMessages } from "@/lib/voice/retention";
import { logger } from "@/lib/logger";
import { handleApiError } from "@/lib/api/errors";
import { rateLimit, keyFromIp } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Authenticated endpoint that processes due notification jobs and removes
 * voice messages past their retention.
 * Production: Google Cloud Scheduler calls this every 15 minutes with
 * `Authorization: Bearer $CRON_SECRET`.
 * Development: invoke manually with curl (see README).
 */
export async function POST(request: NextRequest) {
  try {
    if (!isCronRequest(request)) {
      return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
    }

    const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
    const limit = rateLimit({ key: keyFromIp(ip, "cron"), limit: 10, windowMs: 60_000 });
    if (!limit.ok) {
      return NextResponse.json({ ok: false, error: "too many requests" }, { status: 429 });
    }

    const result = await processDueNotificationJobs();
    // The same scheduled run enforces voice-message retention (privacy page
    // §2); a failure there never holds back the reminders.
    let voice = { purged: 0, failed: 0 };
    try {
      voice = await purgeExpiredVoiceMessages();
    } catch (e) {
      logger.error("voice retention run threw", { error: e instanceof Error ? e.message : String(e) });
    }
    return NextResponse.json({ ok: true, ...result, voicePurged: voice.purged, voicePurgeFailed: voice.failed });
  } catch (e) {
    return handleApiError(e);
  }
}
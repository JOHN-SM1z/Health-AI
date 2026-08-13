import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { env } from "@/lib/env";
import { processDueNotificationJobs } from "@/lib/notifications/processor";
import { handleApiError } from "@/lib/api/errors";
import { rateLimit, keyFromIp } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Authenticated endpoint that processes due notification jobs.
 * Production: Google Cloud Scheduler calls this every 15 minutes with
 * `Authorization: Bearer $CRON_SECRET`.
 * Development: invoke manually with curl (see README).
 */
export async function POST(request: NextRequest) {
  try {
    const auth = request.headers.get("authorization");
    const expected = `Bearer ${env.CRON_SECRET}`;
    if (!auth || auth !== expected) {
      return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
    }

    const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
    const limit = rateLimit({ key: keyFromIp(ip, "cron"), limit: 10, windowMs: 60_000 });
    if (!limit.ok) {
      return NextResponse.json({ ok: false, error: "too many requests" }, { status: 429 });
    }

    const result = await processDueNotificationJobs();
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    return handleApiError(e);
  }
}
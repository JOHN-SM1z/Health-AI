import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { isCronRequest } from "@/lib/cron-auth";
import { expireDueReferrals } from "@/lib/referrals/service";
import { handleApiError } from "@/lib/api/errors";
import { rateLimit, keyFromIp } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

/**
 * Scheduled job: records every open referral past expires_at as expired, in
 * every clinic (audited 'referral_expired' by the database, actor: system).
 * Access already ended at expires_at — every access decision compares with
 * the database clock — so this keeps statuses and the audit trail current
 * even for referrals nobody opens. Production: Cloud Scheduler, hourly, with
 * `Authorization: Bearer $CRON_SECRET`.
 */
export async function POST(request: NextRequest) {
  try {
    if (!isCronRequest(request)) {
      return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
    }
    const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
    if (!rateLimit({ key: keyFromIp(ip, "cron-referrals"), limit: 10, windowMs: 60_000 }).ok) {
      return NextResponse.json({ ok: false, error: "too many requests" }, { status: 429 });
    }
    const expired = await expireDueReferrals();
    if (expired === null) return NextResponse.json({ ok: false, error: "sweep failed" }, { status: 503 });
    return NextResponse.json({ ok: true, expired });
  } catch (e) {
    return handleApiError(e);
  }
}

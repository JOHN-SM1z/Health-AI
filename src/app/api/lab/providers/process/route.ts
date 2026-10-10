import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { isCronRequest } from "@/lib/cron-auth";
import { handleApiError } from "@/lib/api/errors";
import { processExternalLabRequests } from "@/lib/labs/providers/service";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * The external-laboratory worker (Phase 15): sends queued send-outs and
 * polls sent ones. Called by the scheduler with `Authorization: Bearer
 * $CRON_SECRET`, like /api/notifications/process.
 */
export async function POST(request: NextRequest) {
  try {
    if (!isCronRequest(request)) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
    return NextResponse.json({ ok: true, ...(await processExternalLabRequests()) });
  } catch (e) {
    return handleApiError(e);
  }
}

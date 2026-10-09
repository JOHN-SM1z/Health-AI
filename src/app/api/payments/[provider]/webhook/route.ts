import { NextResponse, type NextRequest } from "next/server";
import { rateLimit, keyFromIp } from "@/lib/rate-limit";
import { logger } from "@/lib/logger";
import { handleOnlinePaymentWebhook } from "@/lib/payments/online/service";

export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 64 * 1024;
type RouteContext = { params: Promise<{ provider: string }> };

/**
 * An online payment provider's webhook (Slice C). The provider's signature is verified over the raw body before any
 * database call: an unsigned or forged request gets 401 and changes nothing. A verified event is settled exactly once
 * (payment_provider_events), whatever the provider retries.
 */
export async function POST(request: NextRequest, ctx: RouteContext) {
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  if (!rateLimit({ key: keyFromIp(ip, "payment-webhook"), limit: 120, windowMs: 60_000 }).ok) {
    return NextResponse.json({ ok: false }, { status: 429 });
  }
  const { provider } = await ctx.params;
  const length = Number(request.headers.get("content-length") ?? "0");
  if (length > MAX_BODY_BYTES) return NextResponse.json({ ok: false }, { status: 413 });
  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) return NextResponse.json({ ok: false }, { status: 413 });

  try {
    const result = await handleOnlinePaymentWebhook(provider, raw, request.headers);
    if (!result) {
      logger.warn("payment webhook rejected: signature", { provider });
      return NextResponse.json({ ok: false }, { status: 401 });
    }
    return NextResponse.json({ ok: true, outcome: result.outcome });
  } catch {
    // The provider retries; the event was not claimed (the transaction rolled back).
    return NextResponse.json({ ok: false }, { status: 500 });
  }
}

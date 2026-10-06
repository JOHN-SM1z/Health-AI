import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { handleApiError, ok } from "@/lib/api/errors";
import { uuidSchema } from "@/lib/api/validate";
import { handleProviderWebhook } from "@/lib/labs/providers/service";
import { keyFromIp, rateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * A provider pushes status or results (Phase 15). The provider's adapter
 * authenticates the request (signature over the raw body) before anything is
 * read; unknown providers, bad signatures and bad payloads get nothing.
 * Repeated deliveries are harmless (idempotent per provider order / result).
 */
export async function POST(request: NextRequest, ctx: RouteContext) {
  try {
    const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
    const limit = rateLimit({ key: keyFromIp(ip, "lab-provider-webhook"), limit: 120, windowMs: 60_000 });
    if (!limit.ok) return NextResponse.json({ ok: false, error: "too many requests" }, { status: 429 });
    const { id } = await ctx.params;
    if (!uuidSchema.safeParse(id).success) return NextResponse.json({ ok: false, error: "not found" }, { status: 404 });
    const rawBody = await request.text();
    if (rawBody.length > 256 * 1024) return NextResponse.json({ ok: false, error: "too large" }, { status: 413 });
    return ok(await handleProviderWebhook(id, { headers: request.headers, rawBody }));
  } catch (e) {
    return handleApiError(e);
  }
}

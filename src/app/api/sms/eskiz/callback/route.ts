import { timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { rateLimit, keyFromIp } from "@/lib/rate-limit";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

/**
 * Eskiz delivery reports (20261008000013). Eskiz does not sign its callbacks, so the URL carries a long secret
 * (ESKIZ_CALLBACK_SECRET); without it: 401. A report can only move an existing message to "delivered" or "failed" —
 * it never creates anything, and it carries no phone number or text we keep. Field names follow Eskiz's documentation
 * (message_id / status, e.g. DELIVRD); confirm them with a live test message before turning SMS on.
 */
function keyMatches(given: string | null): boolean {
  const expected = process.env.ESKIZ_CALLBACK_SECRET ?? "";
  if (expected.length < 32 || !given) return false;
  const candidate = Buffer.from(given);
  const secret = Buffer.from(expected);
  return candidate.length === secret.length && timingSafeEqual(candidate, secret);
}

const DELIVERED = new Set(["DELIVRD", "DELIVERED"]);
const FAILED = new Set(["UNDELIV", "UNDELIVERABLE", "EXPIRED", "REJECTD", "REJECTED", "FAILED"]);

export async function POST(request: NextRequest) {
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  if (!rateLimit({ key: keyFromIp(ip, "eskiz-callback"), limit: 300, windowMs: 60_000 }).ok) return NextResponse.json({ ok: false }, { status: 429 });
  if (!keyMatches(request.nextUrl.searchParams.get("key"))) return NextResponse.json({ ok: false }, { status: 401 });

  let fields: Record<string, unknown>;
  const type = request.headers.get("content-type") ?? "";
  try {
    if (type.includes("application/json")) {
      const body: unknown = await request.json();
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        return NextResponse.json({ ok: false }, { status: 400 });
      }
      fields = body as Record<string, unknown>;
    } else {
      fields = Object.fromEntries(await request.formData());
    }
  } catch {
    return NextResponse.json({ ok: false }, { status: 400 });
  }
  const messageId = fields.message_id ?? fields.id;
  const id = typeof messageId === "string" || typeof messageId === "number" ? String(messageId).trim() : "";
  const status = typeof fields.status === "string" ? fields.status.trim().toUpperCase() : "";
  if (!id || id.length > 100 || (!DELIVERED.has(status) && !FAILED.has(status))) {
    return NextResponse.json({ ok: true, ignored: true });
  }

  try {
    // Provider message IDs are unique within this provider. The status guard
    // makes repeated or out-of-order terminal reports harmless.
    const { error } = await createAdminClient()
      .from("sms_messages")
      .update(DELIVERED.has(status) ? { status: "delivered", delivered_at: new Date().toISOString() } : { status: "failed", error_code: status })
      .eq("provider", "eskiz")
      .eq("provider_message_id", id)
      .eq("status", "sent");
    if (!error) return NextResponse.json({ ok: true });
  } catch {
    // The provider can retry after a transient connection failure.
  }
  logger.error("Eskiz delivery report could not be recorded");
  return NextResponse.json({ ok: false }, { status: 503 });
}

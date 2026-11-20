import { timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { rateLimit, keyFromIp } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

/**
 * Eskiz delivery reports (20261008000013). Eskiz does not sign its callbacks, so the URL carries a long secret
 * (ESKIZ_CALLBACK_SECRET); without it: 401. A report can only move an existing message to "delivered" or "failed" —
 * it never creates anything, and it carries no phone number or text we keep. Field names follow Eskiz's documentation
 * (message_id / status, e.g. DELIVRD); confirm them with a live test message before turning SMS on.
 */
function keyMatches(given: string | null): boolean {
  const expected = process.env.ESKIZ_CALLBACK_SECRET ?? "";
  if (expected.length < 32 || !given || given.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}

const DELIVERED = new Set(["DELIVRD", "DELIVERED"]);
const FAILED = new Set(["UNDELIV", "UNDELIVERABLE", "EXPIRED", "REJECTD", "REJECTED", "FAILED"]);

export async function POST(request: NextRequest) {
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  if (!rateLimit({ key: keyFromIp(ip, "eskiz-callback"), limit: 300, windowMs: 60_000 }).ok) return NextResponse.json({ ok: false }, { status: 429 });
  if (!keyMatches(request.nextUrl.searchParams.get("key"))) return NextResponse.json({ ok: false }, { status: 401 });

  let fields: Record<string, string> = {};
  const type = request.headers.get("content-type") ?? "";
  try {
    if (type.includes("application/json")) fields = (await request.json()) as Record<string, string>;
    else fields = Object.fromEntries([...(await request.formData()).entries()].map(([k, v]) => [k, String(v)]));
  } catch {
    return NextResponse.json({ ok: false }, { status: 400 });
  }
  const id = String(fields.message_id ?? fields.id ?? "").slice(0, 100);
  const status = String(fields.status ?? "").toUpperCase();
  if (!id || (!DELIVERED.has(status) && !FAILED.has(status))) return NextResponse.json({ ok: true, ignored: true });

  await createAdminClient()
    .from("sms_messages")
    .update(DELIVERED.has(status) ? { status: "delivered", delivered_at: new Date().toISOString() } : { status: "failed", error_code: status.slice(0, 40) })
    .eq("provider", "eskiz")
    .eq("provider_message_id", id)
    .eq("status", "sent");
  return NextResponse.json({ ok: true });
}

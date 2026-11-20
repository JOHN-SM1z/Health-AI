import "server-only";
import { timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";
import { env } from "@/lib/env";

/**
 * Whether a request carries `Authorization: Bearer $CRON_SECRET` — the
 * scheduler's credential. Constant-time; fails closed on a missing header or
 * secret. (Production refuses to start with a missing or default secret, see
 * src/lib/env.ts.)
 */
export function isCronRequest(request: NextRequest): boolean {
  const auth = request.headers.get("authorization");
  const expected = env.CRON_SECRET ? `Bearer ${env.CRON_SECRET}` : null;
  if (!auth || !expected) return false;
  const a = Buffer.from(auth);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

import type { NextRequest } from "next/server";
import { ApiError } from "@/lib/api/errors";

/**
 * A multipart POST is the one request a foreign page can send without CORS:
 * refuse any Origin other than this site's own ("null" or garbage included).
 * A request without an Origin header (same-origin navigation, server tools)
 * passes; session cookies are SameSite and still required.
 */
export function assertSameOrigin(request: NextRequest): void {
  const origin = request.headers.get("origin");
  if (!origin) return;
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  let originHost = "";
  try {
    originHost = new globalThis.URL(origin).host;
  } catch {
    originHost = "";
  }
  if (!host || originHost !== host) {
    throw new ApiError(403, "So‘rov boshqa saytdan yuborilgan", "cross_site_request");
  }
}

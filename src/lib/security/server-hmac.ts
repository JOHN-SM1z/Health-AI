import "server-only";
import { createHmac } from "node:crypto";
import { ApiError } from "@/lib/api/errors";

/**
 * An opaque, server-keyed token for a value the browser must be able to send back but must not be able to read or
 * reconstruct — for example a key built from a patient's passport, JSHSHIR and date of birth. Keyed with the service-role
 * key (server-only, present wherever the server runs), separated per purpose, hex SHA-256.
 *
 * A plain hash would not do: identity values come from small spaces (a date of birth, a 9-character passport number) and
 * a bare hash of them can be reversed by trying every value.
 */
export function serverHmac(purpose: string, value: string): string {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new ApiError(503, "Server sozlanmagan", "not_configured");
  return createHmac("sha256", key).update(`${purpose}\u0000${value}`).digest("hex");
}

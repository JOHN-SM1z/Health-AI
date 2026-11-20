import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { logger } from "@/lib/logger";
import { rateLimit } from "@/lib/rate-limit";

/**
 * A rate limit counted in Postgres (consume_rate_limit), so it holds across
 * every server instance — for limits that guard clinical data, where the
 * in-memory limiter would multiply with the number of instances. If the
 * database cannot be asked, this instance's in-memory limit applies instead,
 * so there is always a limit.
 */
export async function sharedRateLimit(opts: {
  key: string;
  limit: number;
  windowMs: number;
}): Promise<{ ok: boolean; retryAfterSeconds: number }> {
  try {
    const { data, error } = await createAdminClient().rpc("consume_rate_limit", {
      p_key: opts.key,
      p_limit: opts.limit,
      p_window_seconds: Math.max(1, Math.ceil(opts.windowMs / 1000)),
    });
    const result = data as { allowed?: boolean; retry_after_seconds?: number } | null;
    if (!error && typeof result?.allowed === "boolean") {
      return { ok: result.allowed, retryAfterSeconds: result.retry_after_seconds ?? Math.ceil(opts.windowMs / 1000) };
    }
    logger.warn("shared rate limit unavailable, using the instance limit", { code: error?.code });
  } catch (e) {
    logger.warn("shared rate limit threw, using the instance limit", { error: String(e) });
  }
  return rateLimit(opts);
}

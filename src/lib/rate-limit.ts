/**
 * In-memory fixed-window rate limiter, per server instance — with N
 * instances a caller gets up to N times the limit. Used for the public,
 * IP-keyed limits (pair with a load-balancer policy for a global cap). Limits
 * that guard clinical data use sharedRateLimit() (rate-limit-shared.ts),
 * counted in Postgres across every instance.
 */
type Bucket = { count: number; resetAt: number };

const buckets = new Map<string, Bucket>();

export class RateLimitExceededError extends Error {
  constructor() {
    super("rate limit exceeded");
    this.name = "RateLimitExceededError";
  }
}

export function rateLimit(opts: {
  key: string;
  limit: number;
  windowMs: number;
}): { ok: boolean; retryAfterSeconds: number } {
  const now = Date.now();
  const bucket = buckets.get(opts.key);

  if (!bucket || bucket.resetAt <= now) {
    buckets.set(opts.key, { count: 1, resetAt: now + opts.windowMs });
    return { ok: true, retryAfterSeconds: Math.ceil(opts.windowMs / 1000) };
  }

  if (bucket.count >= opts.limit) {
    return { ok: false, retryAfterSeconds: Math.ceil((bucket.resetAt - now) / 1000) };
  }

  bucket.count += 1;
  return { ok: true, retryAfterSeconds: Math.ceil((bucket.resetAt - now) / 1000) };
}

/** Bounded cleanup so the map does not grow without limit. */
export function pruneRateLimits(maxAgeMs = 10 * 60 * 1000) {
  const now = Date.now();
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt + maxAgeMs < now) buckets.delete(key);
  }
}

export function keyFromIp(ip: string | null, suffix: string): string {
  return `${ip ?? "unknown"}:${suffix}`;
}
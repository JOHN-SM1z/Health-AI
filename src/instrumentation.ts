/**
 * Server startup hook. Runs once per server instance, before any request is
 * served (see Next.js instrumentation file convention).
 *
 * Fail-closed policy for production: if required secrets are missing or
 * insecure defaults are in use, startup THROWS — Cloud Run restarts the
 * instance until the operator fixes the configuration. A misconfigured
 * production service must never serve traffic.
 */
/** Shared secrets that guard the cron jobs and every Telegram webhook. */
const MIN_SECRET_LENGTH = 32;
const PLACEHOLDER_SECRETS = new Set(["change-me-in-production", "your-random-secret", "changeme", "secret"]);

/** Too short to resist guessing, a placeholder copied from the docs, or one character repeated. */
function weakSecret(value: string): boolean {
  return value.length < MIN_SECRET_LENGTH || PLACEHOLDER_SECRETS.has(value.toLowerCase()) || /^(.)\1*$/.test(value);
}

/** The test payment provider in a production build: explicit flag and a local Supabase stack (E2E only). */
function testOnlinePaymentAllowed(): boolean {
  return (
    process.env.ALLOW_TEST_ONLINE_PAYMENT === "true" &&
    !!process.env.TEST_ONLINE_PAYMENT_SECRET &&
    !weakSecret(process.env.TEST_ONLINE_PAYMENT_SECRET) &&
    /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/?$/.test(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "")
  );
}

export function register() {
  if (process.env.NODE_ENV !== "production") return;
  if (process.env.NEXT_PHASE === "phase-production-build") return;

  const missing: string[] = [];

  // Every admin/doctor page and API route resolves its session through
  // these — without them getStaffContext() throws on first use and the
  // dashboard never renders. Fail at startup instead of on first request.
  // Mirrors the NEXT_PUBLIC_*/legacy-name fallback used by the actual
  // Supabase client constructors (server.ts, admin.ts).
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY;
  if (!supabaseUrl) {
    missing.push("NEXT_PUBLIC_SUPABASE_URL (or SUPABASE_URL) — required for every staff session lookup");
  }
  if (!supabaseAnonKey) {
    missing.push("NEXT_PUBLIC_SUPABASE_ANON_KEY (or SUPABASE_ANON_KEY) — required for every staff session lookup");
  }
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    missing.push("SUPABASE_SERVICE_ROLE_KEY — required by every privileged server-side data query");
  }

  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || weakSecret(cronSecret)) {
    missing.push(`CRON_SECRET (must be set, at least ${MIN_SECRET_LENGTH} random characters — e.g. openssl rand -hex 32 — and not a documented placeholder)`);
  }

  // TELEGRAM_WEBHOOK_SECRET seeds the per-bot HMAC secret every clinic's
  // webhook is validated against (botWebhookSecret() in
  // src/lib/telegram/bots.ts). Per-clinic bots are activated by clinic
  // admins from their own dashboard at any time after deploy — this is NOT
  // gated by the legacy, optional TELEGRAM_BOT_TOKEN (used only for
  // platform admin notifications, never for patient-facing bots). Gating
  // this check on TELEGRAM_BOT_TOKEN let production start successfully
  // with zero working Telegram webhooks for every clinic whenever the
  // legacy var was left unset, which is the common case. Required
  // unconditionally, exactly like CRON_SECRET.
  if (!process.env.TELEGRAM_WEBHOOK_SECRET) {
    missing.push("TELEGRAM_WEBHOOK_SECRET (required to validate every clinic's Telegram webhook — any clinic admin can activate a bot at any time)");
  } else if (weakSecret(process.env.TELEGRAM_WEBHOOK_SECRET)) {
    missing.push(`TELEGRAM_WEBHOOK_SECRET (at least ${MIN_SECRET_LENGTH} random characters and not a documented placeholder — every clinic's webhook secret is derived from it)`);
  }

  if (process.env.ENABLE_TELEGRAM_DEV_MODE === "true") {
    missing.push("ENABLE_TELEGRAM_DEV_MODE must not be enabled in production");
  }

  // Online payment (Mini App): the test provider only against a local database with the explicit flag (E2E of a
  // production build); Rahmat only once its adapter is implemented — never a provider that cannot verify payments.
  const online = process.env.ONLINE_PAYMENT_PROVIDER ?? "none";
  if (online === "test_online" && !testOnlinePaymentAllowed()) {
    missing.push("ONLINE_PAYMENT_PROVIDER=test_online is for local development and E2E only");
  }
  if (online === "rahmat") {
    missing.push("ONLINE_PAYMENT_PROVIDER=rahmat (the Rahmat adapter is not implemented yet: merchant API documentation, webhook signature scheme and credentials are required)");
  }
  if (!["none", "rahmat", "test_online"].includes(online)) {
    missing.push(`ONLINE_PAYMENT_PROVIDER=${online} is not a known provider`);
  }

  if ((process.env.PAYMENT_PROVIDER ?? "manual") !== "manual") {
    missing.push(
      "PAYMENT_PROVIDER (only 'manual' is implemented; Click/Payme require merchant credentials and a verified adapter — failing at startup instead of during a patient's payment attempt)",
    );
  }

  if (missing.length > 0) {
    throw new Error(`Failing closed: production startup blocked — ${missing.join("; ")}`);
  }
}

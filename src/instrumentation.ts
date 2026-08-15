/**
 * Server startup hook. Runs once per server instance, before any request is
 * served (see Next.js instrumentation file convention).
 *
 * Fail-closed policy for production: if required secrets are missing or
 * insecure defaults are in use, startup THROWS — Cloud Run restarts the
 * instance until the operator fixes the configuration. A misconfigured
 * production service must never serve traffic.
 */
export function register() {
  if (process.env.NODE_ENV !== "production") return;
  if (process.env.NEXT_PHASE === "phase-production-build") return;

  const missing: string[] = [];

  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || cronSecret === "change-me-in-production") {
    missing.push("CRON_SECRET (must be set and must not be the known default 'change-me-in-production')");
  }

  if (process.env.TELEGRAM_BOT_TOKEN && !process.env.TELEGRAM_WEBHOOK_SECRET) {
    missing.push("TELEGRAM_WEBHOOK_SECRET (Telegram is enabled via TELEGRAM_BOT_TOKEN, so the webhook secret is required)");
  }

  if (process.env.ENABLE_TELEGRAM_DEV_MODE === "true") {
    missing.push("ENABLE_TELEGRAM_DEV_MODE must not be enabled in production");
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

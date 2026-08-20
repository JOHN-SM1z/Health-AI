import "server-only";
import { z } from "zod";
import { logger } from "@/lib/logger";

/** True when running `next build` / static generation (env may be incomplete). */
export const isBuildTime = process.env.NEXT_PHASE === "phase-production-build";

// Hosting platforms (e.g. Vercel) store blank env vars as ""; treat those as
// unset so validation only fails on genuinely invalid values.
const optionalUrl = () =>
  z.preprocess((v) => (v === "" ? undefined : v), z.string().url().optional());

const envSchema = z.object({
  NEXT_PUBLIC_APP_URL: optionalUrl(),
  NEXT_PUBLIC_SUPABASE_URL: optionalUrl(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),

  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_WEBHOOK_SECRET: z.string().optional(),
  TELEGRAM_WEBHOOK_URL: optionalUrl(),
  TELEGRAM_ADMIN_CHAT_IDS: z.string().optional(),
  ENABLE_TELEGRAM_DEV_MODE: z.enum(["true", "false"]).default("false"),

  AI_BASE_URL: optionalUrl(),
  AI_API_KEY: z.string().optional(),
  AI_MODEL: z.string().default("gpt-4o-mini"),
  AI_TEMPERATURE: z.coerce.number().min(0).max(2).default(0.2),
  ENABLE_AI: z.enum(["true", "false"]).default("false"),

  TRANSCRIPTION_BASE_URL: optionalUrl(),
  TRANSCRIPTION_API_KEY: z.string().optional(),
  TRANSCRIPTION_MODEL: z.string().default("whisper-1"),
  ENABLE_TRANSCRIPTION: z.enum(["true", "false"]).default("false"),

  PAYMENT_PROVIDER: z.enum(["manual", "click", "payme", "uzum"]).default("manual"),
  NEXT_PUBLIC_PAYMENT_PROVIDER: z.enum(["manual", "click", "payme", "uzum"]).default("manual"),

  CLICK_MERCHANT_ID: z.string().optional(),
  CLICK_SERVICE_ID: z.string().optional(),
  CLICK_SECRET_KEY: z.string().optional(),
  CLICK_API_BASE_URL: optionalUrl(),
  CLICK_RETURN_URL: optionalUrl(),

  CRON_SECRET: z.string().default("change-me-in-production"),

  LOG_FORMAT: z.enum(["json", "pretty"]).default("pretty"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),

  CLINIC_TIMEZONE: z.string().default("Asia/Tashkent"),
});

const parsed = envSchema.safeParse(process.env);

// Fail closed at runtime, but let `next build` run with incomplete env:
// secrets/URLs are often only present in the deployed environment.
if (!parsed.success && !isBuildTime) {
  logger.error("invalid environment configuration", {
    issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
  });
  throw new Error("Invalid environment configuration. See logs for details.");
}

export const isProduction = process.env.NODE_ENV === "production";

// Payment truthfulness: `manual` is the only production-usable mode until a
// Click/PayMe adapter with merchant credentials exists. Selecting a real
// provider must fail at configuration/startup time — never silently, and
// never only when a patient tries to pay.
if (!isBuildTime && parsed.success && parsed.data.PAYMENT_PROVIDER !== "manual") {
  const provider = parsed.data.PAYMENT_PROVIDER;
  if (provider === "click") {
    const hasCredentials =
      !!parsed.data.CLICK_MERCHANT_ID && !!parsed.data.CLICK_SERVICE_ID && !!parsed.data.CLICK_SECRET_KEY;
    if (!hasCredentials) {
      logger.error("click provider missing merchant credentials", {});
      throw new Error(
        `PAYMENT_PROVIDER=click requires CLICK_MERCHANT_ID, CLICK_SERVICE_ID and CLICK_SECRET_KEY. ` +
          `Set the credentials or keep PAYMENT_PROVIDER=manual.`,
      );
    }
  } else {
    logger.error("unsupported payment provider", { provider });
    throw new Error(
      `PAYMENT_PROVIDER=${provider} is not implemented. ` +
        `Click requires merchant credentials and a verified adapter (payment-provider.md). ` +
        `Keep PAYMENT_PROVIDER=manual until then.`,
    );
  }
}

// At build time (or when env is incomplete) fall back to pure defaults so
// static generation can proceed; the runtime still validates strictly.
export const env = parsed.success ? parsed.data : envSchema.parse({});

// Production fails closed on a missing or known-default CRON_SECRET: the
// default "change-me-in-production" is public knowledge, and an unguarded
// cron endpoint would let anyone trigger notification processing.
if (!isBuildTime && isProduction && parsed.success && parsed.data.CRON_SECRET === "change-me-in-production") {
  logger.error("insecure cron secret", {});
  throw new Error(
    "CRON_SECRET must be set explicitly in production. The default value is rejected (fail closed).",
  );
}

/** Telegram dev mode is allowed ONLY outside production and MUST be explicit. */
export const telegramDevModeEnabled = () =>
  !isProduction && env.ENABLE_TELEGRAM_DEV_MODE === "true";

export const aiEnabled = () => env.ENABLE_AI === "true" && !!env.AI_API_KEY && !!env.AI_BASE_URL;

export const transcriptionEnabled = () =>
  env.ENABLE_TRANSCRIPTION === "true" && !!env.TRANSCRIPTION_API_KEY;

export const adminChatIds = (): number[] =>
  env.TELEGRAM_ADMIN_CHAT_IDS?.split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0) ?? [];
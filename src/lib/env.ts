import "server-only";
import { z } from "zod";
import { logger } from "@/lib/logger";

const envSchema = z.object({
  NEXT_PUBLIC_APP_URL: z.string().url().default("http://localhost:3000"),
  NEXT_PUBLIC_SUPABASE_URL: z.string().url().optional(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),

  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_WEBHOOK_SECRET: z.string().optional(),
  TELEGRAM_WEBHOOK_URL: z.string().optional(),
  TELEGRAM_ADMIN_CHAT_IDS: z.string().optional(),
  ENABLE_TELEGRAM_DEV_MODE: z.enum(["true", "false"]).default("false"),

  AI_BASE_URL: z.string().url().optional(),
  AI_API_KEY: z.string().optional(),
  AI_MODEL: z.string().default("gpt-4o-mini"),
  AI_TEMPERATURE: z.coerce.number().min(0).max(2).default(0.2),
  ENABLE_AI: z.enum(["true", "false"]).default("false"),

  TRANSCRIPTION_BASE_URL: z.string().url().optional(),
  TRANSCRIPTION_API_KEY: z.string().optional(),
  TRANSCRIPTION_MODEL: z.string().default("whisper-1"),
  ENABLE_TRANSCRIPTION: z.enum(["true", "false"]).default("false"),

  PAYMENT_PROVIDER: z.enum(["manual", "click", "payme"]).default("manual"),

  CRON_SECRET: z.string().default("change-me-in-production"),

  LOG_FORMAT: z.enum(["json", "pretty"]).default("pretty"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),

  CLINIC_TIMEZONE: z.string().default("Asia/Tashkent"),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  logger.error("invalid environment configuration", {
    issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
  });
  throw new Error("Invalid environment configuration. See logs for details.");
}

export const env = parsed.data;

/** True when running `next build` / static generation (env may be incomplete). */
export const isBuildTime = process.env.NEXT_PHASE === "phase-production-build";

export const isProduction = process.env.NODE_ENV === "production";

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
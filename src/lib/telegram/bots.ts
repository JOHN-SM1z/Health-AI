import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { Bot } from "grammy";
import { createAdminClient } from "@/lib/supabase/admin";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";

/**
 * Per-clinic Telegram bot registry.
 *
 * Every clinic owns a bot whose token lives ONLY in
 * clinic_telegram_integrations (service-role reads; zero RLS policies, so
 * no browser client can ever read it). Message routing resolves the clinic
 * from the bot username in the webhook URL, and outbound sends pick the
 * clinic's own bot instance — never a shared global bot.
 */

export type ClinicBotIntegration = {
  clinic_id: string;
  telegram_bot_token: string;
  telegram_bot_id: number;
  telegram_username: string | null;
  telegram_bot_name: string | null;
  status: string;
  enabled: boolean;
  webhook_status: string | null;
  webhook_error: string | null;
  validated_at: string | null;
};

const botCache = new Map<string, Bot>();

/** Resolves the clinic bot token. Returns null when the clinic has no
 * enabled, active integration. */
export async function getClinicBotToken(clinicId: string): Promise<string | null> {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("clinic_telegram_integrations")
    .select("telegram_bot_token, status, enabled")
    .eq("clinic_id", clinicId)
    .maybeSingle();
  if (error) {
    logger.error("clinic bot token lookup failed", { clinicId, error: error.message });
    return null;
  }
  if (!data || !data.enabled || data.status !== "active") return null;
  return data.telegram_bot_token;
}

/** Bot instance for a clinic (cached per clinic; token changes create a new
 * instance lazily). Throws only when the clinic has no active bot. */
export async function getClinicBot(clinicId: string): Promise<Bot> {
  const cached = botCache.get(clinicId);
  if (cached) return cached;
  const token = await getClinicBotToken(clinicId);
  if (!token) throw new Error(`clinic bot not configured: ${clinicId}`);
  const bot = new Bot(token);
  botCache.set(clinicId, bot);
  return bot;
}

/** Every enabled, active bot token owned by ONE clinic (server-side only).
 * Used to bind Mini App initData to the clinic that issued the link. */
export async function getActiveBotTokensForClinic(clinicId: string): Promise<string[]> {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("clinic_telegram_integrations")
    .select("telegram_bot_token")
    .eq("clinic_id", clinicId)
    .eq("enabled", true)
    .eq("status", "active");
  if (error) {
    logger.error("clinic bot token list failed", { clinicId, error: error.message });
    return [];
  }
  return (data ?? [])
    .map((r) => r.telegram_bot_token)
    .filter((t): t is string => t !== null);
}

/** Resolves a clinic + its integration from the bot username in the webhook
 * URL (?bot=<username>). Returns null when unknown or disabled. */
export async function resolveClinicByBotUsername(
  username: string,
): Promise<{ clinicId: string; integration: ClinicBotIntegration } | null> {
  const normalized = username.startsWith("@") ? username.slice(1) : username;
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("clinic_telegram_integrations")
    .select(
      "clinic_id, telegram_bot_token, telegram_bot_id, telegram_username, telegram_bot_name, status, enabled, webhook_status, webhook_error, validated_at",
    )
    .eq("telegram_username", normalized)
    .maybeSingle();
  if (error || !data) {
    if (error) logger.error("bot username lookup failed", { username, error: error.message });
    return null;
  }
  if (!data.enabled || data.status !== "active") return null;
  return { clinicId: data.clinic_id, integration: data as ClinicBotIntegration };
}

/** Per-bot webhook secret, derived from the global deployment secret so no
 * per-bot secret ever needs to be stored. Uniquely identifies the bot:
 * Telegram echoes it back with every update, giving us both authenticity and
 * routing confidence. */
export function botWebhookSecret(botToken: string): string {
  if (!env.TELEGRAM_WEBHOOK_SECRET) throw new Error("TELEGRAM_WEBHOOK_SECRET is not configured");
  return createHmac("sha256", env.TELEGRAM_WEBHOOK_SECRET).update(botToken).digest("hex");
}

export function timingSafeCheck(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * Every source this deployment's own public address could come from, in
 * priority order:
 *
 *  1. NEXT_PUBLIC_APP_URL — an explicit custom domain always wins.
 *  2. VERCEL_PROJECT_PRODUCTION_URL — Vercel's own stable production alias,
 *     set automatically with zero configuration on every Vercel deployment.
 *  3. VERCEL_URL — the current deployment's own address, same platform
 *     guarantee, one rung further from "canonical" (a preview deploy has one
 *     too), used only if the production alias isn't available for some reason.
 *  4. requestOrigin — the public origin of the request that's asking, when
 *     the caller has one (e.g. the activation endpoint always does; ongoing
 *     bot message handling never does).
 *
 * This is deliberately NOT limited to "when NEXT_PUBLIC_APP_URL is unset":
 * a real incident (2026-09-12) showed an operator setting it correctly in
 * the Vercel dashboard is not the same as it actually being live in the
 * running deployment — the variable can be saved for the wrong environment,
 * or saved but never picked up because NEXT_PUBLIC_* values are inlined at
 * *build* time and no new build ran. Vercel's own platform env vars need no
 * such manual step at all, so a forgotten or stale NEXT_PUBLIC_APP_URL can
 * no longer permanently strand webhook registration or the Mini App button
 * on a Vercel deployment — which is exactly where this app is deployed.
 */
export function appUrlCandidates(requestOrigin?: string | null): string[] {
  return [
    env.NEXT_PUBLIC_APP_URL ?? "",
    process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : "",
    process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "",
    requestOrigin ?? "",
  ];
}

/**
 * Builds an absolute HTTPS URL for `path` against the first candidate base
 * (see appUrlCandidates) that yields one. Telegram rejects both webhook and
 * web_app URLs outright when they aren't HTTPS, so this is never relaxed to
 * allow http: — a local http://localhost candidate correctly yields null.
 *
 * A t.me base is skipped even though it's technically valid https: NEXT_
 * PUBLIC_APP_URL=https://t.me/<bot>/<app> is a deliberate escape hatch
 * bookingLink() (handlers.ts) recognizes on its own as a deep link to send
 * a patient, but neither a webhook receiver nor a web_app button can live
 * at t.me itself — resolving one there would be nonsensical, not merely a
 * fallback of last resort.
 */
export function resolveHttpsAppUrl(path: string, requestOrigin?: string | null): string | null {
  for (const base of appUrlCandidates(requestOrigin)) {
    const trimmed = base.trim();
    if (!trimmed || trimmed === "https://t.me" || trimmed.startsWith("https://t.me/")) continue;
    try {
      const url = new URL(path, trimmed);
      if (url.protocol === "https:") return url.toString();
    } catch {
      // Malformed candidate (e.g. a garbled custom domain) — try the next one.
    }
  }
  return null;
}

/** Webhook URL a clinic's bot must be registered with. See resolveHttpsAppUrl
 * for the full fallback order. */
export function botWebhookUrl(username: string, requestOrigin?: string | null): string | null {
  return resolveHttpsAppUrl(`/api/telegram/webhook?bot=${encodeURIComponent(username)}`, requestOrigin);
}

/** Registers/refreshes the webhook for a bot. Idempotent. */
export async function registerBotWebhook(
  bot: Bot,
  username: string,
  requestOrigin?: string | null,
): Promise<{ ok: boolean; error?: string }> {
  const url = botWebhookUrl(username, requestOrigin);
  if (!url) {
    return { ok: false, error: "Webhook manzilini aniqlab bo‘lmadi: NEXT_PUBLIC_APP_URL HTTPS manzil emas" };
  }
  try {
    await bot.api.setWebhook(url, { secret_token: botWebhookSecret(bot.token), drop_pending_updates: false });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

import "server-only";
import { Bot } from "grammy";
import { createAdminClient } from "@/lib/supabase/admin";
import { registerBotWebhook } from "@/lib/telegram/bots";
import { logger } from "@/lib/logger";

/**
 * Bot activation (management-only, server-side).
 *
 * The operator pastes a bot token into the dashboard; the server validates
 * it with Telegram's getMe, stores it in clinic_telegram_integrations
 * (zero RLS policies — browsers can never read it), and registers the
 * per-bot webhook with the derived secret. The token NEVER leaves the
 * server after activation.
 */

export type ActivationResult = {
  ok: boolean;
  error?: string;
  username?: string;
  name?: string;
  botId?: number;
  webhookOk?: boolean;
  webhookError?: string;
};

export async function activateClinicBot(clinicId: string, telegramBotToken: string): Promise<ActivationResult> {
  const token = telegramBotToken.trim();
  if (!/^\d+:[A-Za-z0-9_-]{20,}$/.test(token)) {
    return { ok: false, error: "Bot token formati noto‘g‘ri" };
  }

  let bot: Bot;
  try {
    bot = new Bot(token);
    const me = await bot.api.getMe();
    if (!me.username) return { ok: false, error: "Telegram botda username topilmadi" };

    const supabase = createAdminClient();
    const { error: upsertError } = await supabase
      .from("clinic_telegram_integrations")
      .upsert(
        {
          clinic_id: clinicId,
          telegram_bot_token: token,
          telegram_bot_id: me.id,
          telegram_username: me.username,
          telegram_bot_name: me.first_name ?? null,
          status: "active",
          enabled: true,
          validated_at: new Date().toISOString(),
          last_error: null,
          webhook_error: null,
        },
        { onConflict: "clinic_id" },
      );
    if (upsertError) {
      logger.error("bot activation: integration upsert failed", { clinicId, error: upsertError.message });
      return { ok: false, error: "Bazaga saqlashda xatolik" };
    }

    const webhook = await registerBotWebhook(bot, me.username);
    await supabase
      .from("clinic_telegram_integrations")
      .update({
        webhook_status: webhook.ok ? "active" : "error",
        webhook_error: webhook.ok ? null : (webhook.error ?? "").slice(0, 500),
      })
      .eq("clinic_id", clinicId);

    logger.info("clinic bot activated", { clinicId, username: me.username, webhookOk: webhook.ok });
    return {
      ok: true,
      username: me.username,
      name: me.first_name ?? undefined,
      botId: me.id,
      webhookOk: webhook.ok,
      webhookError: webhook.ok ? undefined : webhook.error,
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    // A bad token fails at getMe; keep the failure visible in the dashboard.
    try {
      const supabase = createAdminClient();
      await supabase
        .from("clinic_telegram_integrations")
        .update({ status: "error", last_error: message.slice(0, 500) })
        .eq("clinic_id", clinicId);
    } catch {
      // status write is best-effort
    }
    logger.warn("bot activation failed", { clinicId, error: message });
    return { ok: false, error: "Telegram bilan bog‘lanib bo‘lmadi: token noto‘g‘ri yoki bot mavjud emas" };
  }
}

export async function deactivateClinicBot(clinicId: string): Promise<void> {
  const supabase = createAdminClient();
  const { data: integration } = await supabase
    .from("clinic_telegram_integrations")
    .select("telegram_bot_token")
    .eq("clinic_id", clinicId)
    .maybeSingle();
  if (integration?.telegram_bot_token) {
    try {
      await new Bot(integration.telegram_bot_token).api.deleteWebhook();
    } catch {
      // Webhook removal is best-effort; the integration row is the source of truth.
    }
  }
  await supabase
    .from("clinic_telegram_integrations")
    .update({ enabled: false, status: "disabled" })
    .eq("clinic_id", clinicId);
}
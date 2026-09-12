import "server-only";
import { Bot } from "grammy";
import { env, telegramDevModeEnabled } from "@/lib/env";
import { logger } from "@/lib/logger";
import { getClinicBot } from "@/lib/telegram/bots";

let bot: Bot | null = null;

export type TelegramMessagePayload = {
  chatId: number;
  text: string;
  replyMarkup?: unknown;
  parseMode?: "HTML" | "MarkdownV2";
};

/**
 * Returns the shared grammY bot instance for the legacy global bot
 * (admin notifications, platform-level sends). Throws when Telegram is not
 * configured — callers must check telegramConfigured() first.
 */
export function getBot(): Bot {
  if (bot) return bot;
  if (!env.TELEGRAM_BOT_TOKEN) {
    throw new Error("TELEGRAM_BOT_TOKEN is not configured");
  }
  bot = new Bot(env.TELEGRAM_BOT_TOKEN);
  return bot;
}

export function telegramConfigured(): boolean {
  return !!env.TELEGRAM_BOT_TOKEN && !telegramDevModeEnabled();
}

/**
 * Returns a NEW keyboard with web_app buttons downgraded (or removed).
 * Reply keyboards downgrade to a plain text button so they still route to
 * the text handler. Inline keyboards downgrade to a plain `url` link button
 * using the same address — Telegram opens that in an external browser
 * instead of embedding the Mini App, but it is never a dead end. A button
 * with no fallback URL to offer (defensive only; every web_app button we
 * build carries one) is dropped outright, since an inline button with no
 * action at all is invalid. Returns the original object when unchanged.
 */
function stripWebAppButtons(markup: unknown): unknown {
  if (typeof markup !== "object" || markup === null) return markup;
  const m = markup as Record<string, unknown>;
  const out: Record<string, unknown> = { ...m };
  let changed = false;

  for (const key of ["keyboard", "inline_keyboard"] as const) {
    const rows = m[key];
    if (!Array.isArray(rows)) continue;
    out[key] = rows
      .map((row) => {
        if (!Array.isArray(row)) return row;
        return row
          .map((btn) => {
            if (typeof btn !== "object" || btn === null) return btn;
            const b = btn as Record<string, unknown>;
            if (!("web_app" in b)) return btn;
            changed = true;
            const rest = { ...b };
            const webApp = rest.web_app as { url?: unknown } | undefined;
            delete rest.web_app;
            if (key === "keyboard") {
              // Reply keyboards: keep it as a plain text button.
              return rest;
            }
            // Inline keyboards: fall back to a plain link button so a
            // single-button row (e.g. the booking button) never collapses
            // to an empty, filtered-out row — a message telling the patient
            // to "tap the button below" must never leave them with no
            // button there. Only drop it if there is truly no URL to offer.
            const url = typeof webApp?.url === "string" ? webApp.url : undefined;
            if (!url) return null;
            return { ...rest, url };
            return null;
          })
          .filter((btn) => btn !== null);
      })
      .filter((row) => Array.isArray(row) && row.length > 0);
  }

  return changed ? out : m;
}

/**
 * Sends a plain text message THROUGH THE CLINIC'S OWN BOT. Returns the
 * Telegram message id, or null when sending is not possible (no active bot,
 * development mode). Never throws — failures are logged and reported.
 */
export async function sendTelegramMessage(payload: TelegramMessagePayload, clinicId?: string): Promise<number | null> {
  if (telegramDevModeEnabled()) {
    logger.info("telegram send skipped (dev mode)", { chatId: payload.chatId, clinicId });
    return null;
  }

  let target: Bot;
  if (clinicId) {
    try {
      target = await getClinicBot(clinicId);
    } catch {
      logger.warn("telegram send skipped (clinic bot not configured)", { chatId: payload.chatId, clinicId });
      return null;
    }
  } else if (telegramConfigured()) {
    target = getBot();
  } else {
    logger.info("telegram send skipped (not configured)", {
      chatId: payload.chatId,
      devMode: telegramDevModeEnabled(),
    });
    return null;
  }

  const send = async (markup: unknown): Promise<number | null> => {
    const res = await target.api.sendMessage(payload.chatId, payload.text, {
      reply_markup: markup as never,
      parse_mode: payload.parseMode ?? "HTML",
    });
    return res.message_id;
  };

  try {
    return await send(payload.replyMarkup);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    // Telegram rejects the WHOLE message when a button is invalid — either an
    // un-whitelisted web_app domain (BUTTON_URL_INVALID) or a malformed
    // keyboard. The bot must never look dead over a keyboard problem, so
    // degrade gracefully: first drop web_app buttons, then drop the keyboard
    // entirely, so the message still reaches the patient.
    const keyboardProblem =
      message.includes("BUTTON_URL_INVALID") || message.includes("KeyboardButton");
    if (keyboardProblem && payload.replyMarkup) {
      const stripped = stripWebAppButtons(payload.replyMarkup);
      if (stripped !== payload.replyMarkup) {
        try {
          const id = await send(stripped);
          logger.warn("telegram send succeeded without web_app buttons", { chatId: payload.chatId });
          return id;
        } catch {
          // Structural problem — fall through to a plain send.
        }
      }
      try {
        const id = await send(undefined);
        logger.warn("telegram send succeeded without keyboard", { chatId: payload.chatId });
        return id;
      } catch (e2) {
        logger.error("telegram send failed", {
          chatId: payload.chatId,
          error: e2 instanceof Error ? e2.message : String(e2),
        });
        return null;
      }
    }
    logger.error("telegram send failed", {
      chatId: payload.chatId,
      error: message,
    });
    return null;
  }
}

/** Fetches a Telegram file download URL (file_id -> file_path) using the
 * clinic's bot (the file belongs to that bot's chat). */
export async function getTelegramFileUrl(fileId: string, clinicId: string): Promise<string | null> {
  try {
    const target = await getClinicBot(clinicId);
    const file = await target.api.getFile(fileId);
    if (!file.file_path) return null;
    return `https://api.telegram.org/file/bot${target.token}/${file.file_path}`;
  } catch (e) {
    logger.error("telegram getFile failed", { error: e instanceof Error ? e.message : String(e) });
    return null;
  }
}

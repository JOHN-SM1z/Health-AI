import "server-only";
import { Bot } from "grammy";
import { env, telegramDevModeEnabled } from "@/lib/env";
import { logger } from "@/lib/logger";

let bot: Bot | null = null;

export type TelegramMessagePayload = {
  chatId: number;
  text: string;
  replyMarkup?: unknown;
  parseMode?: "HTML" | "MarkdownV2";
};

/**
 * Returns the shared grammY bot instance. Throws when Telegram is not
 * configured — callers must check telegramConfigured() first, and
 * development mode must be explicit (ENABLE_TELEGRAM_DEV_MODE=true).
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
 * Returns a NEW keyboard with web_app buttons removed (or, on reply
 * keyboards, downgraded to plain text buttons so they still route to the
 * text handler). Inline-keyboard buttons with no action are invalid, so
 * those are dropped entirely. Returns the original object when unchanged.
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
            if (key === "keyboard") {
              // Reply keyboards: keep it as a plain text button.
              const rest = { ...b };
              delete rest.web_app;
              return rest;
            }
            // Inline keyboards: a button without an action is invalid.
            return null;
          })
          .filter((btn) => btn !== null);
      })
      .filter((row) => Array.isArray(row) && row.length > 0);
  }

  return changed ? out : m;
}

/**
 * Sends a plain text message. Returns the Telegram message id, or null when
 * sending is not possible (development mode without a real bot).
 * Never throws — failures are logged and reported to the caller.
 */
export async function sendTelegramMessage(payload: TelegramMessagePayload): Promise<number | null> {
  if (!telegramConfigured()) {
    logger.info("telegram send skipped (not configured)", {
      chatId: payload.chatId,
      devMode: telegramDevModeEnabled(),
    });
    return null;
  }
  try {
    const b = getBot();
    const res = await b.api.sendMessage(payload.chatId, payload.text, {
      reply_markup: payload.replyMarkup as never,
      parse_mode: payload.parseMode ?? "HTML",
    });
    return res.message_id;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    // Telegram rejects the WHOLE message when a web_app button's domain is
    // not whitelisted in @BotFather (BUTTON_URL_INVALID) — the bot then looks
    // dead while the send fails silently. Retry once without web_app buttons
    // so the message still goes through.
    if (message.includes("BUTTON_URL_INVALID") && payload.replyMarkup) {
      const stripped = stripWebAppButtons(payload.replyMarkup);
      if (stripped !== payload.replyMarkup) {
        try {
          const b = getBot();
          const res = await b.api.sendMessage(payload.chatId, payload.text, {
            reply_markup: stripped as never,
            parse_mode: payload.parseMode ?? "HTML",
          });
          logger.warn("telegram send succeeded without web_app buttons", { chatId: payload.chatId });
          return res.message_id;
        } catch (e2) {
          logger.error("telegram send failed even without web_app buttons", {
            chatId: payload.chatId,
            error: e2 instanceof Error ? e2.message : String(e2),
          });
          return null;
        }
      }
    }
    logger.error("telegram send failed", {
      chatId: payload.chatId,
      error: message,
    });
    return null;
  }
}

/** Fetches a Telegram file download URL (file_id -> file_path). */
export async function getTelegramFileUrl(fileId: string): Promise<string | null> {
  try {
    const b = getBot();
    const file = await b.api.getFile(fileId);
    if (!file.file_path) return null;
    return `https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${file.file_path}`;
  } catch (e) {
    logger.error("telegram getFile failed", { error: e instanceof Error ? e.message : String(e) });
    return null;
  }
}
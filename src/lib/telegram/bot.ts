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
    logger.error("telegram send failed", {
      chatId: payload.chatId,
      error: e instanceof Error ? e.message : String(e),
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
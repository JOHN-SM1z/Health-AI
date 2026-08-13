import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "@/lib/env";

export type VerifiedTelegramUser = {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
  photo_url?: string;
};

export type VerifiedInitData = {
  user: VerifiedTelegramUser;
  authDate: Date;
};

const MAX_INIT_DATA_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Server-side validation of Telegram Mini App initData per the official
 * algorithm: HMAC-SHA256 of the sorted data_check_string, keyed by
 * HMAC-SHA256("WebAppData", bot_token).
 *
 * Returns null when the signature is invalid, expired, or the payload does
 * not contain a verified user.
 */
export function validateTelegramInitData(initData: string, botToken = env.TELEGRAM_BOT_TOKEN): VerifiedInitData | null {
  if (!initData || !botToken) return null;

  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return null;

  const authDateRaw = params.get("auth_date");
  const authDate = Number(authDateRaw);
  if (!Number.isFinite(authDate)) return null;

  // Freshness check.
  if (Date.now() / 1000 - authDate > MAX_INIT_DATA_AGE_MS / 1000) return null;

  // Sort remaining pairs alphabetically and build the data_check_string.
  const pairs: string[] = [];
  for (const [key, value] of params.entries()) {
    if (key === "hash") continue;
    pairs.push(`${key}=${value}`);
  }
  pairs.sort();
  const dataCheckString = pairs.join("\n");

  const secretKey = createHmac("sha256", "WebAppData").update(botToken).digest();
  const computedHash = createHmac("sha256", secretKey).update(dataCheckString).digest();

  const expected = Buffer.from(hash, "hex");
  if (expected.length !== computedHash.length || !timingSafeEqual(expected, computedHash)) {
    return null;
  }

  const userRaw = params.get("user");
  if (!userRaw) return null;

  let user: VerifiedTelegramUser;
  try {
    user = JSON.parse(userRaw) as VerifiedTelegramUser;
  } catch {
    return null;
  }
  if (!user.id || typeof user.id !== "number") return null;

  return { user, authDate: new Date(authDate * 1000) };
}
import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { validateTelegramInitData } from "@/lib/telegram/init-data";

const BOT_TOKEN = "123456:TEST-BOT-TOKEN-abcdef";

/**
 * Builds a genuine initData string using the official Telegram algorithm,
 * so the validator is tested against correctly-signed payloads.
 */
function buildInitData(opts: {
  userId?: number;
  firstName?: string;
  authDateSec?: number;
  botToken?: string;
  mutateUser?: (user: Record<string, unknown>) => Record<string, unknown>;
  dropUser?: boolean;
  extra?: Record<string, string>;
}): string {
  const authDateSec = opts.authDateSec ?? Math.floor(Date.now() / 1000);
  const user = opts.mutateUser
    ? opts.mutateUser({ id: opts.userId ?? 777000, first_name: opts.firstName ?? "Test", username: "testuser" })
    : { id: opts.userId ?? 777000, first_name: opts.firstName ?? "Test", username: "testuser" };
  const pairs: Record<string, string> = {
    auth_date: String(authDateSec),
    query_id: "AAF1234567890",
    ...(opts.dropUser ? {} : { user: JSON.stringify(user) }),
    ...opts.extra,
  };
  const dataCheckString = Object.entries(pairs)
    .map(([k, v]) => `${k}=${v}`)
    .sort()
    .join("\n");
  const secretKey = createHmac("sha256", "WebAppData").update(opts.botToken ?? BOT_TOKEN).digest();
  const hash = createHmac("sha256", secretKey).update(dataCheckString).digest("hex");
  return `${new URLSearchParams({ ...pairs, hash }).toString()}`;
}

describe("validateTelegramInitData", () => {
  it("accepts a correctly signed, fresh payload", () => {
    const initData = buildInitData({ userId: 111, firstName: "Ali" });
    const result = validateTelegramInitData(initData, BOT_TOKEN);
    expect(result).not.toBeNull();
    expect(result!.user.id).toBe(111);
    expect(result!.user.first_name).toBe("Ali");
    expect(result!.authDate).toBeInstanceOf(Date);
  });

  it("rejects a tampered payload (modified user)", () => {
    // Sign a payload for user 999, then swap the encoded user JSON to 42
    // WITHOUT re-signing — the signature no longer matches the content.
    const good = buildInitData({ userId: 999 });
    // URLSearchParams encodes "id":999 as %22id%22%3A999
    const forged = good.replace("%22id%22%3A999", "%22id%22%3A42");
    expect(forged).not.toBe(good);
    expect(validateTelegramInitData(forged, BOT_TOKEN)).toBeNull();
  });

  it("rejects a signature computed with a different bot token", () => {
    const initData = buildInitData({});
    expect(validateTelegramInitData(initData, "999999:OTHER-TOKEN")).toBeNull();
  });

  it("rejects expired payloads (older than 24h)", () => {
    const authDateSec = Math.floor(Date.now() / 1000) - 25 * 60 * 60;
    const initData = buildInitData({ authDateSec });
    expect(validateTelegramInitData(initData, BOT_TOKEN)).toBeNull();
  });

  it("rejects payloads without hash or without a user", () => {
    expect(validateTelegramInitData("auth_date=1234567890&user=%7B%22id%22%3A1%7D", BOT_TOKEN)).toBeNull();
    const noUser = buildInitData({ dropUser: true });
    expect(validateTelegramInitData(noUser, BOT_TOKEN)).toBeNull();
  });

  it("rejects a user without a numeric id", () => {
    const initData = buildInitData({ mutateUser: (u) => ({ ...u, id: "not-a-number" }) });
    expect(validateTelegramInitData(initData, BOT_TOKEN)).toBeNull();
  });

  it("returns null for empty input or missing bot token", () => {
    expect(validateTelegramInitData("", BOT_TOKEN)).toBeNull();
    expect(validateTelegramInitData(buildInitData({}), "")).toBeNull();
  });
});
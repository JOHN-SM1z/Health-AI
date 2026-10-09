import "server-only";
import { logger } from "@/lib/logger";
import type { SmsProvider, SmsSendResult } from "@/lib/sms/types";

/**
 * Eskiz (eskiz.uz) — the clinic's SMS provider (owner decision 2026-10-08).
 *
 * Built from Eskiz's public API (notify.eskiz.uz): a bearer token from POST /api/auth/login (email + password), then
 * POST /api/message/sms/send with mobile_phone (998XXXXXXXXX), message, from (the approved sender name) and
 * callback_url (delivery reports). NOT yet exercised against a live Eskiz account: before turning SMS on, send a test
 * message with the clinic's account and confirm the response and callback fields below. Templates must be approved by
 * Eskiz; the sender name must be registered.
 *
 * Credentials (ESKIZ_EMAIL / ESKIZ_PASSWORD) never appear in logs; the phone number and text are never logged.
 */
const BASE = () => (process.env.ESKIZ_API_BASE_URL ?? "https://notify.eskiz.uz").replace(/\/+$/, "");

let cachedToken: { value: string; at: number } | null = null;
const TOKEN_TTL_MS = 20 * 24 * 3_600_000; // Eskiz tokens last about 30 days; renew earlier.

async function token(force = false): Promise<string | null> {
  if (!force && cachedToken && Date.now() - cachedToken.at < TOKEN_TTL_MS) return cachedToken.value;
  const form = new FormData();
  form.set("email", process.env.ESKIZ_EMAIL ?? "");
  form.set("password", process.env.ESKIZ_PASSWORD ?? "");
  const res = await fetch(`${BASE()}/api/auth/login`, { method: "POST", body: form, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) {
    logger.error("eskiz login failed", { status: res.status });
    return null;
  }
  const json = (await res.json().catch(() => null)) as { data?: { token?: string } } | null;
  const value = json?.data?.token ?? null;
  cachedToken = value ? { value, at: Date.now() } : null;
  return value;
}

function callbackUrl(): string | null {
  const app = process.env.NEXT_PUBLIC_APP_URL;
  const key = process.env.ESKIZ_CALLBACK_SECRET;
  return app && key ? `${app.replace(/\/+$/, "")}/api/sms/eskiz/callback?key=${encodeURIComponent(key)}` : null;
}

export const eskizProvider: SmsProvider = {
  name: "eskiz",
  configured: () => !!process.env.ESKIZ_EMAIL && !!process.env.ESKIZ_PASSWORD,
  async send(phone, text): Promise<SmsSendResult> {
    const mobile = phone.replace(/\D/g, "");
    for (const retry of [false, true]) {
      const bearer = await token(retry);
      if (!bearer) return { accepted: false, error: "auth_failed" };
      const form = new FormData();
      form.set("mobile_phone", mobile);
      form.set("message", text);
      form.set("from", process.env.ESKIZ_FROM ?? "4546");
      const cb = callbackUrl();
      if (cb) form.set("callback_url", cb);
      let res: Response;
      try {
        res = await fetch(`${BASE()}/api/message/sms/send`, { method: "POST", headers: { authorization: `Bearer ${bearer}` }, body: form, signal: AbortSignal.timeout(15_000) });
      } catch {
        return { accepted: false, error: "network" };
      }
      if (res.status === 401 && !retry) continue; // token expired: log in again once
      const json = (await res.json().catch(() => null)) as { id?: string | number; status?: string; message?: string } | null;
      if (!res.ok || json?.id === undefined || json?.id === null) {
        logger.warn("eskiz did not accept the sms", { status: res.status, eskizStatus: json?.status ?? null });
        return { accepted: false, error: `http_${res.status}` };
      }
      return { accepted: true, providerMessageId: String(json.id) };
    }
    return { accepted: false, error: "auth_failed" };
  },
};

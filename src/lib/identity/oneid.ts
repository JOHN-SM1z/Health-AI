import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { ApiError } from "@/lib/api/errors";
import { logger } from "@/lib/logger";
import { sharedRateLimit } from "@/lib/rate-limit-shared";
import { checkPinflAgainstBirthDate, pinflSex } from "@/lib/identity/pinfl";
import type { OnlinePatient } from "@/lib/patients/online-identity";

/**
 * OneID (id.egov.uz) — the state identification system — for the Mini App (migration 20261010000003).
 *
 * Protocol (OAuth-style, one endpoint, the grant type in the parameters):
 *   1. browser → {base}?response_type=one_code&client_id&redirect_uri&scope&state   (the person signs in at OneID:
 *      login + password, e-signature or phone — no face check needed)
 *   2. OneID → our callback ?code&state
 *   3. POST {base} grant_type=one_authorization_code&client_id&client_secret&code&redirect_uri → access_token
 *   4. POST {base} grant_type=one_access_token_identify&client_id&client_secret&access_token&scope → the person:
 *      pin (JSHSHIR), pport_no, sur_name/first_name/mid_name, birth_date, gd (sex), per_adr, valid, …
 *
 * Only a response with valid === true and a JSHSHIR whose structure carries the returned date of birth is used. The
 * values go onto the card (apply_oneid_identity); none are logged or audited. Off until ONEID_CLIENT_ID and
 * ONEID_CLIENT_SECRET are set — the operator gets them by signing the OneID integration agreement.
 */

const DEFAULT_BASE = "https://sso.egov.uz/sso/oauth/Authorization.do";

type Config = { clientId: string; clientSecret: string; scope: string; base: string; redirectUri: string };

export function oneIdConfig(): Config | null {
  const clientId = process.env.ONEID_CLIENT_ID?.trim();
  const clientSecret = process.env.ONEID_CLIENT_SECRET?.trim();
  const app = process.env.NEXT_PUBLIC_APP_URL?.trim().replace(/\/+$/, "");
  if (!clientId || !clientSecret || !app || !/^https:\/\//.test(app)) return null;
  return {
    clientId,
    clientSecret,
    scope: process.env.ONEID_SCOPE?.trim() || clientId,
    base: process.env.ONEID_BASE_URL?.trim() || DEFAULT_BASE,
    redirectUri: `${app}/api/oneid/callback`,
  };
}

export const stateHash = (state: string) => createHash("sha256").update(state).digest("hex");

/** Starts a OneID sign-in for this Telegram patient: returns the URL to open (outside Telegram's webview). */
export async function startOneId(clinicId: string, patient: OnlinePatient): Promise<{ url: string }> {
  const cfg = oneIdConfig();
  if (!cfg) throw new ApiError(404, "OneID hali ulanmagan", "oneid_unavailable");
  if (!patient.telegram_user_id) throw new ApiError(401, "Telegram identifikatori tasdiqlanmadi", "invalid_init_data");
  const limit = await sharedRateLimit({ key: `oneid-start:${clinicId}:${patient.telegram_user_id}`, limit: 6, windowMs: 3_600_000 });
  if (!limit.ok) throw new ApiError(429, "Juda ko‘p urinish — birozdan keyin qayta urinib ko‘ring", "rate_limited");

  const state = randomBytes(32).toString("base64url");
  const { error } = await createAdminClient()
    .from("oneid_requests")
    .insert({ clinic_id: clinicId, telegram_user_id: patient.telegram_user_id, state_hash: stateHash(state) });
  if (error) throw new ApiError(500, "OneID’ni boshlab bo‘lmadi");

  const url = new URL(cfg.base);
  url.searchParams.set("response_type", "one_code");
  url.searchParams.set("client_id", cfg.clientId);
  url.searchParams.set("redirect_uri", cfg.redirectUri);
  url.searchParams.set("scope", cfg.scope);
  url.searchParams.set("state", state);
  return { url: url.toString() };
}

/** The OneID person, reduced to what goes onto a card; null when OneID does not vouch for it. */
export type OneIdPerson = {
  pinfl: string;
  document: string | null;
  dateOfBirth: string;
  sex: "male" | "female" | null;
  fullName: string;
  address: string | null;
};

const titleCase = (s: string) =>
  s
    .toLowerCase()
    .replace(/(^|[\s-])([a-zа-яёўқғҳ‘’'ʻ])/giu, (_m, sep: string, ch: string) => sep + ch.toUpperCase())
    .trim();

/** "1987-03-14", "14.03.1987" or "19870314" → "1987-03-14". */
function isoDate(raw: unknown): string | null {
  const s = String(raw ?? "").trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  m = s.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  return null;
}

export function parseOneIdPerson(raw: Record<string, unknown>): OneIdPerson | null {
  if (raw.valid !== true && raw.valid !== "true") return null;
  const pinfl = String(raw.pin ?? "").replace(/\D/g, "");
  const dateOfBirth = isoDate(raw.birth_date);
  if (!dateOfBirth || checkPinflAgainstBirthDate(pinfl, dateOfBirth) !== "ok") return null;
  const parts = [raw.sur_name, raw.first_name, raw.mid_name].map((p) => String(p ?? "").trim()).filter(Boolean);
  const fullName = titleCase(parts.join(" ")) || titleCase(String(raw.full_name ?? ""));
  if (fullName.length < 2) return null;
  const doc = String(raw.pport_no ?? "").toUpperCase().replace(/[\s-]+/g, "");
  const gd = String(raw.gd ?? "").trim();
  const sex = gd === "1" ? "male" : gd === "2" ? "female" : pinflSex(pinfl);
  const address = String(raw.per_adr ?? "").trim();
  return {
    pinfl,
    document: /^[A-Z]{2}\d{7}$/.test(doc) ? doc : null,
    dateOfBirth,
    sex,
    fullName: fullName.slice(0, 120),
    address: address ? address.slice(0, 300) : null,
  };
}

async function postForm(base: string, params: Record<string, string>): Promise<Record<string, unknown>> {
  const res = await fetch(base, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams(params).toString(),
    signal: AbortSignal.timeout(15_000),
  });
  const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok || !json) throw new Error(`oneid http ${res.status}`);
  return json;
}

export type OneIdOutcome = "verified" | "linked" | "reception" | "invalid" | "failed" | "expired";

/**
 * OneID's callback: the code is exchanged server-to-server, the person is read and applied to the right card. The
 * state ties it to the Telegram user who started; an unknown, used or expired state changes nothing.
 */
export async function finishOneId(code: string, state: string): Promise<OneIdOutcome> {
  const cfg = oneIdConfig();
  if (!cfg) return "failed";
  const db = createAdminClient();
  const { data: request } = await db
    .from("oneid_requests")
    .select("id, clinic_id, telegram_user_id, expires_at, completed_at")
    .eq("state_hash", stateHash(state))
    .maybeSingle();
  if (!request || request.completed_at || Date.parse(request.expires_at) < Date.now()) return "expired";

  const close = async (outcome: "invalid" | "failed") => {
    await db.from("oneid_requests").update({ completed_at: new Date().toISOString(), outcome }).eq("id", request.id).is("completed_at", null);
    return outcome;
  };

  let person: OneIdPerson | null;
  try {
    const token = await postForm(cfg.base, {
      grant_type: "one_authorization_code",
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      code,
      redirect_uri: cfg.redirectUri,
    });
    const accessToken = typeof token.access_token === "string" ? token.access_token : null;
    if (!accessToken) return close("failed");
    const identity = await postForm(cfg.base, {
      grant_type: "one_access_token_identify",
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      access_token: accessToken,
      scope: cfg.scope,
    });
    person = parseOneIdPerson(identity);
  } catch (e) {
    logger.warn("oneid exchange failed", { error: e instanceof Error ? e.message : "unknown" });
    return close("failed");
  }
  if (!person) return close("invalid");

  const { data: tg } = await db
    .from("patients")
    .select("telegram_username, telegram_first_name, telegram_last_name")
    .eq("clinic_id", request.clinic_id)
    .eq("telegram_user_id", request.telegram_user_id)
    .maybeSingle();
  const { data, error } = await db.rpc("apply_oneid_identity", {
    p_clinic: request.clinic_id,
    p_request: request.id,
    p_pinfl: person.pinfl,
    p_document: person.document,
    p_dob: person.dateOfBirth,
    p_sex: person.sex,
    p_full_name: person.fullName,
    p_address: person.address ?? "",
    p_username: tg?.telegram_username ?? null,
    p_first_name: tg?.telegram_first_name ?? null,
    p_last_name: tg?.telegram_last_name ?? null,
  });
  if (error) {
    logger.error("oneid apply failed", { code: error.code });
    return close("failed");
  }
  return data as OneIdOutcome;
}

/** The latest OneID attempt of this Telegram user, for the Mini App to follow after the browser round trip. */
export async function oneIdAttempt(clinicId: string, telegramUserId: number): Promise<{ outcome: string | null; pending: boolean } | null> {
  const { data } = await createAdminClient()
    .from("oneid_requests")
    .select("outcome, completed_at, expires_at")
    .eq("clinic_id", clinicId)
    .eq("telegram_user_id", telegramUserId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!data) return null;
  return { outcome: data.outcome, pending: !data.completed_at && Date.parse(data.expires_at) > Date.now() };
}

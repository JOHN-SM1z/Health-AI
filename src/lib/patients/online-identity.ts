import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { ApiError } from "@/lib/api/errors";
import { logger } from "@/lib/logger";
import { serverHmac } from "@/lib/security/server-hmac";
import { sharedRateLimit } from "@/lib/rate-limit-shared";
import { randomInt } from "node:crypto";
import { activeSmsProvider } from "@/lib/sms/provider";
import { cardLinkCodeSms } from "@/lib/sms/templates";

/**
 * Online identity for the Mini App booking (Slice B, 20261008000010, owner decision 2026-10-08).
 *
 * 1. lookup  — the patient types passport/ID or JSHSHIR + date of birth. Recorded server-side; the browser gets a
 *              lookup id and ALWAYS the same next step, whatever the database holds.
 * 2. phone   — the patient shares their own Telegram contact with the clinic's bot (the webhook keeps it only when the
 *              contact is the sender's). If that phone equals the matched card's phone, the card is linked to their
 *              Telegram and its details "pop up"; otherwise they continue as a new patient.
 * 3. details — a new patient's own record gets the details. A document already on another card is not stored; staff
 *              get a claim. The answer is the same either way.
 *
 * Proof is the Telegram-verified phone (and, in Slice D, an SMS code) — never the typed document, which anyone could
 * know. Nothing here returns another person's data.
 */

/** How long a phone shared through the bot counts as proof. */
const VERIFIED_PHONE_MAX_AGE_MS = 24 * 3_600_000;

export type IdentityDocument = { kind: "document" | "pinfl"; value: string };

/** Passport or ID card (two letters, seven digits) or JSHSHIR (14 digits), spaces and dashes ignored. */
export function parseIdentityDocument(raw: string): IdentityDocument | null {
  const v = raw.normalize("NFKC").toUpperCase().replace(/[\s-]+/g, "");
  if (/^[A-Z]{2}\d{7}$/.test(v)) return { kind: "document", value: v };
  if (/^\d{14}$/.test(v)) return { kind: "pinfl", value: v };
  return null;
}

/** The nine national digits of an Uzbek number (mirror of public.normalize_uz_phone); null for anything else. */
export function uzPhoneKey(raw: string | null | undefined): string | null {
  const d = (raw ?? "").replace(/\D/g, "");
  if (/^998\d{9}$/.test(d)) return d.slice(3);
  if (/^\d{9}$/.test(d)) return d;
  return null;
}

/** A date of birth a person could have: a real calendar day, not in the future, at most 120 years ago. */
export function plausibleDateOfBirth(iso: string, now = new Date()): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return false;
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== iso) return false;
  return d.getTime() <= now.getTime() && now.getUTCFullYear() - d.getUTCFullYear() <= 120;
}

export type OnlinePatient = {
  id: string;
  telegram_user_id: number | null;
  telegram_username?: string | null;
  telegram_first_name?: string | null;
  telegram_last_name?: string | null;
};

/** What the patient sees of their OWN record once proven. Never a document number. */
export type OnlineProfile = {
  fullName: string | null;
  phone: string | null;
  dateOfBirth: string | null;
  homeAddress: string | null;
  complete: boolean;
};

export type IdentityStep =
  | { next: "phone"; lookupId: string }
  | { next: "phone_needed"; lookupId: string }
  | { next: "details"; lookupId: string; phone: string }
  | { next: "reception" }
  | { next: "done"; profile: OnlineProfile };

const REFUSALS: Record<string, [number, string]> = {
  invalid_identity: [400, "Hujjat va tug‘ilgan sanani tekshiring"],
  lookup_expired: [409, "Vaqt tugadi — hujjat va tug‘ilgan sanani qaytadan kiriting"],
  needs_reception: [409, "Ma’lumotlaringizni qabulxonada tasdiqlang"],
};

function refusal(error: { hint?: string | null; code?: string }, op: string): ApiError {
  const known = error.hint ? REFUSALS[error.hint] : undefined;
  if (known) return new ApiError(known[0], known[1], error.hint!);
  logger.error("online identity rpc failed", { op, code: error.code });
  return new ApiError(500, "Amalni bajarib bo‘lmadi");
}

async function limit(key: string, max: number, windowMs: number) {
  const r = await sharedRateLimit({ key, limit: max, windowMs });
  if (!r.ok) throw new ApiError(429, "Juda ko‘p urinish — birozdan keyin qayta urinib ko‘ring", "rate_limited");
}

/** The patient's own record as they may see it, and whether online identity is complete. */
export async function onlineProfile(clinicId: string, patientId: string): Promise<OnlineProfile> {
  const { data, error } = await createAdminClient()
    .from("patients")
    .select("full_name, phone, date_of_birth, home_address, document_number, pinfl")
    .eq("clinic_id", clinicId)
    .eq("id", patientId)
    .single();
  if (error || !data) throw new ApiError(404, "Bemor topilmadi", "patient_not_found");
  return {
    fullName: data.full_name,
    phone: data.phone,
    dateOfBirth: data.date_of_birth,
    homeAddress: data.home_address,
    complete: !!data.full_name && !!data.date_of_birth && !!(data.document_number || data.pinfl),
  };
}

/** Step 1. Always answers "phone" — the outcome is kept on the server. */
export async function lookupOnlineIdentity(
  clinicId: string,
  patient: OnlinePatient,
  input: { document: string; dateOfBirth: string },
): Promise<IdentityStep> {
  if (!patient.telegram_user_id) throw new ApiError(401, "Telegram identifikatori tasdiqlanmadi", "invalid_init_data");
  const doc = parseIdentityDocument(input.document);
  if (!doc || !plausibleDateOfBirth(input.dateOfBirth)) throw new ApiError(400, REFUSALS.invalid_identity[1], "invalid_identity");

  // Guessing is slow: per Telegram user, and per document across everyone (wrong dates of birth are also counted in
  // the database, which stops comparing after three a day).
  await limit(`online-identity:user:${clinicId}:${patient.telegram_user_id}`, 10, 3_600_000);
  const documentKey = serverHmac("online-identity-document", `${clinicId}\u0000${doc.value}`);
  await limit(`online-identity:doc:${documentKey}`, 10, 24 * 3_600_000);

  const { data, error } = await createAdminClient().rpc("online_identity_lookup", {
    p_clinic: clinicId,
    p_telegram_user_id: patient.telegram_user_id,
    p_document_key: documentKey,
    p_document: doc.kind === "document" ? doc.value : null,
    p_pinfl: doc.kind === "pinfl" ? doc.value : null,
    p_dob: input.dateOfBirth,
  });
  if (error) throw refusal(error, "online_identity_lookup");
  return { next: "phone", lookupId: data as string };
}

type LookupRow = { id: string; matched_patient_id: string | null; expires_at: string; completed_at: string | null };

async function openLookup(clinicId: string, telegramUserId: number, lookupId: string): Promise<LookupRow> {
  const { data } = await createAdminClient()
    .from("online_identity_lookups")
    .select("id, matched_patient_id, expires_at, completed_at")
    .eq("clinic_id", clinicId)
    .eq("telegram_user_id", telegramUserId)
    .eq("id", lookupId)
    .maybeSingle();
  if (!data || data.completed_at || new Date(data.expires_at).getTime() < Date.now()) {
    throw new ApiError(REFUSALS.lookup_expired[0], REFUSALS.lookup_expired[1], "lookup_expired");
  }
  return data;
}

/** The phone this Telegram user proved to the clinic's bot, if recent enough. */
async function verifiedPhoneKey(clinicId: string, telegramUserId: number): Promise<string | null> {
  const { data } = await createAdminClient()
    .from("telegram_verified_phones")
    .select("phone_key, verified_at")
    .eq("clinic_id", clinicId)
    .eq("telegram_user_id", telegramUserId)
    .maybeSingle();
  if (!data || Date.now() - new Date(data.verified_at).getTime() > VERIFIED_PHONE_MAX_AGE_MS) return null;
  return data.phone_key;
}

/** Step 2. The shared phone decides: the matched card is linked, or the patient continues as new. */
export async function confirmOnlinePhone(clinicId: string, patient: OnlinePatient, lookupId: string): Promise<IdentityStep> {
  if (!patient.telegram_user_id) throw new ApiError(401, "Telegram identifikatori tasdiqlanmadi", "invalid_init_data");
  await limit(`online-identity:phone:${clinicId}:${patient.telegram_user_id}`, 30, 3_600_000);
  const lookup = await openLookup(clinicId, patient.telegram_user_id, lookupId);
  const phoneKey = await verifiedPhoneKey(clinicId, patient.telegram_user_id);
  if (!phoneKey) return { next: "phone_needed", lookupId };

  if (lookup.matched_patient_id) {
    const db = createAdminClient();
    const { data: card } = await db
      .from("patients")
      .select("id, phone")
      .eq("clinic_id", clinicId)
      .eq("id", lookup.matched_patient_id)
      .maybeSingle();
    if (card && uzPhoneKey(card.phone) === phoneKey) {
      const { data: outcome, error } = await db.rpc("link_card_to_telegram", {
        p_clinic: clinicId,
        p_patient: card.id,
        p_telegram_user_id: patient.telegram_user_id,
        p_method: "contact_phone",
        p_username: patient.telegram_username ?? null,
        p_first_name: patient.telegram_first_name ?? null,
        p_last_name: patient.telegram_last_name ?? null,
      });
      if (error) throw refusal(error, "link_card_to_telegram");
      if (outcome === "linked" || outcome === "already_linked") {
        await db.from("online_identity_lookups").update({ completed_at: new Date().toISOString() }).eq("id", lookup.id);
        return { next: "done", profile: await onlineProfile(clinicId, card.id) };
      }
      // The card is theirs (document, date of birth and phone all match) but it already has another Telegram account,
      // or their Telegram record has visits of its own: reception joins them.
      return { next: "reception" };
    }
  }
  // No card, a wrong date of birth, or a card with another phone: all continue the same way.
  return { next: "details", lookupId, phone: `+998${phoneKey}` };
}

/** Step 3. A new patient's own record gets the details; the answer never says whether a claim was filed. */
export async function completeOnlineDetails(
  clinicId: string,
  patient: OnlinePatient & { id: string },
  input: { lookupId: string; fullName: string; sex?: "female" | "male" | null; homeAddress?: string | null },
): Promise<IdentityStep> {
  if (!patient.telegram_user_id) throw new ApiError(401, "Telegram identifikatori tasdiqlanmadi", "invalid_init_data");
  await limit(`online-identity:details:${clinicId}:${patient.telegram_user_id}`, 10, 3_600_000);
  await openLookup(clinicId, patient.telegram_user_id, input.lookupId);
  if (!(await verifiedPhoneKey(clinicId, patient.telegram_user_id))) {
    return { next: "phone_needed", lookupId: input.lookupId };
  }
  const { error } = await createAdminClient().rpc("complete_online_patient", {
    p_clinic: clinicId,
    p_telegram_user_id: patient.telegram_user_id,
    p_lookup: input.lookupId,
    p_full_name: input.fullName,
    p_sex: input.sex ?? undefined,
    p_address: input.homeAddress ?? undefined,
  });
  if (error) throw refusal(error, "complete_online_patient");
  return { next: "done", profile: await onlineProfile(clinicId, patient.id) };
}

/**
 * The second proof (20261008000013): a one-time code by SMS to the phone ON THE CARD the lookup matched — for a patient
 * whose Telegram number differs from the card's. The answer is the same whether a code went out or not (no card, no
 * phone, SMS off, limits reached), so it reveals nothing; only the code's HMAC is stored.
 */
export async function sendCardLinkCode(clinicId: string, patient: OnlinePatient, lookupId: string): Promise<{ sent: "if_card" }> {
  if (!patient.telegram_user_id) throw new ApiError(401, "Telegram identifikatori tasdiqlanmadi", "invalid_init_data");
  await limit(`online-identity:otp-send:${clinicId}:${patient.telegram_user_id}`, 5, 3_600_000);
  await openLookup(clinicId, patient.telegram_user_id, lookupId);
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  const db = createAdminClient();
  const { data: phone, error } = await db.rpc("issue_card_link_otp", {
    p_clinic: clinicId,
    p_telegram_user_id: patient.telegram_user_id,
    p_lookup: lookupId,
    p_code_hmac: serverHmac("card-link-otp", `${lookupId}\u0000${code}`),
  });
  if (error) throw refusal(error, "issue_card_link_otp");
  const provider = activeSmsProvider();
  if (phone && provider) {
    const { data: clinic } = await db.from("clinics").select("name").eq("id", clinicId).single();
    const result = await provider.send(phone, cardLinkCodeSms(clinic?.name ?? "Klinika", code), lookupId);
    if (result.accepted) {
      await db.from("sms_messages").insert({ clinic_id: clinicId, purpose: "card_link_otp", provider: provider.name, provider_message_id: result.providerMessageId });
    } else {
      logger.warn("card link code not accepted by the sms provider", { error: result.error });
    }
  }
  return { sent: "if_card" };
}

export async function verifyCardLinkCode(clinicId: string, patient: OnlinePatient, lookupId: string, code: string): Promise<IdentityStep> {
  if (!patient.telegram_user_id) throw new ApiError(401, "Telegram identifikatori tasdiqlanmadi", "invalid_init_data");
  if (!/^\d{6}$/.test(code)) throw new ApiError(400, "Kod 6 ta raqamdan iborat", "wrong_code");
  await limit(`online-identity:otp-verify:${clinicId}:${patient.telegram_user_id}`, 15, 3_600_000);
  const db = createAdminClient();
  const { data: outcome, error } = await db.rpc("verify_card_link_otp", {
    p_clinic: clinicId,
    p_telegram_user_id: patient.telegram_user_id,
    p_lookup: lookupId,
    p_code_hmac: serverHmac("card-link-otp", `${lookupId}\u0000${code}`),
    p_username: patient.telegram_username ?? null,
    p_first_name: patient.telegram_first_name ?? null,
    p_last_name: patient.telegram_last_name ?? null,
  });
  if (error) throw refusal(error, "verify_card_link_otp");
  if (outcome === "wrong_code") throw new ApiError(400, "Kod noto‘g‘ri", "wrong_code");
  if (outcome === "expired") throw new ApiError(409, "Kod eskirgan — yangisini so‘rang", "code_expired");
  if (outcome === "linked" || outcome === "already_linked") {
    const { data: card } = await db.from("patients").select("id").eq("clinic_id", clinicId).eq("telegram_user_id", patient.telegram_user_id).single();
    return { next: "done", profile: await onlineProfile(clinicId, card!.id) };
  }
  return { next: "reception" };
}

/**
 * The bot received a contact. Kept only when it is the sender's own (Telegram sets contact.user_id to the account the
 * number belongs to; a forwarded or typed contact has another id or none).
 */
export async function recordSharedContact(
  clinicId: string,
  from: { id: number },
  contact: { phone_number?: string; user_id?: number },
): Promise<"verified" | "not_own" | "not_uzbek"> {
  if (!contact.user_id || contact.user_id !== from.id) return "not_own";
  if (!uzPhoneKey(contact.phone_number)) return "not_uzbek";
  const { data, error } = await createAdminClient().rpc("record_telegram_verified_phone", {
    p_clinic: clinicId,
    p_telegram_user_id: from.id,
    p_phone: contact.phone_number ?? "",
  });
  if (error) {
    logger.error("verified phone not recorded", { code: error.code });
    throw new Error("verified_phone_failed");
  }
  return data ? "verified" : "not_uzbek";
}

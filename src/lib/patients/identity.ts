import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { validateTelegramInitDataForClinic, type VerifiedInitData } from "@/lib/telegram/init-data";
import { env, isProduction, telegramDevModeEnabled } from "@/lib/env";
import { logger } from "@/lib/logger";

export const DEV_TELEGRAM_USER_ID = 777000; // matches the dev seed patient

/**
 * The columns a patient session needs. Never `*`: passport/ID, JSHSHIR, date of birth, sex and address stay out of
 * every object that could be spread into a response (owner decision 2026-10-08).
 */
const SESSION_COLUMNS =
  "id, clinic_id, full_name, phone, telegram_user_id, telegram_username, telegram_first_name, telegram_last_name, consent_given, consent_given_at, preferred_language, merged_into_patient_id";

async function findTelegramPatient(clinicId: string, telegramUserId: number) {
  const { data, error } = await createAdminClient()
    .from("patients")
    .select(SESSION_COLUMNS)
    .eq("clinic_id", clinicId)
    .eq("telegram_user_id", telegramUserId)
    .maybeSingle();
  if (error) {
    logger.error("Telegram patient lookup failed", { code: error.code });
    throw new Error("patient_lookup_failed");
  }
  return data;
}

/**
 * Resolves (or creates) the patient row for a verified Telegram user.
 * The telegram identity is always verified server-side first.
 */
export async function getOrCreatePatient(opts: {
  clinicId: string;
  user: { id: number; first_name?: string; last_name?: string; username?: string };
}) {
  const supabase = createAdminClient();
  const telegramUserId = opts.user.id;

  const existing = await findTelegramPatient(opts.clinicId, telegramUserId);

  if (existing) {
    await supabase
      .from("patients")
      .update({
        telegram_username: opts.user.username ?? existing.telegram_username,
        telegram_first_name: opts.user.first_name ?? existing.telegram_first_name,
        telegram_last_name: opts.user.last_name ?? existing.telegram_last_name,
        last_seen_at: new Date().toISOString(),
      })
      .eq("id", existing.id)
      .eq("clinic_id", opts.clinicId);
    return existing;
  }

  const { data: created, error } = await supabase
    .from("patients")
    .insert({
      clinic_id: opts.clinicId,
      telegram_user_id: telegramUserId,
      telegram_username: opts.user.username ?? null,
      telegram_first_name: opts.user.first_name ?? null,
      telegram_last_name: opts.user.last_name ?? null,
      last_seen_at: new Date().toISOString(),
    })
    .select(SESSION_COLUMNS)
    .single();

  if (error) {
    logger.error("patient create failed", { code: error.code });
    throw new Error("patient_create_failed");
  }
  return created;
}

/** Name as a person would recognise it: case, spacing and apostrophe variants aside. */
function sameName(a: string | null | undefined, b: string): boolean {
  const norm = (v: string) =>
    v
      .normalize("NFKC")
      .toLocaleLowerCase("uz")
      .replace(/[\u2018\u2019\u02BB\u02BC`']/g, "'")
      .replace(/\s+/g, " ")
      .trim();
  return !!a && norm(a) === norm(b);
}

/**
 * The patient for a website booking. Nothing on the website proves who the
 * visitor is — name and phone are what they typed — so it never takes over or
 * edits a record someone else owns: a returning visitor reuses a record only
 * when it has no Telegram identity and both the phone and the name match;
 * otherwise a new record is created, for reception to reconcile at the desk.
 * (Matching on the phone alone let anyone who knew a patient's number rename
 * their record and attach visits — and later clinical notes — to it, and a
 * Telegram patient's chat would have received a stranger's reminders.)
 */
export async function getOrCreateWebPatient(opts: {
  clinicId: string;
  phone: string;
  fullName: string;
}) {
  const supabase = createAdminClient();
  const now = new Date().toISOString();

  const { data: candidates, error: lookupError } = await supabase
    .from("patients")
    .select(SESSION_COLUMNS)
    .eq("clinic_id", opts.clinicId)
    .eq("phone", opts.phone)
    .is("telegram_user_id", null)
    // A record merged into another (Phase 14) takes no new bookings.
    .is("merged_into_patient_id", null)
    .order("created_at", { ascending: true })
    .limit(20);
  if (lookupError) {
    logger.error("web patient lookup failed", { code: lookupError.code });
    throw new Error("patient_lookup_failed");
  }

  const existing = (candidates ?? []).find((p) => sameName(p.full_name, opts.fullName));
  if (existing) {
    const { error } = await supabase
      .from("patients")
      .update({
        last_seen_at: now,
        // The same person ticked the consent box again.
        ...(existing.consent_given ? {} : { consent_given: true, consent_given_at: now }),
      })
      .eq("id", existing.id)
      .eq("clinic_id", opts.clinicId);
    if (error) logger.warn("web patient touch failed", { code: error.code });
    return existing;
  }

  const { data: created, error } = await supabase
    .from("patients")
    .insert({
      clinic_id: opts.clinicId,
      full_name: opts.fullName,
      phone: opts.phone,
      consent_given: true,
      consent_given_at: now,
      last_seen_at: now,
    })
    .select(SESSION_COLUMNS)
    .single();

  if (error) {
    logger.error("web patient create failed", { code: error.code });
    throw new Error("patient_create_failed");
  }
  return created;
}

/**
 * Patient identity for the Mini App. Returns null when initData is invalid.
 * The development identity is usable ONLY in local development with
 * ENABLE_TELEGRAM_DEV_MODE=true; production never allows it.
 */
async function verifyTelegramSession(initData: string | null | undefined, clinicId: string) {
  if (!initData) return null;

  if (telegramDevModeEnabled() && initData === "dev") {
    // Explicit local development identity — never active in production.
    return { user: { id: DEV_TELEGRAM_USER_ID, first_name: "Local", username: "local_dev" }, dev: true };
  }

  const verified: VerifiedInitData | null = await validateTelegramInitDataForClinic(initData, clinicId);
  return verified ? { user: verified.user, dev: false } : null;
}

/** Verifies the session and loads its existing card without creating or updating a patient. */
export async function resolveExistingPatientFromInitData(initData: string, clinicId: string) {
  const session = await verifyTelegramSession(initData, clinicId);
  if (!session) return null;
  return { patient: await findTelegramPatient(clinicId, session.user.id) };
}

export async function resolvePatientFromInitData(initData: string | null | undefined, clinicId: string) {
  const session = await verifyTelegramSession(initData, clinicId);
  if (!session) return null;
  if (session.dev) {
    const data = await findTelegramPatient(clinicId, session.user.id);
    if (data) return { patient: data, dev: true };
  }
  return { patient: await getOrCreatePatient({ clinicId, user: session.user }), dev: session.dev };
}

/** True only outside production AND with the explicit dev-mode flag. */
export function devIdentityAllowed(): boolean {
  return !isProduction && telegramDevModeEnabled();
}

export function devIdentityEnabled(): boolean {
  return devIdentityAllowed() && env.ENABLE_TELEGRAM_DEV_MODE === "true";
}

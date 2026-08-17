import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { validateTelegramInitData, type VerifiedInitData } from "@/lib/telegram/init-data";
import { env, isProduction, telegramDevModeEnabled } from "@/lib/env";
import { logger } from "@/lib/logger";

export const DEV_TELEGRAM_USER_ID = 777000; // matches the dev seed patient

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

  const { data: existing } = await supabase
    .from("patients")
    .select("*")
    .eq("clinic_id", opts.clinicId)
    .eq("telegram_user_id", telegramUserId)
    .maybeSingle();

  if (existing) {
    await supabase
      .from("patients")
      .update({
        telegram_username: opts.user.username ?? existing.telegram_username,
        telegram_first_name: opts.user.first_name ?? existing.telegram_first_name,
        telegram_last_name: opts.user.last_name ?? existing.telegram_last_name,
        last_seen_at: new Date().toISOString(),
      })
      .eq("id", existing.id);
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
    .select("*")
    .single();

  if (error) {
    logger.error("patient create failed", { error: error.message });
    throw new Error("patient_create_failed");
  }
  return created;
}

/**
 * Resolves (or creates) a patient row by verified contact information (phone number)
 * for web bookings made directly or outside of Telegram initData context.
 */
export async function getOrCreatePatientByContact(opts: {
  clinicId: string;
  phone: string;
  fullName: string;
}) {
  const supabase = createAdminClient();

  const { data: existing } = await supabase
    .from("patients")
    .select("*")
    .eq("clinic_id", opts.clinicId)
    .eq("phone", opts.phone)
    .maybeSingle();

  if (existing) {
    await supabase
      .from("patients")
      .update({
        full_name: opts.fullName || existing.full_name,
        last_seen_at: new Date().toISOString(),
      })
      .eq("id", existing.id);
    return existing;
  }

  const { data: created, error } = await supabase
    .from("patients")
    .insert({
      clinic_id: opts.clinicId,
      full_name: opts.fullName,
      phone: opts.phone,
      consent_given: true,
      consent_given_at: new Date().toISOString(),
      last_seen_at: new Date().toISOString(),
    })
    .select("*")
    .single();

  if (error) {
    logger.error("patient create by contact failed", { error: error.message });
    throw new Error("patient_create_failed");
  }
  return created;
}

/**
 * Patient identity for the Mini App. Returns null when initData is invalid.
 * The development identity is usable ONLY in local development with
 * ENABLE_TELEGRAM_DEV_MODE=true; production never allows it.
 */
export async function resolvePatientFromInitData(initData: string | null | undefined, clinicId: string) {
  if (!initData) return null;

  if (telegramDevModeEnabled() && initData === "dev") {
    // Explicit local development identity — never active in production.
    const supabase = createAdminClient();
    const { data } = await supabase
      .from("patients")
      .select("*")
      .eq("clinic_id", clinicId)
      .eq("telegram_user_id", DEV_TELEGRAM_USER_ID)
      .maybeSingle();
    if (data) return { patient: data, dev: true };
    return { patient: await getOrCreatePatient({
      clinicId,
      user: { id: DEV_TELEGRAM_USER_ID, first_name: "Local", username: "local_dev" },
    }), dev: true };
  }

  const verified: VerifiedInitData | null = validateTelegramInitData(initData);
  if (!verified) return null;

  const patient = await getOrCreatePatient({
    clinicId,
    user: verified.user,
  });
  return { patient, dev: false };
}

/** True only outside production AND with the explicit dev-mode flag. */
export function devIdentityAllowed(): boolean {
  return !isProduction && telegramDevModeEnabled();
}

export function devIdentityEnabled(): boolean {
  return devIdentityAllowed() && env.ENABLE_TELEGRAM_DEV_MODE === "true";
}
import "server-only";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { ApiError } from "@/lib/api/errors";
import { recordAudit } from "@/lib/audit";
import { logger } from "@/lib/logger";
import type { ClinicStaff } from "@/lib/labs/guards";

/**
 * Clinic lab workflow settings (app_settings key "lab", docs/labs
 * PHASE_1_DOMAIN_MODEL.md §2.5). There is deliberately no verification-mode
 * setting: a second person always verifies (O4).
 *
 *   paymentPolicy     "not_required" (default, O6): collection does not wait
 *                     for payment; "before_collection": items become ready
 *                     for collection only once the order is paid.
 *   releaseToPatient  whether verified results are shown to the patient in
 *                     the Mini App (Phase 12). Default true.
 *   notifyStaff       in-app lab notifications to staff (Phase 16). Default true.
 *   notifyPatientOnCancel  a Telegram message to the patient when a lab
 *                     order is cancelled (Phase 16). Default false.
 *   aiSummaries       let the AI provider reword the doctor's laboratory
 *                     summary (Phase 18). Only computed statements from
 *                     structured, verified values are sent. Default false:
 *                     the summary is then shown as computed, without AI.
 *   verifiers         who may verify a result (Phase 9): "lab_and_doctor"
 *                     (default), "lab_only" or "doctor_only". Whoever it is,
 *                     it is never the person who entered or submitted the
 *                     result, and a doctor only for patients they may access.
 *
 * Management roles can also write app_settings directly (an existing RLS
 * policy), so every read re-validates and falls back to the defaults: a
 * malformed value can never loosen the workflow.
 */

export const labSettingsSchema = z.object({
  paymentPolicy: z.enum(["not_required", "before_collection"]),
  releaseToPatient: z.boolean(),
  verifiers: z.enum(["lab_and_doctor", "lab_only", "doctor_only"]),
  notifyStaff: z.boolean().default(true),
  notifyPatientOnCancel: z.boolean().default(false),
  aiSummaries: z.boolean().default(false),
});

export type LabSettings = z.infer<typeof labSettingsSchema>;

export const LAB_SETTINGS_DEFAULTS: LabSettings = {
  paymentPolicy: "not_required",
  releaseToPatient: true,
  verifiers: "lab_and_doctor",
  notifyStaff: true,
  notifyPatientOnCancel: false,
  aiSummaries: false,
};

// Field by field: one malformed field falls back to its own default and
// never resets the others (e.g. a stricter payment policy).
export function parseLabSettings(value: unknown): LabSettings {
  const raw = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const result: LabSettings = { ...LAB_SETTINGS_DEFAULTS };
  for (const key of Object.keys(labSettingsSchema.shape) as Array<keyof LabSettings>) {
    const parsed = labSettingsSchema.shape[key].safeParse(raw[key]);
    if (parsed.success) (result as Record<string, unknown>)[key] = parsed.data;
  }
  return result;
}

export async function getLabSettings(clinicId: string): Promise<LabSettings> {
  const { data, error } = await createAdminClient()
    .from("app_settings")
    .select("value")
    .eq("clinic_id", clinicId)
    .eq("key", "lab")
    .maybeSingle();
  if (error) {
    logger.error("lab settings read failed", { code: error.code });
    throw new ApiError(500, "Laboratoriya sozlamalarini yuklab bo‘lmadi", "load_failed");
  }
  return parseLabSettings(data?.value);
}

export async function saveLabSettings(staff: ClinicStaff, settings: LabSettings): Promise<LabSettings> {
  const { error } = await createAdminClient()
    .from("app_settings")
    .upsert({ clinic_id: staff.clinicId, key: "lab", value: settings, updated_by: staff.profileId, updated_at: new Date().toISOString() });
  if (error) {
    logger.error("lab settings write failed", { code: error.code });
    throw new ApiError(500, "Sozlamalarni saqlab bo‘lmadi", "save_failed");
  }
  await recordAudit({
    clinicId: staff.clinicId,
    action: "lab_settings_updated",
    entityType: "app_settings",
    entityId: "lab",
    actor: { actorId: staff.profileId, actorType: "staff" },
    newValues: settings,
  });
  return settings;
}

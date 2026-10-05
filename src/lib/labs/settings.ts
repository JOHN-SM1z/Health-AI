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
 *
 * Management roles can also write app_settings directly (an existing RLS
 * policy), so every read re-validates and falls back to the defaults: a
 * malformed value can never loosen the workflow.
 */

export const labSettingsSchema = z.object({
  paymentPolicy: z.enum(["not_required", "before_collection"]),
  releaseToPatient: z.boolean(),
});

export type LabSettings = z.infer<typeof labSettingsSchema>;

export const LAB_SETTINGS_DEFAULTS: LabSettings = { paymentPolicy: "not_required", releaseToPatient: true };

export function parseLabSettings(value: unknown): LabSettings {
  const parsed = labSettingsSchema.partial().safeParse(value);
  return { ...LAB_SETTINGS_DEFAULTS, ...(parsed.success ? parsed.data : {}) };
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

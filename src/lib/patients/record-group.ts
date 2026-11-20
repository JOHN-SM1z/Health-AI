import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { ApiError } from "@/lib/api/errors";
import { logger } from "@/lib/logger";

/**
 * A patient's longitudinal record across merged records (Phase 14).
 *
 * A merge links a duplicate record to its canonical record; nothing recorded
 * for either is moved or rewritten. Reads of a person's history therefore
 * cover the group: the canonical record and every record merged into it
 * (the same group public.doctor_patient_access() uses). Given any member,
 * the group is the same. Clinic-scoped: a patient of another clinic has no
 * group here.
 */
export type PatientRecordGroup = { canonicalId: string; ids: string[] };

export async function patientRecordGroup(clinicId: string, patientId: string): Promise<PatientRecordGroup | null> {
  const db = createAdminClient();
  const { data: patient, error } = await db
    .from("patients")
    .select("id, merged_into_patient_id")
    .eq("id", patientId)
    .eq("clinic_id", clinicId)
    .maybeSingle();
  if (error) {
    logger.error("patient record group: lookup failed", { code: error.code });
    throw new ApiError(503, "Bemor ma’lumotlarini yuklab bo‘lmadi", "load_failed");
  }
  if (!patient) return null;
  const canonicalId = patient.merged_into_patient_id ?? patient.id;
  const { data: members, error: membersError } = await db
    .from("patients")
    .select("id")
    .eq("clinic_id", clinicId)
    .eq("merged_into_patient_id", canonicalId);
  if (membersError) {
    logger.error("patient record group: members failed", { code: membersError.code });
    throw new ApiError(503, "Bemor ma’lumotlarini yuklab bo‘lmadi", "load_failed");
  }
  return { canonicalId, ids: [canonicalId, ...(members ?? []).map((m) => m.id)] };
}

/** The group's ids, or just the patient's own id when it is not in this clinic (callers then find nothing). */
export async function patientRecordIds(clinicId: string, patientId: string): Promise<string[]> {
  return (await patientRecordGroup(clinicId, patientId))?.ids ?? [patientId];
}

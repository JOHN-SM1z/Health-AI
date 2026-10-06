import "server-only";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { ApiError } from "@/lib/api/errors";
import { recordAudit } from "@/lib/audit";
import { logger } from "@/lib/logger";

/**
 * A patient's date of birth and sex, recorded by the front desk. The
 * database requires the date of birth before a lab order (20261005000003);
 * sex (optional, NULL = unknown — never guessed) and age select the clinic's
 * configured reference ranges. Demographics only: no clinical text.
 */

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const isCalendarDate = (v: string) => {
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
};

export const demographicsSchema = z.object({
  dateOfBirth: z
    .string()
    .regex(ISO_DATE, "Tug‘ilgan sana noto‘g‘ri")
    .refine(isCalendarDate, "Tug‘ilgan sana noto‘g‘ri")
    .refine((v) => v >= "1900-01-01", "Tug‘ilgan sana noto‘g‘ri"),
  sex: z.enum(["female", "male"]).nullable(),
});

export type Demographics = z.infer<typeof demographicsSchema>;

type Staff = { profileId: string; clinicId: string; clinicTimezone: string };

/** Today's date (YYYY-MM-DD) in the clinic's time zone. */
function clinicToday(timeZone: string): string {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

export async function updatePatientDemographics(
  staff: Staff,
  patientId: string,
  input: Demographics,
): Promise<{ dateOfBirth: string; sex: Demographics["sex"]; changed: boolean }> {
  if (input.dateOfBirth > clinicToday(staff.clinicTimezone)) {
    throw new ApiError(400, "Tug‘ilgan sana kelajakda bo‘lishi mumkin emas", "dob_in_future");
  }
  const db = createAdminClient();
  const { data: patient, error } = await db
    .from("patients")
    .select("id, date_of_birth, sex, merged_into_patient_id")
    .eq("id", patientId)
    .eq("clinic_id", staff.clinicId)
    .maybeSingle();
  if (error) {
    logger.error("patient demographics: lookup failed", { code: error.code });
    throw new ApiError(500, "Bemor ma’lumotlarini yuklab bo‘lmadi", "load_failed");
  }
  if (!patient) throw new ApiError(404, "Bemor topilmadi", "patient_not_found");
  if (patient.merged_into_patient_id) {
    throw new ApiError(409, "Bu karta boshqa kartaga birlashtirilgan — asosiy kartani o‘zgartiring", "patient_merged");
  }

  const fields = [
    ...(patient.date_of_birth !== input.dateOfBirth ? ["date_of_birth"] : []),
    ...(patient.sex !== input.sex ? ["sex"] : []),
  ];
  if (fields.length === 0) return { dateOfBirth: input.dateOfBirth, sex: input.sex, changed: false };

  const { data: updated, error: updateError } = await db
    .from("patients")
    .update({ date_of_birth: input.dateOfBirth, sex: input.sex })
    .eq("id", patientId)
    .eq("clinic_id", staff.clinicId)
    .is("merged_into_patient_id", null)
    .select("id")
    .maybeSingle();
  if (updateError) {
    // The database's own range check (1900 … today) is the last word.
    if (updateError.code === "23514") throw new ApiError(400, "Tug‘ilgan sana noto‘g‘ri", "invalid_date_of_birth");
    logger.error("patient demographics: update failed", { code: updateError.code });
    throw new ApiError(500, "Saqlab bo‘lmadi", "save_failed");
  }
  if (!updated) throw new ApiError(409, "Bu karta boshqa kartaga birlashtirilgan — asosiy kartani o‘zgartiring", "patient_merged");

  // Which fields changed — never their values.
  await recordAudit({
    clinicId: staff.clinicId,
    action: "patient_demographics_updated",
    entityType: "patients",
    entityId: patientId,
    patientId,
    actor: { actorId: staff.profileId, actorType: "staff" },
    metadata: { fields },
    strict: true,
  });
  return { dateOfBirth: input.dateOfBirth, sex: input.sex, changed: true };
}

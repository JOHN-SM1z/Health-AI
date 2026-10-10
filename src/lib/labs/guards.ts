import "server-only";
import { requireRoles } from "@/lib/auth/guards";
import { hasAnyRole, type StaffContext } from "@/lib/auth/staff";
import { canDoctorAccessPatientClinicalData } from "@/lib/clinical-access/access";
import { createAdminClient } from "@/lib/supabase/admin";
import { ApiError } from "@/lib/api/errors";
import { logger } from "@/lib/logger";
import { LAB_CAPABILITIES, type LabCapability } from "@/lib/labs/permissions";

export type ClinicStaff = StaffContext & { clinicId: string };

/**
 * The signed-in staff member, if they hold `capability` in their clinic
 * (401 without a clinic session, 403 without the capability). The clinic
 * always comes from the session, never from the request.
 */
export function requireLabCapability(capability: LabCapability): Promise<ClinicStaff> {
  return requireRoles(...LAB_CAPABILITIES[capability]);
}

/**
 * How `staff` may read the lab RESULT VALUES of one patient of their clinic:
 *   "lab"     — lab staff: the clinic's lab work (results they perform,
 *               enter and verify);
 *   "doctor"  — a linked doctor whom doctor_patient_access() admits (own
 *               patient or active, unexpired referral): all verified results
 *               of the patient (O3);
 *   "none"    — everyone else, including owner / manager / admin /
 *               receptionist (status only, O5), doctors without a
 *               relationship, and staff of another clinic.
 * Fails closed: if the decision cannot be made, the caller gets an error,
 * never data.
 */
export type LabResultAccess =
  | { kind: "lab" }
  | { kind: "doctor"; doctorId: string }
  | { kind: "none" };

export async function resolveLabResultAccess(staff: ClinicStaff, patientId: string): Promise<LabResultAccess> {
  const supabase = createAdminClient();
  const { data: patient, error } = await supabase
    .from("patients")
    .select("id")
    .eq("id", patientId)
    .eq("clinic_id", staff.clinicId)
    .maybeSingle();
  if (error) {
    logger.error("lab access: patient lookup failed", { code: error.code });
    throw new ApiError(503, "Ruxsatni tekshirib bo‘lmadi, keyinroq urinib ko‘ring", "access_check_failed");
  }
  if (!patient) return { kind: "none" };

  if (hasAnyRole(staff.roles, ["lab"])) return { kind: "lab" };

  if (hasAnyRole(staff.roles, ["doctor"])) {
    const { data: doctor, error: doctorError } = await supabase
      .from("doctors")
      .select("id")
      .eq("profile_id", staff.profileId)
      .eq("clinic_id", staff.clinicId)
      .eq("active", true)
      .maybeSingle();
    if (doctorError) {
      logger.error("lab access: doctor lookup failed", { code: doctorError.code });
      throw new ApiError(503, "Ruxsatni tekshirib bo‘lmadi, keyinroq urinib ko‘ring", "access_check_failed");
    }
    if (!doctor) return { kind: "none" };
    const access = await canDoctorAccessPatientClinicalData(doctor.id, patientId);
    if (access.relationship === "own" || access.relationship === "referred") {
      return { kind: "doctor", doctorId: doctor.id };
    }
  }
  return { kind: "none" };
}

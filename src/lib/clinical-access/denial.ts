import "server-only";
import { ApiError } from "@/lib/api/errors";
import { recordAudit } from "@/lib/audit";
import type { LinkedDoctor } from "@/lib/auth/guards";
import { lapsedReferralError, latestReferralToDoctor } from "@/lib/referrals/service";

/**
 * Why a doctor may not open or act on this patient: 410 with the reason when
 * their own referral for the patient lapsed (they were on it, so its status
 * is no secret to them), 404 otherwise — a patient id can never be probed.
 * The refusal is audited either way; no patient data is ever included.
 */
export async function patientAccessDenied(doctor: LinkedDoctor, patientId: string): Promise<ApiError> {
  const lapsed = await latestReferralToDoctor(doctor, patientId);
  await recordAudit({
    clinicId: doctor.clinicId,
    action: "patient_clinical_access_denied",
    entityType: "patients",
    entityId: patientId,
    // Only a referral proves the id is a patient of this clinic; a probed id
    // stays in entity_id and never becomes a patient reference.
    patientId: lapsed ? patientId : null,
    referralId: lapsed?.id ?? null,
    actor: { actorId: doctor.profileId, actorType: "staff" },
    metadata: { doctor_id: doctor.doctorId, referral_status: lapsed?.status ?? null },
  });
  const error = lapsed ? lapsedReferralError(lapsed.status) : null;
  return error && error.status === 410 ? error : new ApiError(404, "Bemor topilmadi", "patient_not_found");
}

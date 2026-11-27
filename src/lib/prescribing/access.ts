import "server-only";
import type { LinkedDoctor } from "@/lib/auth/guards";
import { canDoctorAccessPatientClinicalData, type ClinicalAccess } from "@/lib/clinical-access/access";
import { patientAccessDenied } from "@/lib/clinical-access/denial";

/**
 * The same decision as every other clinical read (public.doctor_patient_access):
 * the doctor's own patient or an active referral to them. A refusal is audited
 * and answered like an unknown patient.
 */
export async function requirePatientClinicalAccess(doctor: LinkedDoctor, patientId: string): Promise<ClinicalAccess> {
  const access = await canDoctorAccessPatientClinicalData(doctor.doctorId, patientId);
  if (!access.allowed) throw await patientAccessDenied(doctor, patientId);
  return access;
}

/**
 * PostgREST filter for rows a doctor may read under `access`, for tables that
 * carry the consultation and its doctor (clinical_records, prescriptions):
 * the doctor's own, those of doctors whose history an accepted referral
 * shares, and those of the consultations a referral links to. Null: nothing.
 */
export function consultationCoverageFilter(doctor: LinkedDoctor, access: ClinicalAccess, doctorColumn: string): string | null {
  if (!access.allowed) return null;
  const authors = [...(access.scope.ownAppointments ? [doctor.doctorId] : []), ...access.scope.sharedHistoryDoctorIds];
  const parts = [
    authors.length > 0 ? `${doctorColumn}.in.(${authors.join(",")})` : null,
    access.scope.referralAppointmentIds.length > 0 ? `appointment_id.in.(${access.scope.referralAppointmentIds.join(",")})` : null,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(",") : null;
}

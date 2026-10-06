import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { ApiError } from "@/lib/api/errors";
import { logger } from "@/lib/logger";
import type { Database } from "@/lib/supabase/database.types";

/**
 * The database admits active same-clinic doctors with a legitimate care
 * relationship: an assigned visit, authored care, or an open unexpired
 * referral (pending suffices). Such a relationship releases the patient's
 * longitudinal consultations and clinical history. Clinic membership alone
 * grants nothing. Each author retains exclusive correction rights.
 *
 * public.doctor_patient_access() supplies the same decision to RLS and the
 * server. Payments, conversations, messages and voice notes are excluded.
 */

export type ClinicalRelationship = "own" | "referred" | "none";

export type ClinicalAccess = {
  /** A (own), B (referred) or C (none); "own" wins when both apply. */
  relationship: ClinicalRelationship;
  allowed: boolean;
  scope: {
    /** The patient record: name, phone, language. */
    patientRecord: boolean;
    /** The doctor's own appointments with the patient. */
    ownAppointments: boolean;
    /** Historical authors/consultation doctors covered by this patient's care relationship. */
    sharedHistoryDoctorIds: string[];
    /** Appointments a referral links to: its consultation (receiver), its follow-up (referrer). */
    referralAppointmentIds: string[];
  };
  /** Active (pending, accepted or in-progress, unexpired) referrals of the patient to this doctor. */
  activeReferralIds: string[];
};

type AccessRow = Database["public"]["Functions"]["doctor_patient_access"]["Returns"][number];

export const NO_CLINICAL_ACCESS: ClinicalAccess = Object.freeze({
  relationship: "none",
  allowed: false,
  scope: Object.freeze({
    patientRecord: false,
    ownAppointments: false,
    sharedHistoryDoctorIds: [] as string[],
    referralAppointmentIds: [] as string[],
  }),
  activeReferralIds: [] as string[],
}) as ClinicalAccess;

/** Maps the database decision to the server's shape; no row means no access. */
export function toClinicalAccess(row: AccessRow | null | undefined): ClinicalAccess {
  if (!row) return NO_CLINICAL_ACCESS;
  const referred = row.active_referral_ids.length > 0;
  const relationship: ClinicalRelationship = row.own_patient ? "own" : referred ? "referred" : "none";
  if (relationship === "none") return NO_CLINICAL_ACCESS;
  return {
    relationship,
    allowed: true,
    scope: {
      patientRecord: true,
      ownAppointments: row.own_patient,
      sharedHistoryDoctorIds: [...row.history_doctor_ids],
      referralAppointmentIds: [...row.referral_appointment_ids],
    },
    activeReferralIds: [...row.active_referral_ids],
  };
}

/**
 * Whether an appointment of the patient falls inside `access` for
 * `doctorId` — the same rule as the appointments RLS policy
 * (doctor_can_read_appointment).
 */
export function canSeeAppointment(
  access: ClinicalAccess,
  doctorId: string,
  appointment: { id: string; doctorId: string },
): boolean {
  if (!access.allowed) return false;
  return (
    (access.scope.ownAppointments && appointment.doctorId === doctorId) ||
    access.scope.sharedHistoryDoctorIds.includes(appointment.doctorId) ||
    access.scope.referralAppointmentIds.includes(appointment.id)
  );
}

/**
 * What `doctorId` may see of `patientId`'s clinical data. Call it with the
 * doctor resolved from the session (requireLinkedDoctor), never with an id
 * taken from the request. Fails closed: if the check cannot run, the caller
 * gets an error, never data.
 */
export async function canDoctorAccessPatientClinicalData(doctorId: string, patientId: string): Promise<ClinicalAccess> {
  const { data, error } = await createAdminClient().rpc("doctor_patient_access", {
    p_doctor_id: doctorId,
    p_patient_id: patientId,
  });
  if (error) {
    logger.error("clinical access check failed", { code: error.code });
    throw new ApiError(503, "Ruxsatni tekshirib bo‘lmadi, keyinroq urinib ko‘ring", "access_check_failed");
  }
  return toClinicalAccess(data?.[0]);
}

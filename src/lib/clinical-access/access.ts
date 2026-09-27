import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { ApiError } from "@/lib/api/errors";
import { logger } from "@/lib/logger";
import type { Database } from "@/lib/supabase/database.types";

/**
 * Referral-based authorization of a doctor's access to a patient's clinical
 * data. Working in the same clinic grants nothing by itself: a doctor sees a
 * patient only through
 *
 *   A. their own relationship — an appointment with the patient: the
 *      patient record and their own appointments with the patient;
 *   B. an active referral to them — pending or accepted and not past
 *      expires_at: the patient record and the consultation the referral
 *      came from, plus (once accepted) the patient's appointments with the
 *      referring doctor;
 *   C. otherwise nothing, and nothing ever in another clinic.
 *
 * Only active doctor records count. A referring doctor also sees the
 * follow-up appointment booked for their referral.
 *
 * The decision itself is public.doctor_patient_access() (see
 * supabase/migrations/20260927000003_referral_clinical_access.sql and
 * 20260927000004_clinical_access_hardening.sql), the same
 * function the patients/appointments RLS policies use, so the server and
 * direct database access can never disagree. Payments, conversations,
 * messages and voice notes are outside every doctor's clinical scope.
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
    /** Doctors whose appointments with the patient accepted referrals share. */
    sharedHistoryDoctorIds: string[];
    /** Appointments a referral links to: its consultation (receiver), its follow-up (referrer). */
    referralAppointmentIds: string[];
  };
  /** Active (pending or accepted, unexpired) referrals of the patient to this doctor. */
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

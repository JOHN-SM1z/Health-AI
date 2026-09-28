import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { ApiError } from "@/lib/api/errors";
import { logger } from "@/lib/logger";
import type { Database } from "@/lib/supabase/database.types";

/**
 * A doctor's access to a patient's clinical data. The patient's clinical
 * history is longitudinal — it belongs to the patient's clinic record — and a
 * doctor with a legitimate clinical relationship sees all of it (every
 * doctor's consultations and records) without asking anyone:
 *
 *   A. a treating relationship — any non-cancelled appointment with the
 *      patient (past, today or booked) or a record the doctor wrote;
 *   B. an open referral — pending, accepted or in progress and not past
 *      expires_at — to the doctor, or to the doctor's department while no
 *      doctor has taken it. Acceptance is a care step, never a gate;
 *   C. otherwise nothing: working in the same clinic grants nothing by
 *      itself, and nothing ever crosses clinics.
 *
 * Seeing a record never makes it the reader's: only its author corrects it
 * (src/lib/clinical-records/service.ts). Payments, conversations, staff and
 * clinic administration are outside every doctor's clinical scope.
 *
 * The decision itself is public.doctor_patient_access()
 * (supabase/migrations/20261002000001_longitudinal_history.sql), the same
 * function the patients/appointments/clinical_records RLS policies use, so
 * the server and direct database access can never disagree.
 */

export type ClinicalRelationship = "own" | "referred" | "none";

export type ClinicalAccess = {
  /** A (own), B (referred) or C (none); "own" wins when both apply. */
  relationship: ClinicalRelationship;
  allowed: boolean;
  /** The patient's whole clinical history in the clinic: every doctor's visits and records. */
  fullHistory: boolean;
  /** Open referrals of the patient to this doctor (or, untaken, to their department). */
  activeReferralIds: string[];
};

type AccessRow = Database["public"]["Functions"]["doctor_patient_access"]["Returns"][number];

export const NO_CLINICAL_ACCESS: ClinicalAccess = Object.freeze({
  relationship: "none",
  allowed: false,
  fullHistory: false,
  activeReferralIds: [] as string[],
}) as ClinicalAccess;

/** Maps the database decision to the server's shape; no row means no access. */
export function toClinicalAccess(row: AccessRow | null | undefined): ClinicalAccess {
  if (!row || !row.full_history) return NO_CLINICAL_ACCESS;
  return {
    relationship: row.own_patient ? "own" : "referred",
    allowed: true,
    fullHistory: true,
    activeReferralIds: [...row.active_referral_ids],
  };
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

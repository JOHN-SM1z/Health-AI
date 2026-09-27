import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { ApiError } from "@/lib/api/errors";
import { recordAudit } from "@/lib/audit";
import { logger } from "@/lib/logger";
import type { LinkedDoctor } from "@/lib/auth/guards";
import type { Database } from "@/lib/supabase/database.types";

/**
 * Referral-based authorization of a doctor's access to a patient's clinical
 * data. Working in the same clinic grants nothing by itself: a doctor sees a
 * patient only through
 *
 *   A. their own relationship — an appointment with the patient: the
 *      patient record and their own appointments with the patient;
 *   B. an active referral to them — pending or accepted and not past
 *      expires_at: the patient record, plus (once accepted) the patient's
 *      appointments with the referring doctor;
 *   C. otherwise nothing, and nothing ever in another clinic.
 *
 * The decision itself is public.doctor_patient_access() (see
 * supabase/migrations/20260927000003_referral_clinical_access.sql), the same
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
  };
  /** Active (pending or accepted, unexpired) referrals of the patient to this doctor. */
  activeReferralIds: string[];
};

type AccessRow = Database["public"]["Functions"]["doctor_patient_access"]["Returns"][number];

export const NO_CLINICAL_ACCESS: ClinicalAccess = Object.freeze({
  relationship: "none",
  allowed: false,
  scope: Object.freeze({ patientRecord: false, ownAppointments: false, sharedHistoryDoctorIds: [] as string[] }),
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
    },
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

export type ClinicalAppointment = {
  id: string;
  startAt: string;
  endAt: string;
  status: string;
  doctor: { id: string; name: string } | null;
  service: { name: string } | null;
};

export type PatientClinicalRecord = {
  patient: { id: string; fullName: string | null; phone: string | null; preferredLanguage: string };
  relationship: Exclude<ClinicalRelationship, "none">;
  activeReferralIds: string[];
  /** Only the appointments the access decision covers. */
  appointments: ClinicalAppointment[];
};

type AppointmentRow = {
  id: string;
  start_at: string;
  end_at: string;
  status: string;
  doctor_id: string;
  services: { name: string } | null;
  doctors: { name: string } | null;
};

/**
 * A patient's clinical record as the calling doctor may see it. Anything
 * outside the doctor's access — no relationship, another clinic, an expired,
 * revoked, declined or completed referral — is "not found", so patient ids
 * cannot be probed. Every view and every refusal is written to the audit
 * log; a view is only served once its access-log entry exists.
 */
export async function getPatientClinicalRecord(doctor: LinkedDoctor, patientId: string): Promise<PatientClinicalRecord> {
  const access = await canDoctorAccessPatientClinicalData(doctor.doctorId, patientId);
  const actor = { actorId: doctor.profileId, actorType: "staff" as const };

  if (!access.allowed || access.relationship === "none") {
    await recordAudit({
      clinicId: doctor.clinicId,
      action: "patient_clinical_access_denied",
      entityType: "patients",
      entityId: patientId,
      actor,
      metadata: { doctor_id: doctor.doctorId },
    });
    throw new ApiError(404, "Bemor topilmadi", "patient_not_found");
  }

  // The doctors whose appointments are shown come from the decision alone,
  // never from the request.
  const visibleDoctorIds = [
    ...(access.scope.ownAppointments ? [doctor.doctorId] : []),
    ...access.scope.sharedHistoryDoctorIds,
  ];

  const supabase = createAdminClient();
  const [patientRes, appointmentsRes] = await Promise.all([
    supabase
      .from("patients")
      .select("id, full_name, phone, preferred_language")
      .eq("id", patientId)
      .eq("clinic_id", doctor.clinicId)
      .maybeSingle(),
    visibleDoctorIds.length > 0
      ? supabase
          .from("appointments")
          .select("id, start_at, end_at, status, doctor_id, services(name), doctors(name)")
          .eq("clinic_id", doctor.clinicId)
          .eq("patient_id", patientId)
          .in("doctor_id", visibleDoctorIds)
          .order("start_at", { ascending: false })
          .limit(100)
      : null,
  ]);
  if (patientRes.error || appointmentsRes?.error) throw new ApiError(500, "Bemor ma‘lumotlarini yuklab bo‘lmadi");
  if (!patientRes.data) throw new ApiError(404, "Bemor topilmadi", "patient_not_found");

  await recordAudit({
    clinicId: doctor.clinicId,
    action: "patient_clinical_record_viewed",
    entityType: "patients",
    entityId: patientId,
    actor,
    metadata: {
      relationship: access.relationship,
      referral_ids: access.activeReferralIds,
      shared_history_doctor_ids: access.scope.sharedHistoryDoctorIds,
    },
    strict: true,
  });

  return {
    patient: {
      id: patientRes.data.id,
      fullName: patientRes.data.full_name,
      phone: patientRes.data.phone,
      preferredLanguage: patientRes.data.preferred_language,
    },
    relationship: access.relationship,
    activeReferralIds: access.activeReferralIds,
    appointments: ((appointmentsRes?.data ?? []) as unknown as AppointmentRow[]).map((a) => ({
      id: a.id,
      startAt: a.start_at,
      endAt: a.end_at,
      status: a.status,
      doctor: a.doctors ? { id: a.doctor_id, name: a.doctors.name } : null,
      service: a.services,
    })),
  };
}

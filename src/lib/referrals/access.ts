import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { ApiError } from "@/lib/api/errors";
import type { StaffContext, StaffRole } from "@/lib/auth/staff";

export type ReferralRow = {
  id: string;
  clinic_id: string;
  patient_id: string;
  referring_doctor_id: string;
  referred_to_doctor_id: string;
  originating_appointment_id: string | null;
  referral_reason: string;
  clinical_handoff_note: string | null;
  priority: "routine" | "urgent" | "emergency";
  status: "pending" | "accepted" | "in_progress" | "completed" | "declined" | "expired" | "revoked";
  created_at: string;
  updated_at: string;
  accepted_at: string | null;
  completed_at: string | null;
  expires_at: string | null;
  revoked_at: string | null;
  revocation_reason: string | null;
  revoked_by: string | null;
  created_by: string | null;
  updated_by: string | null;
};

export type CallerRole =
  | "referring_doctor"
  | "receiving_doctor"
  | "management";

import { recordAudit } from "@/lib/audit";

/** Resolve an involved active doctor in the verified clinic. Reads enforce
 * expiry without changing database state or exposing clinical text to managers. */
export async function assertReferralAccess(
  referralId: string,
  ctx: StaffContext & { clinicId: string },
): Promise<{
  referral: ReferralRow;
  callerRole: CallerRole;
  callerDoctorId: string | null;
}> {
  if (!ctx.roles.includes("doctor")) throw new ApiError(403, "Shifokor roli talab qilinadi", "forbidden");
  const supabase = createAdminClient();

  // Resolve the referral, always scoped to the caller's clinic.
  const { data: rawReferral, error } = await supabase
    .from("referrals")
    .select("*")
    .eq("id", referralId)
    .eq("clinic_id", ctx.clinicId)
    .maybeSingle();

  if (error) throw new ApiError(500, "Yo'llanmani yuklash muvaffaqiyatsiz bo'ldi");
  if (!rawReferral) throw new ApiError(404, "Yo'llanma topilmadi", "referral_not_found");

  let referral = rawReferral as ReferralRow;

  // Reads do not mutate lifecycle state; expiry is enforced before history access.
  if (referral.expires_at && referral.expires_at <= new Date().toISOString() &&
      ["pending", "accepted", "in_progress"].includes(referral.status)) {
    referral = { ...referral, status: "expired" };
  }

  // For doctor-role callers, resolve which doctor record belongs to them.
  const { data: doctor } = await supabase
    .from("doctors")
    .select("id")
    .eq("profile_id", ctx.profileId)
    .eq("clinic_id", ctx.clinicId)
    .eq("active", true)
    .maybeSingle();

  if (!doctor) {
    throw new ApiError(403, "Sizning shifokor hisobingiz topilmadi", "doctor_not_linked");
  }

  if (doctor.id === referral.referring_doctor_id) {
    return {
      referral: referral as ReferralRow,
      callerRole: "referring_doctor",
      callerDoctorId: doctor.id,
    };
  }

  if (doctor.id === referral.referred_to_doctor_id) {
    return {
      referral: referral as ReferralRow,
      callerRole: "receiving_doctor",
      callerDoctorId: doctor.id,
    };
  }

  // The caller is a doctor but not on this referral.
  throw new ApiError(403, "Bu yo'llanmaga kirish huquqingiz yo'q", "forbidden");
}

/**
 * Returns the doctor row for the authenticated staff member, or throws if the
 * profile is not linked to an active doctor in their clinic.
 * Shared by all doctor-facing referral + clinical-note routes.
 */
export async function requireLinkedDoctor(
  ctx: StaffContext & { clinicId: string },
): Promise<{ id: string; clinic_id: string }> {
  if (!ctx.roles.includes("doctor")) {
    throw new ApiError(403, "Shifokor roli talab qilinadi", "doctor_not_linked");
  }
  const supabase = createAdminClient();
  const { data: doctor } = await supabase
    .from("doctors")
    .select("id, clinic_id")
    .eq("profile_id", ctx.profileId)
    .eq("clinic_id", ctx.clinicId)
    .eq("active", true)
    .maybeSingle();

  if (!doctor) {
    throw new ApiError(403, "Sizning shifokor hisobingiz topilmadi", "doctor_not_linked");
  }
  return doctor;
}

// ---------------------------------------------------------------------------
// Patient-level clinical data authorization
// ---------------------------------------------------------------------------

/** Legacy level names remain type-compatible. The authoritative DB check now
 * returns own_patient for every authorized doctor; no management bypass exists. */
export type PatientAccessLevel =
  | "own_patient"
  | "referral"
  | "management"
  | "none";

export type PatientAccessResult = {
  level: PatientAccessLevel;
  doctorId: string | null;
  /** The referral that grants access, when `level === "referral"`. */
  referralId: string | null;
};

/** Use the same database authorization predicate as RLS. Errors deny access. */
export async function canDoctorAccessPatientClinicalData(
  doctorProfileId: string,
  patientId: string,
  clinicId: string,
  roles: StaffRole[],
): Promise<PatientAccessResult> {
  const noAccess: PatientAccessResult = { level: "none", doctorId: null, referralId: null };
  if (!roles.includes("doctor")) return noAccess;
  const supabase = createAdminClient();
  const { data: allowed, error } = await supabase.rpc("doctor_patient_access", {
    p_clinic: clinicId, p_patient: patientId, p_actor: doctorProfileId,
  });
  if (error || allowed !== true) return noAccess;
  const { data: doctor, error: doctorError } = await supabase.from("doctors")
    .select("id").eq("profile_id", doctorProfileId).eq("clinic_id", clinicId)
    .eq("active", true).maybeSingle();
  if (doctorError || !doctor) return noAccess;
  // Every authorized doctor sees shared history and only their own private notes.
  return { level: "own_patient", doctorId: doctor.id, referralId: null };
}

/**
 * Throws ApiError(403) if the caller has no clinical access to the patient.
 * Convenience wrapper around `canDoctorAccessPatientClinicalData`.
 */
export async function requirePatientClinicalAccess(
  ctx: StaffContext & { clinicId: string },
  patientId: string,
): Promise<PatientAccessResult> {
  const result = await canDoctorAccessPatientClinicalData(
    ctx.profileId,
    patientId,
    ctx.clinicId,
    ctx.roles,
  );

  if (result.level === "none") {
    throw new ApiError(
      403,
      "Bu bemorning klinik ma'lumotlariga kirish huquqingiz yo'q",
      "clinical_access_denied",
    );
  }

  return result;
}

/**
 * Sweeps overdue referrals in a clinic, transitions their status to 'expired',
 * and records individual tenant-scoped audit events.
 *
 * Safe to call periodically or from maintenance routes.
 *
 * @returns number of expired referrals
 */
export async function expireOverdueReferrals(clinicId: string): Promise<number> {
  const supabase = createAdminClient();
  const now = new Date().toISOString();

  const { data: overdue, error } = await supabase
    .from("referrals")
    .select("id, patient_id, status")
    .eq("clinic_id", clinicId)
    .in("status", ["pending", "accepted", "in_progress"])
    .lte("expires_at", now);

  if (error || !overdue || overdue.length === 0) return 0;

  let expiredCount = 0;
  for (const ref of overdue) {
    const { error: updateErr } = await supabase
      .from("referrals")
      .update({ status: "expired" })
      .eq("id", ref.id)
      .eq("clinic_id", clinicId).eq("status", ref.status);

    if (!updateErr) {
      expiredCount++;
      await recordAudit({
        clinicId,
        action: "referral_expired",
        entityType: "referrals",
        entityId: ref.id,
        actor: { actorType: "system" },
        oldValues: { status: ref.status },
        newValues: { status: "expired" },
        metadata: { patientId: ref.patient_id, referralId: ref.id },
      });
    }
  }

  return expiredCount;
}

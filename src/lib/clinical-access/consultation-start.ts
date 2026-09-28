import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { ApiError } from "@/lib/api/errors";
import { logger } from "@/lib/logger";
import type { Database } from "@/lib/supabase/database.types";
import { isSlotConflict, slotUnavailable } from "@/lib/booking/engine";

type AppointmentStatus = Database["public"]["Enums"]["appointment_status"];
export type ConsultationChannel = "doctor_workspace" | "doctor_queue" | "front_desk";

/**
 * Starts a consultation (an existing appointment) in ONE database transaction
 * — public.start_consultation(): the appointment moves from `fromStatus` to
 * in progress (compare-and-swap), the accepted referral waiting for it is
 * linked when `linkReferral` (the referral then moves to in progress), and
 * 'consultation_started' is audited with the actor — ids only, never clinical
 * text. `started` is false when the status had already changed, in which case
 * nothing was written. The caller has authorized the actor already.
 */
export async function startConsultationInDatabase(opts: {
  clinicId: string;
  appointmentId: string;
  fromStatus: AppointmentStatus;
  actorId: string;
  via: ConsultationChannel;
  linkReferral: boolean;
  /** When given, the appointment must be this doctor's. */
  doctorId?: string;
}): Promise<{ started: boolean; referralId: string | null }> {
  const { data, error } = await createAdminClient().rpc("start_consultation", {
    p_clinic_id: opts.clinicId,
    p_appointment_id: opts.appointmentId,
    p_from_status: opts.fromStatus,
    p_actor: opts.actorId,
    p_via: opts.via,
    p_link_referral: opts.linkReferral,
    p_doctor_id: opts.doctorId,
  });
  // A cancelled visit started again after another booking took its time.
  if (isSlotConflict(error)) throw slotUnavailable();
  if (error) {
    logger.error("start_consultation failed", { code: error.code });
    throw new ApiError(500, "Qabulni boshlab bo‘lmadi", "consultation_start_failed");
  }
  const result = data as { started?: boolean; referral_id?: string | null } | null;
  return { started: result?.started === true, referralId: result?.referral_id ?? null };
}

/**
 * The doctor starts a walk-in consultation now — public.start_walk_in_consultation():
 * booked in progress through the booking engine, linked to the waiting
 * accepted referral and audited as 'consultation_started', in one
 * transaction. A booking-engine refusal comes back as `errorCode` with
 * nothing written.
 */
export async function startWalkInInDatabase(opts: {
  clinicId: string;
  patientId: string;
  doctorId: string;
  serviceId: string;
  startAt: string;
  actorId: string;
}): Promise<{ appointmentId: string | null; errorCode: string | null; referralId: string | null }> {
  const { data, error } = await createAdminClient().rpc("start_walk_in_consultation", {
    p_clinic_id: opts.clinicId,
    p_patient_id: opts.patientId,
    p_doctor_id: opts.doctorId,
    p_service_id: opts.serviceId,
    p_start_at: opts.startAt,
    p_actor: opts.actorId,
  });
  if (error) {
    logger.error("start_walk_in_consultation failed", { code: error.code });
    throw new ApiError(500, "Qabulni boshlab bo‘lmadi", "booking_failed");
  }
  const result = data as { appointment_id?: string | null; error_code?: string | null; referral_id?: string | null } | null;
  return {
    appointmentId: result?.appointment_id ?? null,
    errorCode: result?.error_code ?? (result?.appointment_id ? null : "booking_failed"),
    referralId: result?.referral_id ?? null,
  };
}

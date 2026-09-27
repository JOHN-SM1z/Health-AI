import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { ApiError } from "@/lib/api/errors";
import { logger } from "@/lib/logger";
import { trackAnalytics } from "@/lib/analytics";
import type { LinkedDoctor } from "@/lib/auth/guards";
import { canDoctorAccessPatientClinicalData } from "@/lib/clinical-access/access";
import { canStartConsultation } from "@/lib/clinical-access/workspace";
import { patientAccessDenied } from "@/lib/clinical-access/denial";
import { linkConsultationToReferral } from "@/lib/referrals/service";
import { recordConsultationStarted } from "@/lib/clinical-access/consultation-audit";

const STARTABLE = ["pending", "confirmed", "checked_in"];

export type StartConsultationInput = { appointmentId?: string; serviceId?: string };

async function inProgressConsultation(doctor: LinkedDoctor, patientId: string): Promise<string | null> {
  const { data } = await createAdminClient()
    .from("appointments")
    .select("id")
    .eq("clinic_id", doctor.clinicId)
    .eq("patient_id", patientId)
    .eq("doctor_id", doctor.doctorId)
    .eq("status", "in_progress")
    .order("start_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return data?.id ?? null;
}

const BOOKING_ERRORS: Record<string, [number, string]> = {
  outside_working_hours: [409, "Hozir ish vaqtingiz emas — qabulni qabulxona orqali yozing"],
  time_blocked: [409, "Hozir sizda tanaffus yoki band vaqt belgilangan"],
  slot_taken: [409, "Hozir sizda boshqa qabul bor"],
  service_not_offered: [400, "Bu xizmat sizning xizmatlaringiz ro‘yxatida yo‘q"],
  past_slot: [409, "Qabul vaqtini belgilab bo‘lmadi, qayta urinib ko‘ring"],
};

/**
 * The calling doctor starts their own consultation with `patientId`: either
 * the visit booked for them (moved to in progress), or a walk-in booked now
 * through the booking engine (working hours, time blocks and overlaps all
 * checked there). Allowed for the doctor's own patient or a patient referred
 * to them with an accepted referral; a started consultation of an accepted
 * referral becomes its follow-up and the referral moves to in progress
 * (enforced by the database). Audited as 'consultation_started'. Idempotent:
 * an existing in-progress consultation with the patient is returned instead
 * of starting another.
 */
export async function startConsultation(
  doctor: LinkedDoctor,
  patientId: string,
  input: StartConsultationInput,
): Promise<{ appointmentId: string; started: boolean }> {
  const access = await canDoctorAccessPatientClinicalData(doctor.doctorId, patientId);
  if (!access.allowed) throw await patientAccessDenied(doctor, patientId);
  if (!canStartConsultation(access)) {
    throw new ApiError(409, "Avval yo‘llanmani qabul qiling", "referral_not_accepted");
  }

  const existing = await inProgressConsultation(doctor, patientId);
  if (existing) return { appointmentId: existing, started: false };

  const supabase = createAdminClient();
  let appointmentId: string;

  if (input.appointmentId) {
    const { data: visit, error } = await supabase
      .from("appointments")
      .select("id, status")
      .eq("id", input.appointmentId)
      .eq("clinic_id", doctor.clinicId)
      .eq("patient_id", patientId)
      .eq("doctor_id", doctor.doctorId)
      .maybeSingle();
    if (error) throw new ApiError(500, "Qabulni tekshirib bo‘lmadi");
    if (!visit) throw new ApiError(404, "Qabul topilmadi", "consultation_not_found");
    if (!STARTABLE.includes(visit.status)) throw new ApiError(409, "Bu qabulni boshlab bo‘lmaydi", "invalid_transition");
    const { data: started } = await supabase
      .from("appointments")
      .update({ status: "in_progress" })
      .eq("id", visit.id)
      .eq("status", visit.status)
      .select("id")
      .maybeSingle();
    if (!started) {
      const raced = await inProgressConsultation(doctor, patientId);
      if (raced) return { appointmentId: raced, started: false };
      throw new ApiError(409, "Qabul holati o‘zgargan, sahifani yangilang", "consultation_changed");
    }
    appointmentId = started.id;
  } else {
    if (!input.serviceId) throw new ApiError(400, "Xizmatni tanlang", "validation");
    // The engine only books future slots: the next whole minute.
    const startAt = new Date(Math.floor(Date.now() / 60_000) * 60_000 + 60_000).toISOString();
    const { data, error } = await supabase.rpc("book_appointment", {
      p_clinic_id: doctor.clinicId,
      p_patient_id: patientId,
      p_doctor_id: doctor.doctorId,
      p_service_id: input.serviceId,
      p_start_at: startAt,
      p_status: "in_progress",
      p_source: "walk_in",
      p_created_by: doctor.profileId,
    });
    if (error) {
      logger.error("walk-in consultation booking failed", { code: error.code });
      throw new ApiError(500, "Qabulni boshlab bo‘lmadi", "booking_failed");
    }
    const result = data as { appointment_id?: string; error_code?: string | null };
    if (result.error_code || !result.appointment_id) {
      // A concurrent start of the same consultation wins the slot: answer with it.
      if (result.error_code === "slot_taken") {
        const raced = await inProgressConsultation(doctor, patientId);
        if (raced) return { appointmentId: raced, started: false };
      }
      const [status, message] = BOOKING_ERRORS[result.error_code ?? ""] ?? [409, "Qabulni boshlab bo‘lmadi"];
      throw new ApiError(status, message, result.error_code ?? "booking_failed");
    }
    appointmentId = result.appointment_id;
  }

  await linkConsultationToReferral(doctor, patientId, appointmentId);
  await recordConsultationStarted({
    clinicId: doctor.clinicId,
    appointmentId,
    patientId,
    doctorId: doctor.doctorId,
    actorId: doctor.profileId,
    via: "doctor_workspace",
    walkIn: !input.appointmentId,
  });
  await trackAnalytics({
    clinicId: doctor.clinicId,
    patientId,
    eventType: "consultation_started",
    payload: { by: "doctor", walk_in: !input.appointmentId },
  });
  return { appointmentId, started: true };
}

import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { ApiError } from "@/lib/api/errors";
import { trackAnalytics } from "@/lib/analytics";
import type { LinkedDoctor } from "@/lib/auth/guards";
import { canDoctorAccessPatientClinicalData } from "@/lib/clinical-access/access";
import { canStartConsultation } from "@/lib/clinical-access/workspace";
import { actOnReferral } from "@/lib/referrals/service";
import { patientAccessDenied } from "@/lib/clinical-access/denial";
import { startConsultationInDatabase, startWalkInInDatabase } from "@/lib/clinical-access/consultation-start";
import { BookingError, bookingError } from "@/lib/booking/engine";

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

// The walk-in goes through the same booking operation (book_appointment, in
// start_walk_in_consultation): the booking contract's codes, worded for the
// doctor who is starting it now.
const WALK_IN_MESSAGES: Record<string, string> = {
  outside_working_hours: "Hozir ish vaqtingiz emas — qabulni qabulxona orqali yozing",
  time_blocked: "Hozir sizda tanaffus yoki band vaqt belgilangan",
  slot_taken: "Hozir sizda boshqa qabul bor",
  service_not_offered: "Bu xizmat sizning xizmatlaringiz ro‘yxatida yo‘q",
  past_slot: "Qabul vaqtini belgilab bo‘lmadi, qayta urinib ko‘ring",
};

/**
 * Starting to treat a referred patient is taking the referral on: the oldest
 * pending referral of this patient to the doctor (or, untaken, to their
 * department) is accepted first, so the database links the consultation to
 * it. A referral someone else just took or answered is simply left alone.
 */
async function acceptPendingReferral(doctor: LinkedDoctor, patientId: string): Promise<void> {
  const supabase = createAdminClient();
  let query = supabase
    .from("referrals")
    .select("id")
    .eq("clinic_id", doctor.clinicId)
    .eq("patient_id", patientId)
    .eq("status", "pending")
    .gt("expires_at", new Date().toISOString())
    .order("created_at", { ascending: true })
    .limit(1);
  query = doctor.specialtyId
    ? query.or(`referred_to_doctor_id.eq.${doctor.doctorId},and(referred_to_doctor_id.is.null,referred_to_specialty_id.eq.${doctor.specialtyId})`)
    : query.eq("referred_to_doctor_id", doctor.doctorId);
  const { data: pending, error } = await query.maybeSingle();
  if (error) throw new ApiError(500, "Yo‘llanmani tekshirib bo‘lmadi");
  if (!pending) return;
  try {
    await actOnReferral(doctor, pending.id, "accept");
  } catch (e) {
    if (!(e instanceof ApiError) || e.status >= 500) throw e;
  }
}

/**
 * The calling doctor starts their own consultation with `patientId`: either
 * the visit booked for them (moved to in progress), or a walk-in booked now
 * through the booking engine (working hours, time blocks and overlaps all
 * checked there). Allowed for the doctor's own patient or a patient referred
 * to them (or to their department). A pending referral is not a gate: it is
 * accepted as the consultation starts (a department referral is taken by
 * this doctor), and the started consultation of an accepted referral becomes
 * its follow-up with the referral in progress (enforced by the database). The start, the referral link and the
 * 'consultation_started' audit row are one database transaction. Idempotent:
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
    throw new ApiError(409, "Bu bemor bilan qabul boshlay olmaysiz", "consultation_not_allowed");
  }

  const existing = await inProgressConsultation(doctor, patientId);
  if (existing) return { appointmentId: existing, started: false };

  await acceptPendingReferral(doctor, patientId);

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
    const { started } = await startConsultationInDatabase({
      clinicId: doctor.clinicId,
      appointmentId: visit.id,
      fromStatus: visit.status,
      actorId: doctor.profileId,
      via: "doctor_workspace",
      linkReferral: true,
      doctorId: doctor.doctorId,
    });
    if (!started) {
      const raced = await inProgressConsultation(doctor, patientId);
      if (raced) return { appointmentId: raced, started: false };
      throw new ApiError(409, "Qabul holati o‘zgargan, sahifani yangilang", "consultation_changed");
    }
    appointmentId = visit.id;
  } else {
    if (!input.serviceId) throw new ApiError(400, "Xizmatni tanlang", "validation");
    // The engine only books future slots: the next whole minute.
    const startAt = new Date(Math.floor(Date.now() / 60_000) * 60_000 + 60_000).toISOString();
    const walkIn = await startWalkInInDatabase({
      clinicId: doctor.clinicId,
      patientId,
      doctorId: doctor.doctorId,
      serviceId: input.serviceId,
      startAt,
      actorId: doctor.profileId,
    });
    if (walkIn.errorCode || !walkIn.appointmentId) {
      // A concurrent start of the same consultation wins the slot: answer with it.
      if (walkIn.errorCode === "slot_taken") {
        const raced = await inProgressConsultation(doctor, patientId);
        if (raced) return { appointmentId: raced, started: false };
      }
      const refusal = bookingError(walkIn.errorCode ?? "rpc_error");
      throw new BookingError(refusal.status, WALK_IN_MESSAGES[walkIn.errorCode ?? ""] ?? refusal.message, refusal.bookingCode, refusal.reason);
    }
    appointmentId = walkIn.appointmentId;
  }

  await trackAnalytics({
    clinicId: doctor.clinicId,
    patientId,
    eventType: "consultation_started",
    payload: { by: "doctor", walk_in: !input.appointmentId },
  });
  return { appointmentId, started: true };
}

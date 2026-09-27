import "server-only";
import { recordAudit } from "@/lib/audit";
import { referralForConsultation } from "@/lib/referrals/service";

/**
 * Audit event for a consultation (appointment) moving to in progress, by
 * whoever started it: the doctor from their workspace or queue, or front-desk
 * staff. Ids only — never clinical text. The referral whose follow-up it is,
 * if any, is recorded too (the referral's own in_progress transition is
 * audited by the database as 'referral_in_progress').
 */
export async function recordConsultationStarted(opts: {
  clinicId: string;
  appointmentId: string;
  patientId: string;
  doctorId: string;
  actorId: string;
  via: "doctor_workspace" | "doctor_queue" | "front_desk";
  walkIn?: boolean;
}): Promise<void> {
  const referralId = await referralForConsultation(opts.clinicId, opts.appointmentId);
  await recordAudit({
    clinicId: opts.clinicId,
    action: "consultation_started",
    entityType: "appointments",
    entityId: opts.appointmentId,
    actor: { actorId: opts.actorId, actorType: "staff" },
    newValues: { status: "in_progress" },
    metadata: {
      patient_id: opts.patientId,
      doctor_id: opts.doctorId,
      referral_id: referralId,
      via: opts.via,
      walk_in: opts.walkIn ?? false,
    },
  });
}

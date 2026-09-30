import type { NextRequest } from "next/server";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireStaff } from "@/lib/auth/guards";
import { parseBody } from "@/lib/api/validate";
import { handleApiError, ApiError, ok } from "@/lib/api/errors";
import { trackAnalytics } from "@/lib/analytics";
import { startConsultationInDatabase } from "@/lib/clinical-access/consultation-start";
import { patientAccessDenied } from "@/lib/clinical-access/denial";

export const dynamic = "force-dynamic";

const statusSchema = z.object({
  status: z.enum(["checked_in", "in_progress", "completed"]),
});

type RouteContext = { params: Promise<{ id: string }> };

/**
 * Doctor-only appointment status flow: checked_in → in_progress → completed.
 * Doctors can only act on their OWN appointments (verified server-side).
 * Starting a consultation (→ in_progress) takes on a referral waiting for the
 * doctor (a pending one is accepted in the same database transaction, as when
 * starting from the patient's page), links the visit to it (the referral then moves to in progress) and is
 * audited as 'consultation_started' — one database transaction
 * (start_consultation). A website booking staff have not confirmed yet does
 * not move at all: its visitor is unverified, and a doctor advancing it would
 * make themselves the patient's treating doctor.
 */
export async function PATCH(request: NextRequest, ctx: RouteContext) {
  try {
    const staff = await requireStaff("doctor");
    // The doctor role itself: requireStaff ranks owner/admin/manager above
    // doctor, and a management account linked to a doctor record is still
    // not a doctor for the doctor portal (same rule as requireLinkedDoctor).
    if (!staff.roles.includes("doctor")) throw new ApiError(403, "Bu amal faqat shifokorlar uchun", "forbidden");
    const { id } = await ctx.params;
    const body = await parseBody(request, statusSchema);
    const supabase = createAdminClient();

    // The doctor must be linked to a doctors record in this clinic.
    const { data: doctor } = await supabase
      .from("doctors")
      .select("id, name, specialty_id")
      .eq("profile_id", staff.profileId)
      .eq("clinic_id", staff.clinicId)
      .eq("active", true)
      .maybeSingle();
    if (!doctor) throw new ApiError(403, "Sizning shifokor hisobingiz topilmadi", "doctor_not_linked");

    const { data: appointment, error: fetchError } = await supabase
      .from("appointments")
      .select("id, status, doctor_id, patient_id, source")
      .eq("id", id)
      .eq("clinic_id", staff.clinicId)
      .maybeSingle();
    // Another doctor's appointment answers exactly like one that doesn't exist:
    // an id can't be probed.
    if (fetchError || !appointment || appointment.doctor_id !== doctor.id) {
      throw new ApiError(404, "Qabul topilmadi", "appointment_not_found");
    }

    if (appointment.source === "web" && appointment.status === "pending") {
      throw new ApiError(409, "Bu veb-bronni avval qabulxona tasdiqlashi kerak", "awaiting_confirmation");
    }

    // A repeated tap (the same status again) changes nothing.
    if (body.status === appointment.status) return ok({ updated: false, status: body.status });

    // Only an active visit moves, and only forward. A cancelled or no-show
    // visit is reception's to bring back (validated like a booking); a
    // completed one is closed.
    const rank: Record<string, number> = { pending: 0, confirmed: 0, checked_in: 1, in_progress: 2, completed: 3 };
    if (!(appointment.status in rank) || appointment.status === "completed" || rank[body.status] < rank[appointment.status]) {
      throw new ApiError(409, "Noto‘g‘ri holat o‘tishi", "invalid_transition");
    }

    if (body.status === "in_progress" && appointment.status !== "in_progress") {
      const { started, errorCode } = await startConsultationInDatabase({
        clinicId: staff.clinicId,
        appointmentId: appointment.id,
        fromStatus: appointment.status,
        actorId: staff.profileId,
        via: "doctor_queue",
        linkReferral: true,
        doctorId: doctor.id,
      });
      // The database re-checked the doctor's access (and took a pending referral of theirs on) in the start's transaction.
      if (errorCode === "access_lost") {
        throw await patientAccessDenied(
          { ...staff, clinicId: staff.clinicId, doctorId: doctor.id, doctorName: doctor.name, specialtyId: doctor.specialty_id },
          appointment.patient_id,
        );
      }
      // Someone else changed the visit in between (a concurrent start included).
      if (!started) throw new ApiError(409, "Qabul holati o‘zgargan, sahifani yangilang", "consultation_changed");
    } else {
      // Compare-and-set: reception may have cancelled the visit meanwhile.
      const { data: changed, error } = await supabase
        .from("appointments")
        .update({ status: body.status })
        .eq("id", id)
        .eq("clinic_id", staff.clinicId)
        .eq("status", appointment.status)
        .select("id");
      if (error) throw new ApiError(500, "Holatni yangilab bo‘lmadi");
      if (!changed?.length) throw new ApiError(409, "Qabul holati o‘zgargan, sahifani yangilang", "consultation_changed");
    }

    await trackAnalytics({
      clinicId: staff.clinicId,
      patientId: appointment.patient_id,
      eventType: `appointment_${body.status}`,
      payload: { by: "doctor" },
    });

    return ok({ updated: true, status: body.status });
  } catch (e) {
    return handleApiError(e);
  }
}

import type { NextRequest } from "next/server";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireStaff } from "@/lib/auth/guards";
import { parseBody } from "@/lib/api/validate";
import { handleApiError, ApiError, ok } from "@/lib/api/errors";
import { trackAnalytics } from "@/lib/analytics";
import { linkConsultationToReferral } from "@/lib/referrals/service";
import { recordConsultationStarted } from "@/lib/clinical-access/consultation-audit";

export const dynamic = "force-dynamic";

const statusSchema = z.object({
  status: z.enum(["checked_in", "in_progress", "completed"]),
});

type RouteContext = { params: Promise<{ id: string }> };

/**
 * Doctor-only appointment status flow: checked_in → in_progress → completed.
 * Doctors can only act on their OWN appointments (verified server-side).
 * Starting a consultation (→ in_progress) links it to an accepted referral
 * waiting for it and is audited as 'consultation_started'; the referral then
 * moves to in progress in the database.
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
      .select("id, name")
      .eq("profile_id", staff.profileId)
      .eq("clinic_id", staff.clinicId)
      .eq("active", true)
      .maybeSingle();
    if (!doctor) throw new ApiError(403, "Sizning shifokor hisobingiz topilmadi", "doctor_not_linked");

    const { data: appointment, error: fetchError } = await supabase
      .from("appointments")
      .select("id, status, doctor_id, patient_id")
      .eq("id", id)
      .eq("clinic_id", staff.clinicId)
      .maybeSingle();
    // Another doctor's appointment answers exactly like one that doesn't exist:
    // an id can't be probed.
    if (fetchError || !appointment || appointment.doctor_id !== doctor.id) {
      throw new ApiError(404, "Qabul topilmadi", "appointment_not_found");
    }

    // Only forward transitions are allowed.
    const rank: Record<string, number> = { checked_in: 1, in_progress: 2, completed: 3 };
    if ((rank[body.status] ?? 0) < (rank[appointment.status] ?? 0)) {
      throw new ApiError(409, "Noto‘g‘ri holat o‘tishi", "invalid_transition");
    }

    const { error } = await supabase
      .from("appointments")
      .update({ status: body.status })
      .eq("id", id);
    if (error) throw new ApiError(500, "Holatni yangilab bo‘lmadi");

    if (body.status === "in_progress" && appointment.status !== "in_progress") {
      await linkConsultationToReferral(
        { ...staff, doctorId: doctor.id, doctorName: doctor.name },
        appointment.patient_id,
        appointment.id,
      );
      await recordConsultationStarted({
        clinicId: staff.clinicId,
        appointmentId: appointment.id,
        patientId: appointment.patient_id,
        doctorId: doctor.id,
        actorId: staff.profileId,
        via: "doctor_queue",
      });
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

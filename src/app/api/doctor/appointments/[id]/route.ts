import type { NextRequest } from "next/server";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireStaff } from "@/lib/auth/guards";
import { parseBody } from "@/lib/api/validate";
import { handleApiError, ApiError, ok } from "@/lib/api/errors";
import { trackAnalytics } from "@/lib/analytics";

export const dynamic = "force-dynamic";

const statusSchema = z.object({
  status: z.enum(["checked_in", "in_progress", "completed"]),
});

type RouteContext = { params: Promise<{ id: string }> };

/**
 * Doctor-only appointment status flow: checked_in → in_progress → completed.
 * Doctors can only act on their OWN appointments (verified server-side).
 */
export async function PATCH(request: NextRequest, ctx: RouteContext) {
  try {
    const staff = await requireStaff("doctor");
    const { id } = await ctx.params;
    const body = await parseBody(request, statusSchema);
    const supabase = createAdminClient();

    // The doctor must be linked to a doctors record in this clinic.
    const { data: doctor } = await supabase
      .from("doctors")
      .select("id")
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
    if (fetchError || !appointment) throw new ApiError(404, "Qabul topilmadi", "appointment_not_found");
    if (appointment.doctor_id !== doctor.id) throw new ApiError(403, "Bu qabul sizga tegishli emas", "not_yours");

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

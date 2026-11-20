import type { NextRequest } from "next/server";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { getClinicFromRequest } from "@/lib/clinics/context";
import { resolvePatientFromInitData, devIdentityAllowed } from "@/lib/patients/identity";
import { handleApiError, ApiError, ok, fail } from "@/lib/api/errors";
import { parseBody } from "@/lib/api/validate";
import { keyFromIp } from "@/lib/rate-limit";
import { sharedRateLimit } from "@/lib/rate-limit-shared";
import { enqueueCancellationNotification } from "@/lib/notifications/jobs";
import { trackAnalytics } from "@/lib/analytics";

export const dynamic = "force-dynamic";

const cancelSchema = z.object({
  initData: z.string().nullable().optional(),
  reason: z.string().max(300).optional(),
});

type RouteContext = { params: Promise<{ id: string }> };

/**
 * Patient self-cancellation. The appointment is owned by the verified
 * Telegram patient; server-side checks guarantee a patient can only cancel
 * their own appointment in their own clinic.
 */
export async function POST(request: NextRequest, ctx: RouteContext) {
  try {
    const { id } = await ctx.params;
    const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
    const limit = await sharedRateLimit({ key: keyFromIp(ip, `cancel-${id}`), limit: 10, windowMs: 60_000 });
    if (!limit.ok) return fail("Juda ko‘p so‘rov", 429, "rate_limited");

    const body = await parseBody(request, cancelSchema);
    if (body.initData === "dev" && !devIdentityAllowed()) {
      throw new ApiError(403, "Development identity is not allowed", "dev_identity_forbidden");
    }

    const clinic = await getClinicFromRequest(request);
    const resolved = await resolvePatientFromInitData(body.initData, clinic.id);
    if (!resolved) throw new ApiError(401, "Telegram identifikatori tasdiqlanmadi", "invalid_init_data");

    const supabase = createAdminClient();
    const { data: appointment, error: fetchError } = await supabase
      .from("appointments")
      .select("id, patient_id, status, start_at")
      .eq("id", id)
      .eq("clinic_id", clinic.id)
      .maybeSingle();
    if (fetchError || !appointment) throw new ApiError(404, "Qabul topilmadi", "appointment_not_found");
    if (appointment.patient_id !== resolved.patient.id) {
      throw new ApiError(403, "Bu qabul sizga tegishli emas", "not_owner");
    }
    if (["cancelled", "no_show", "completed"].includes(appointment.status)) {
      throw new ApiError(409, "Qabul allaqachon yakunlangan", "already_closed");
    }
    // A patient cancels a booking, not a visit: once they are checked in or
    // the time has come, only the clinic changes it.
    if (!["pending", "confirmed"].includes(appointment.status) || new Date(appointment.start_at).getTime() <= Date.now()) {
      throw new ApiError(409, "Qabul boshlangan — bekor qilish uchun klinikaga murojaat qiling", "not_cancellable");
    }

    // Compare-and-set on the status read above, in this clinic: a change made
    // meanwhile (the patient checked in at the desk) is never overwritten.
    const { data: cancelled, error: updateError } = await supabase
      .from("appointments")
      .update({
        status: "cancelled",
        cancelled_at: new Date().toISOString(),
        cancelled_reason: body.reason ?? "Bemor tomonidan bekor qilindi",
      })
      .eq("id", id)
      .eq("clinic_id", clinic.id)
      .eq("status", appointment.status)
      .select("id");
    if (updateError) throw new ApiError(500, "Qabulni bekor qilib bo‘lmadi");
    if (!cancelled?.length) throw new ApiError(409, "Qabul holati o‘zgargan, sahifani yangilang", "appointment_changed");

    if (resolved.patient.telegram_user_id) {
      await enqueueCancellationNotification({
        clinicId: clinic.id,
        appointmentId: id,
        patientTelegramUserId: resolved.patient.telegram_user_id,
      });
    }

    await trackAnalytics({ clinicId: clinic.id, patientId: resolved.patient.id, eventType: "booking_cancelled" });

    return ok({ cancelled: true });
  } catch (e) {
    return handleApiError(e);
  }
}
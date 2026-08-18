import type { NextRequest } from "next/server";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireRoles } from "@/lib/auth/guards";
import { parseBody } from "@/lib/api/validate";
import { handleApiError, ApiError, ok } from "@/lib/api/errors";
import { enqueueCancellationNotification, enqueueRescheduleNotification } from "@/lib/notifications/jobs";
import { trackAnalytics } from "@/lib/analytics";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

const schema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("cancel"),
    reason: z.string().max(300).optional(),
  }),
  z.object({
    action: z.literal("status"),
    status: z.enum(["pending", "confirmed", "checked_in", "in_progress", "completed", "cancelled", "no_show"]),
  }),
  z.object({
    action: z.literal("reschedule"),
    newStartAt: z.string().datetime(),
  }),
]);

type RouteContext = { params: Promise<{ id: string }> };

/**
 * Admin appointment management: cancel, status transitions, reschedule.
 * Rescheduling runs through the transactional reschedule RPC so slot
 * conflicts stay impossible. Changes are audited by DB triggers.
 */
export async function PATCH(request: NextRequest, ctx: RouteContext) {
  try {
    const staff = await requireRoles("owner", "admin", "manager", "receptionist");
    const { id } = await ctx.params;
    const body = await parseBody(request, schema);
    const supabase = createAdminClient();

    const { data: appointment, error: fetchError } = await supabase
      .from("appointments")
      .select("id, patient_id, status, cancelled_at, cancelled_reason, cancelled_by, patients!inner(telegram_user_id)")
      .eq("id", id)
      .eq("clinic_id", staff.clinicId)
      .maybeSingle();
    if (fetchError || !appointment) throw new ApiError(404, "Qabul topilmadi", "appointment_not_found");

    if (body.action === "cancel") {
      if (["cancelled", "no_show", "completed"].includes(appointment.status)) {
        throw new ApiError(409, "Qabul allaqachon yakunlangan", "already_closed");
      }
      const { error } = await supabase
        .from("appointments")
        .update({
          status: "cancelled",
          cancelled_at: new Date().toISOString(),
          cancelled_reason: body.reason ?? "Xodim tomonidan bekor qilindi",
          cancelled_by: staff.profileId,
        })
        .eq("id", id);
      if (error) throw new ApiError(500, "Bekor qilib bo‘lmadi");

      if (appointment.patients?.telegram_user_id) {
        await enqueueCancellationNotification({
          clinicId: staff.clinicId,
          appointmentId: id,
          patientTelegramUserId: appointment.patients.telegram_user_id,
        });
      }
      await trackAnalytics({
        clinicId: staff.clinicId,
        patientId: appointment.patient_id,
        eventType: "booking_cancelled",
        payload: { by: "staff" },
      });
      return ok({ updated: true });
    }

    if (body.action === "status") {
      // Keep cancellation fields consistent: a direct "cancelled" status
      // change must record who/when and notify the patient exactly like the
      // dedicated cancel action — otherwise the patient is never told.
      const isCancel = body.status === "cancelled";
      const wasClosed = ["cancelled", "no_show", "completed"].includes(appointment.status);
      const { error } = await supabase
        .from("appointments")
        .update({
          status: body.status,
          ...(isCancel
            ? {
                cancelled_at: appointment.cancelled_at ?? new Date().toISOString(),
                cancelled_reason: appointment.cancelled_reason ?? "Xodim tomonidan bekor qilindi",
                cancelled_by: appointment.cancelled_by ?? staff.profileId,
              }
            : {}),
        })
        .eq("id", id);
      if (error) throw new ApiError(500, "Holatni yangilab bo‘lmadi");

      if (isCancel && !wasClosed && appointment.patients?.telegram_user_id) {
        await enqueueCancellationNotification({
          clinicId: staff.clinicId,
          appointmentId: id,
          patientTelegramUserId: appointment.patients.telegram_user_id,
        });
      }
      return ok({ updated: true });
    }

    // reschedule
    const { data: rpcResult, error: rpcError } = await supabase.rpc("reschedule_appointment", {
      p_appointment_id: id,
      p_new_start_at: body.newStartAt,
      p_actor: staff.profileId,
    });
    if (rpcError) {
      logger.error("reschedule rpc failed", { error: rpcError.message });
      throw new ApiError(500, "Vaqtni o‘zgartirib bo‘lmadi", "reschedule_failed");
    }
    const result = rpcResult as { error_code?: string | null; error_message?: string | null };
    if (result.error_code) {
      throw new ApiError(409, result.error_message ?? "Bu vaqt band", result.error_code);
    }

    if (appointment.patients?.telegram_user_id) {
      await enqueueRescheduleNotification({
        clinicId: staff.clinicId,
        appointmentId: id,
        patientTelegramUserId: appointment.patients.telegram_user_id,
        newStartAt: new Date(body.newStartAt),
      });
    }

    return ok({ updated: true });
  } catch (e) {
    return handleApiError(e);
  }
}
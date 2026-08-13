import type { NextRequest } from "next/server";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireStaff } from "@/lib/auth/guards";
import { handleApiError, ApiError, ok } from "@/lib/api/errors";
import { phoneSchema, nameSchema, uuidSchema, parseBody } from "@/lib/api/validate";
import { trackAnalytics } from "@/lib/analytics";
import { enqueueBookingNotifications } from "@/lib/notifications/jobs";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

const createSchema = z.object({
  patientName: nameSchema,
  phone: phoneSchema.optional(),
  doctorId: uuidSchema,
  serviceId: uuidSchema,
  startAt: z.string().datetime(),
  source: z.enum(["admin", "walk_in"]),
  patientId: uuidSchema.optional(),
  notes: z.string().max(500).optional(),
});

/**
 * Admin-created appointments and walk-ins.
 * Walk-ins are placed in the queue via the same transactional engine, with
 * source recorded truthfully.
 */
export async function POST(request: NextRequest) {
  try {
    const ctx = await requireStaff("admin");
    const body = await parseBody(request, createSchema);
    const supabase = createAdminClient();

    // Resolve patient: reuse an existing patient or create one (walk-in
    // patients have no Telegram identity).
    let patientId = body.patientId;
    if (patientId) {
      const { data: patient } = await supabase
        .from("patients")
        .select("id")
        .eq("id", patientId)
        .eq("clinic_id", ctx.clinicId)
        .maybeSingle();
      if (!patient) throw new ApiError(404, "Bemor topilmadi", "patient_not_found");
    } else {
      const { data: created, error } = await supabase
        .from("patients")
        .insert({
          clinic_id: ctx.clinicId,
          full_name: body.patientName,
          phone: body.phone ?? null,
        })
        .select("id")
        .single();
      if (error || !created) throw new ApiError(500, "Bemorni yaratib bo‘lmadi");
      patientId = created.id;
    }

    const { data: rpcResult, error: rpcError } = await supabase.rpc("book_appointment", {
      p_clinic_id: ctx.clinicId,
      p_patient_id: patientId,
      p_doctor_id: body.doctorId,
      p_service_id: body.serviceId,
      p_start_at: body.startAt,
      p_status: "pending",
      p_source: body.source,
      p_notes: body.notes ?? undefined,
      p_created_by: ctx.profileId,
    });

    if (rpcError) {
      logger.error("admin book_appointment failed", { error: rpcError.message });
      throw new ApiError(500, "Qabul yaratishda xatolik", "booking_failed");
    }

    const result = rpcResult as {
      appointment_id?: string;
      error_code?: string | null;
      error_message?: string | null;
    };

    if (result.error_code || !result.appointment_id) {
      throw new ApiError(409, result.error_message ?? "Bu vaqt band", result.error_code ?? "conflict");
    }

    // Notify the patient when they have a Telegram identity.
    const { data: patient } = await supabase
      .from("patients")
      .select("telegram_user_id")
      .eq("id", patientId)
      .single();
    if (patient?.telegram_user_id) {
      await enqueueBookingNotifications({
        clinicId: ctx.clinicId,
        appointmentId: result.appointment_id,
        patientTelegramUserId: patient.telegram_user_id,
        startAt: new Date(body.startAt),
      });
    }

    await trackAnalytics({
      clinicId: ctx.clinicId,
      patientId,
      eventType: "admin_booking_created",
      payload: { source: body.source },
    });

    return ok({ appointmentId: result.appointment_id }, { status: 201 });
  } catch (e) {
    return handleApiError(e);
  }
}
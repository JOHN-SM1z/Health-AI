import type { NextRequest } from "next/server";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { getClinicFromRequest } from "@/lib/clinics/context";
import { resolvePatientFromInitData, devIdentityAllowed, getOrCreatePatientByContact } from "@/lib/patients/identity";
import { handleApiError, ApiError, ok, fail } from "@/lib/api/errors";
import { parseBody } from "@/lib/api/validate";
import { phoneSchema, nameSchema, uuidSchema } from "@/lib/api/validate";
import { rateLimit, keyFromIp } from "@/lib/rate-limit";
import { trackAnalytics } from "@/lib/analytics";
import { enqueueBookingNotifications } from "@/lib/notifications/jobs";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

const createBookingSchema = z.object({
  initData: z.string().nullable().optional(),
  doctorId: uuidSchema,
  serviceId: uuidSchema,
  startAt: z.string().datetime(),
  patientName: nameSchema,
  phone: phoneSchema,
  consent: z.boolean().refine((v) => v === true, "Shaxsiy ma‘lumotlarga rozilik talab qilinadi"),
  notes: z.string().trim().max(300).optional(),
});

export async function POST(request: NextRequest) {
  try {
    const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
    const limit = rateLimit({ key: keyFromIp(ip, "bookings"), limit: 10, windowMs: 60_000 });
    if (!limit.ok) return fail("Juda ko‘p so‘rov", 429, "rate_limited");

    const body = await parseBody(request, createBookingSchema);
    if (body.initData === "dev" && !devIdentityAllowed()) {
      throw new ApiError(403, "Development identity is not allowed", "dev_identity_forbidden");
    }

    const clinic = await getClinicFromRequest(request);
    let patient;
    let source: "telegram_mini_app" | "walk_in" = "telegram_mini_app";

    if (body.initData) {
      const resolved = await resolvePatientFromInitData(body.initData, clinic.id);
      if (!resolved) {
        throw new ApiError(401, "Telegram identifikatori tasdiqlanmadi", "invalid_init_data");
      }
      patient = resolved.patient;
    } else {
      // Direct Web Booking fallback
      patient = await getOrCreatePatientByContact({
        clinicId: clinic.id,
        phone: body.phone,
        fullName: body.patientName,
      });
      source = "walk_in";
    }

    const supabase = createAdminClient();

    // Record consent + contact details on the patient.
    const { error: patientUpdateError } = await supabase
      .from("patients")
      .update({
        consent_given: true,
        consent_given_at: new Date().toISOString(),
        full_name: body.patientName,
        phone: body.phone,
      })
      .eq("id", patient.id);
    if (patientUpdateError) throw new ApiError(500, "Bemor ma‘lumotlarini saqlab bo‘lmadi");

    await trackAnalytics({ clinicId: clinic.id, patientId: patient.id, eventType: "booking_attempt", payload: { serviceId: body.serviceId } });

    // Transactional creation via the RPC: availability re-check, advisory
    // lock, and the exclusion constraint all run in the database.
    const { data: rpcResult, error: rpcError } = await supabase.rpc("book_appointment", {
      p_clinic_id: clinic.id,
      p_patient_id: patient.id,
      p_doctor_id: body.doctorId,
      p_service_id: body.serviceId,
      p_start_at: body.startAt,
      p_status: "pending",
      p_source: source,
      p_notes: body.notes || undefined,
      p_created_by: undefined,
    });

    if (rpcError) {
      logger.error("book_appointment rpc failed", { error: rpcError.message });
      throw new ApiError(500, "Qabul yaratishda xatolik yuz berdi", "booking_failed");
    }

    const result = rpcResult as {
      appointment_id?: string;
      amount?: number;
      error_code?: string | null;
      error_message?: string | null;
    };

    if (result.error_code || !result.appointment_id) {
      if (result.error_code === "slot_taken") {
        await trackAnalytics({ clinicId: clinic.id, patientId: patient.id, eventType: "booking_slot_taken" });
        return fail(result.error_message ?? "Bu vaqt band qilingan", 409, "slot_taken");
      }
      throw new ApiError(
        409,
        result.error_message ?? "Bu vaqtga yozib bo‘lmadi",
        result.error_code ?? "booking_conflict",
      );
    }

    // Fetch the created appointment for the response.
    const { data: appointment } = await supabase
      .from("appointments")
      .select("*, doctors(name), services(name, price), payments(status, amount, currency, provider)")
      .eq("id", result.appointment_id)
      .single();

    // Notifications: confirmation + reminders (idempotent job enqueue).
    if (patient.telegram_user_id) {
      await enqueueBookingNotifications({
        clinicId: clinic.id,
        appointmentId: result.appointment_id,
        patientTelegramUserId: patient.telegram_user_id,
        startAt: new Date(body.startAt),
      });
    }

    await trackAnalytics({
      clinicId: clinic.id,
      patientId: patient.id,
      eventType: "booking_success",
      payload: { appointmentId: result.appointment_id },
    });

    return ok(
      {
        appointment,
        payment: {
          status: "unpaid",
          amount: result.amount ?? 0,
          currency: clinic.currency,
        },
      },
      { status: 201 },
    );
  } catch (e) {
    return handleApiError(e);
  }
}
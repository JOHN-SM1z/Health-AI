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
import { getPaymentProvider } from "@/lib/payments/provider";
import { transitionPaymentStatus } from "@/lib/payments/status";
import { logger } from "@/lib/logger";
import { BookingError, IDEMPOTENCY_KEY_PATTERN, createAppointment } from "@/lib/booking/engine";

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
  source: z.enum(["telegram_mini_app", "telegram_chat"]).optional(),
  /** One key per booking attempt, repeated on retries: a retry returns the first attempt's appointment. */
  idempotencyKey: z.string().regex(IDEMPOTENCY_KEY_PATTERN).optional(),
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
    let source: "telegram_mini_app" | "telegram_chat" | "web" = "telegram_mini_app";

    if (body.initData) {
      const resolved = await resolvePatientFromInitData(body.initData, clinic.id);
      if (!resolved) {
        throw new ApiError(401, "Telegram identifikatori tasdiqlanmadi", "invalid_init_data");
      }
      patient = resolved.patient;
      // Attribution only: the patient's identity is verified via initData
      // above; the source merely records which entry point was used. A
      // Telegram patient can never be mis-attributed as web, and a
      // non-Telegram booking can never claim a Telegram source.
      source = body.source === "telegram_chat" ? "telegram_chat" : "telegram_mini_app";
    } else {
      // Direct website booking — a genuine self-service booking with no
      // staff involved, distinct from a reception-entered 'walk_in'
      // (api/admin/appointments) even though both have no Telegram identity.
      patient = await getOrCreatePatientByContact({
        clinicId: clinic.id,
        phone: body.phone,
        fullName: body.patientName,
      });
      source = "web";
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

    // The one booking operation: the database validates the doctor, service,
    // time and working hours, serializes per doctor and inserts — the
    // exclusion constraint decides any race. Availability shown earlier was a
    // hint; a slot taken meanwhile answers SLOT_UNAVAILABLE.
    let booking;
    try {
      booking = await createAppointment({
        clinicId: clinic.id,
        patientId: patient.id,
        doctorId: body.doctorId,
        serviceId: body.serviceId,
        startAt: body.startAt,
        status: "pending",
        source,
        notes: body.notes || null,
        idempotencyKey: body.idempotencyKey ?? null,
      });
    } catch (e) {
      if (e instanceof BookingError && e.bookingCode === "SLOT_UNAVAILABLE") {
        await trackAnalytics({ clinicId: clinic.id, patientId: patient.id, eventType: "booking_slot_taken" });
      }
      throw e;
    }
    const result = { appointment_id: booking.appointmentId, amount: booking.amount };

    // Fetch the created appointment for the response.
    const { data: appointment } = await supabase
      .from("appointments")
      .select("*, doctors(name), services(name, price), payments(status, amount, currency, provider)")
      .eq("id", result.appointment_id)
      .single();

    // A retried attempt: the first one already initiated payment and
    // notifications — answer with what it created.
    if (booking.replayed) {
      const { data: payment } = await supabase
        .from("payments")
        .select("status, amount, provider, payment_url")
        .eq("appointment_id", result.appointment_id)
        .maybeSingle();
      return ok({
        appointment,
        replayed: true,
        payment: {
          status: payment?.status ?? "unpaid",
          amount: Number(payment?.amount ?? result.amount),
          currency: clinic.currency,
          provider: payment?.provider ?? "manual",
          paymentUrl: payment?.payment_url ?? null,
          manualConfirmationRequired: (payment?.provider ?? "manual") === "manual",
        },
      });
    }

    // Payment initiation. The RPC created the payment row (unpaid/manual).
    // A configured provider (Click) creates the invoice server-side; the
    // patient is only sent to the payment URL after the server holds it.
    let paymentStatus: string = "unpaid";
    let paymentUrl: string | null = null;
    let manualConfirmationRequired = true;
    let providerName = "manual";
    const { data: paymentRow } = await supabase
      .from("payments")
      .select("id, status, provider")
      .eq("appointment_id", result.appointment_id)
      .maybeSingle();

    const paymentProvider = getPaymentProvider();
    if (paymentRow && paymentProvider.name !== "manual") {
      try {
        const init = await paymentProvider.createPayment({
          appointmentId: result.appointment_id,
          patientId: patient.id,
          clinicId: clinic.id,
          amount: result.amount ?? 0,
          currency: clinic.currency,
        });
        await supabase
          .from("payments")
          .update({
            provider: paymentProvider.name,
            payment_url: init.paymentUrl ?? null,
            provider_reference: init.providerReference ?? null,
          })
          .eq("id", paymentRow.id);
        if (init.status === "pending") {
          await transitionPaymentStatus({
            paymentId: paymentRow.id,
            clinicId: clinic.id,
            to: "pending",
            actorType: "system",
            providerReference: init.providerReference,
            metadata: { initiated_at: new Date().toISOString() },
          });
        }
        paymentStatus = init.status;
        paymentUrl = init.paymentUrl ?? null;
        manualConfirmationRequired = init.manualConfirmationRequired;
        providerName = paymentProvider.name;
      } catch (e) {
        // The booking stands; the payment stays unpaid (desk collection).
        // Never claim a payment was initiated when the provider rejected it.
        logger.warn("payment initiation failed, keeping payment unpaid", {
          error: e instanceof Error ? e.message : String(e),
          appointmentId: result.appointment_id,
        });
      }
    }

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
          status: paymentStatus,
          amount: result.amount ?? 0,
          currency: clinic.currency,
          provider: providerName,
          paymentUrl,
          manualConfirmationRequired,
        },
      },
      { status: 201 },
    );
  } catch (e) {
    return handleApiError(e);
  }
}
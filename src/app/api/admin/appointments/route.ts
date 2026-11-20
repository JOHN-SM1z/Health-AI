import type { NextRequest } from "next/server";
import { createHash } from "node:crypto";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireRoles } from "@/lib/auth/guards";
import { handleApiError, ApiError, ok } from "@/lib/api/errors";
import { phoneSchema, nameSchema, uuidSchema, parseBody } from "@/lib/api/validate";
import { trackAnalytics } from "@/lib/analytics";
import { enqueueBookingNotifications } from "@/lib/notifications/jobs";
import { logger } from "@/lib/logger";
import { assertFollowUpBookable, linkFollowUp } from "@/lib/referrals/service";
import { IDEMPOTENCY_KEY_PATTERN, bookingError, createAppointment } from "@/lib/booking/engine";
import { formatInClinicTz, fromClinicTime } from "@/lib/timezone";

export const dynamic = "force-dynamic";

const createSchema = z
  .object({
    patientName: nameSchema,
    phone: phoneSchema.optional(),
    doctorId: uuidSchema,
    serviceId: uuidSchema,
    /** An instant (ISO 8601 with Z/offset) … */
    startAt: z.string().datetime({ offset: true }).optional(),
    /** … or the clinic's wall-clock time ("2026-10-01T14:00"), converted on the server in the clinic timezone. */
    startLocal: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:00)?$/).optional(),
    source: z.enum(["admin", "walk_in"]),
    patientId: uuidSchema.optional(),
    notes: z.string().max(500).optional(),
    // Books the follow-up of an accepted referral: the referral fixes the
    // patient and the doctor, and the new appointment is linked to it.
    referralId: uuidSchema.optional(),
    /** One key per booking attempt, repeated on retries (double click, network retry). */
    idempotencyKey: z.string().regex(IDEMPOTENCY_KEY_PATTERN).optional(),
  })
  .refine((b) => !!b.startAt !== !!b.startLocal, { message: "Qabul vaqtini ko‘rsating", path: ["startAt"] });

/** The instant a staff member asked for, reading a wall-clock time in the clinic's own timezone (never the browser's). */
function requestedStart(body: { startAt?: string; startLocal?: string }, clinicTimezone: string): string {
  if (body.startAt) return new Date(body.startAt).toISOString();
  const local = body.startLocal!.slice(0, 16);
  const instant = fromClinicTime(`${local}:00`, clinicTimezone);
  // Rejects impossible dates (2026-02-30) and wall-clock times a DST change skips.
  if (Number.isNaN(instant.getTime()) || formatInClinicTz(instant, clinicTimezone, "yyyy-MM-dd'T'HH:mm") !== local) {
    throw bookingError("invalid_local_time");
  }
  return instant.toISOString();
}

/**
 * The walk-in patient of one booking attempt gets an id derived from the
 * attempt's idempotency key: a retried or double-clicked request finds the
 * same patient instead of creating a second one.
 */
function walkInPatientId(clinicId: string, idempotencyKey: string): string {
  const h = createHash("sha256").update(`walk-in:${clinicId}:${idempotencyKey}`).digest();
  h[6] = (h[6] & 0x0f) | 0x40;
  h[8] = (h[8] & 0x3f) | 0x80;
  const hex = h.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Admin-created appointments and walk-ins.
 * Walk-ins are placed in the queue via the same transactional engine, with
 * source recorded truthfully.
 */
export async function POST(request: NextRequest) {
  try {
    const ctx = await requireRoles("owner", "admin", "manager", "receptionist");
    const body = await parseBody(request, createSchema);
    const supabase = createAdminClient();
    const startAt = requestedStart(body, ctx.clinicTimezone);

    const followUp = body.referralId
      ? await assertFollowUpBookable(ctx.clinicId, body.referralId, body.doctorId, body.patientId)
      : null;

    // Resolve patient: reuse an existing patient or create one (walk-in
    // patients have no Telegram identity). A referral follow-up is always for
    // the referred patient. Clinic scoping is checked here and again by the
    // booking operation (the patient must belong to the clinic).
    let patientId = followUp?.patientId ?? body.patientId;
    if (patientId) {
      const { data: patient } = await supabase
        .from("patients")
        .select("id, merged_into_patient_id")
        .eq("id", patientId)
        .eq("clinic_id", ctx.clinicId)
        .maybeSingle();
      if (!patient) throw bookingError("patient_not_found");
      // A merged record takes no new visits (Phase 14): book the person's canonical record.
      patientId = patient.merged_into_patient_id ?? patient.id;
    } else if (body.idempotencyKey) {
      // A retry or a second click of the same attempt finds its patient
      // already created: the unique violation means exactly that (an upsert
      // on the id alone raced against the (id, clinic_id) key and failed).
      // The booking operation below checks the patient is this clinic's.
      const id = walkInPatientId(ctx.clinicId, body.idempotencyKey);
      const { error } = await supabase
        .from("patients")
        .insert({ id, clinic_id: ctx.clinicId, full_name: body.patientName, phone: body.phone ?? null });
      if (error && error.code !== "23505") throw new ApiError(500, "Bemorni yaratib bo‘lmadi");
      patientId = id;
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

    // The one booking operation — the same one the Mini App and the website
    // use. A slot an online patient took first answers SLOT_UNAVAILABLE;
    // reception cannot override it.
    const booking = await createAppointment({
      clinicId: ctx.clinicId,
      patientId,
      doctorId: body.doctorId,
      serviceId: body.serviceId,
      startAt,
      status: "pending",
      source: body.source,
      notes: body.notes ?? null,
      createdBy: ctx.profileId,
      idempotencyKey: body.idempotencyKey ?? null,
    });
    const result = { appointment_id: booking.appointmentId };
    if (booking.replayed) return ok({ appointmentId: result.appointment_id, replayed: true });

    if (followUp && body.referralId) {
      let linked = false;
      let linkError: unknown = null;
      try {
        linked = await linkFollowUp(ctx.clinicId, body.referralId, result.appointment_id, followUp.currentFollowUpId);
      } catch (e) {
        linkError = e;
      }
      if (!linked) {
        // The referral changed after the check (another booking won the race,
        // or it was revoked/expired): release the slot before anyone is
        // notified about it — and its idempotency key, so a new attempt can book.
        const { error: releaseError } = await supabase
          .from("appointments")
          .update({
            status: "cancelled",
            cancelled_at: new Date().toISOString(),
            cancelled_reason: linkError
              ? "Yo‘llanma yopilgani sababli qabul bekor qilindi"
              : "Yo‘llanma uchun boshqa qabul allaqachon yozilgan",
            cancelled_by: ctx.profileId,
            idempotency_key: null,
          })
          .eq("id", result.appointment_id)
          .eq("clinic_id", ctx.clinicId);
        if (releaseError) {
          logger.error("referral follow-up release failed", { appointmentId: result.appointment_id, code: releaseError.code });
        }
        throw linkError ?? new ApiError(409, "Bu yo‘llanma uchun qabul allaqachon yozilgan", "follow_up_exists");
      }
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
        startAt: new Date(startAt),
      });
    }

    await trackAnalytics({
      clinicId: ctx.clinicId,
      patientId,
      eventType: "admin_booking_created",
      payload: { source: body.source, ...(followUp ? { referral_follow_up: true } : {}) },
    });

    return ok({ appointmentId: result.appointment_id }, { status: 201 });
  } catch (e) {
    return handleApiError(e);
  }
}
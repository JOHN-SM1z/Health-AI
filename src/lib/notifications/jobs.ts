import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { logger } from "@/lib/logger";
import type { Database } from "@/lib/supabase/database.types";

export type JobType = Database["public"]["Enums"]["notification_job_type"];

/**
 * Enqueues a notification job. Idempotency: a job with the same
 * idempotency_key is never enqueued twice.
 */
export async function enqueueNotificationJob(opts: {
  clinicId: string;
  type: JobType;
  appointmentId?: string | null;
  conversationId?: string | null;
  patientTelegramUserId?: number | null;
  scheduledFor: Date;
  idempotencyKey: string;
  channel?: "telegram";
  recipientType?: "patient" | "admin";
  maxAttempts?: number;
}): Promise<{ enqueued: boolean; jobId?: string }> {
  const supabase = createAdminClient();

  const { data: existing } = await supabase
    .from("notification_jobs")
    .select("id")
    .eq("idempotency_key", opts.idempotencyKey)
    .maybeSingle();
  if (existing) return { enqueued: false, jobId: existing.id };

  const { data, error } = await supabase
    .from("notification_jobs")
    .insert({
      clinic_id: opts.clinicId,
      type: opts.type,
      appointment_id: opts.appointmentId ?? null,
      conversation_id: opts.conversationId ?? null,
      patient_telegram_user_id: opts.patientTelegramUserId ?? null,
      scheduled_for: opts.scheduledFor.toISOString(),
      idempotency_key: opts.idempotencyKey,
      channel: opts.channel ?? "telegram",
      recipient_type: opts.recipientType ?? "patient",
      max_attempts: opts.maxAttempts ?? 3,
    })
    .select("id")
    .single();

  if (error) {
    logger.error("notification job enqueue failed", { type: opts.type, error: error.message });
    return { enqueued: false };
  }
  return { enqueued: true, jobId: data.id };
}

/** Booking confirmation + the two reminders, with unique idempotency keys. */
export async function enqueueBookingNotifications(opts: {
  clinicId: string;
  appointmentId: string;
  patientTelegramUserId: number;
  startAt: Date;
}) {
  const { clinicId, appointmentId, patientTelegramUserId, startAt } = opts;

  await enqueueNotificationJob({
    clinicId,
    type: "booking_confirmation",
    appointmentId,
    patientTelegramUserId,
    scheduledFor: new Date(),
    idempotencyKey: `confirm:${appointmentId}`,
  });

  const reminder24 = new Date(startAt.getTime() - 24 * 60 * 60 * 1000);
  if (reminder24.getTime() > Date.now()) {
    await enqueueNotificationJob({
      clinicId,
      type: "reminder_24h",
      appointmentId,
      patientTelegramUserId,
      scheduledFor: reminder24,
      idempotencyKey: `rem24:${appointmentId}`,
    });
  }

  const reminder2 = new Date(startAt.getTime() - 2 * 60 * 60 * 1000);
  if (reminder2.getTime() > Date.now()) {
    await enqueueNotificationJob({
      clinicId,
      type: "reminder_2h",
      appointmentId,
      patientTelegramUserId,
      scheduledFor: reminder2,
      idempotencyKey: `rem2:${appointmentId}`,
    });
  }
}

export async function enqueueCancellationNotification(opts: {
  clinicId: string;
  appointmentId: string;
  patientTelegramUserId: number;
}) {
  const { clinicId, appointmentId, patientTelegramUserId } = opts;
  await enqueueNotificationJob({
    clinicId,
    type: "cancellation",
    appointmentId,
    patientTelegramUserId,
    scheduledFor: new Date(),
    idempotencyKey: `cancel:${appointmentId}`,
  });
}

export async function enqueueRescheduleNotification(opts: {
  clinicId: string;
  appointmentId: string;
  patientTelegramUserId: number;
}) {
  const { clinicId, appointmentId, patientTelegramUserId } = opts;
  await enqueueNotificationJob({
    clinicId,
    type: "reschedule",
    appointmentId,
    patientTelegramUserId,
    scheduledFor: new Date(),
    idempotencyKey: `reschedule:${appointmentId}`,
  });
}
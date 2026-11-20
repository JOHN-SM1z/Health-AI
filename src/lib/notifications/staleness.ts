import type { Database } from "@/lib/supabase/database.types";

type JobType = Database["public"]["Enums"]["notification_job_type"];

/** A reminder says "in 24 hours" / "in 2 hours": sent later than this, its wording is wrong. */
const REMINDER_LATE_MS = 60 * 60 * 1000;
/** A confirmation, cancellation or reschedule notice is news only for a day. */
const NOTICE_LATE_MS = 24 * 60 * 60 * 1000;

const APPOINTMENT_MESSAGES: ReadonlySet<JobType> = new Set([
  "booking_confirmation",
  "reminder_24h",
  "reminder_2h",
  "cancellation",
  "reschedule",
]);

/**
 * Why an appointment message must not be sent any more, or null when it may be.
 *
 * Jobs can sit unsent for a long time — the scheduler was down, or the clinic's
 * bot was not connected — and a backlog must never reach the patient as a
 * "reminder" for an appointment that already happened or a month-old
 * confirmation. Such jobs are skipped, not retried.
 */
export function staleAppointmentMessage(
  type: JobType,
  scheduledFor: string,
  appointmentStartAt: string,
  now: Date = new Date(),
): string | null {
  if (!APPOINTMENT_MESSAGES.has(type)) return null;
  const nowMs = now.getTime();
  if (Date.parse(appointmentStartAt) <= nowMs) return "appointment time has passed";
  const lateMs = nowMs - Date.parse(scheduledFor);
  const limit = type === "reminder_24h" || type === "reminder_2h" ? REMINDER_LATE_MS : NOTICE_LATE_MS;
  if (lateMs > limit) return "too late to send";
  return null;
}

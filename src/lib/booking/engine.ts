import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { ApiError } from "@/lib/api/errors";
import { logger } from "@/lib/logger";
import type { Database } from "@/lib/supabase/database.types";

/**
 * The authoritative booking service: every channel that creates or moves an
 * appointment — the Mini App and the bot's deep link, the website, reception
 * and admin (POST /api/admin/appointments), the doctor's walk-in
 * (start_walk_in_consultation, in SQL) — ends in the same database operation,
 * book_appointment() / reschedule_appointment(). Those validate, serialize per
 * doctor and insert in one transaction, and the exclusion constraint
 * no_overlapping_active_appointments guarantees that a clinic's doctor never
 * holds two active appointments in overlapping time, whatever wrote the row.
 * Availability (GET /api/availability) is only a hint: the booking decides.
 */

type AppointmentStatus = Database["public"]["Enums"]["appointment_status"];
type AppointmentSource = Database["public"]["Enums"]["appointment_source"];

/** The booking error contract every booking endpoint answers with. */
export type BookingErrorCode =
  | "SLOT_UNAVAILABLE"
  | "INVALID_TIME"
  | "INVALID_DOCTOR"
  | "INVALID_PATIENT"
  | "INVALID_SERVICE"
  | "INVALID_CLINIC"
  | "IDEMPOTENCY_KEY_REUSED"
  | "APPOINTMENT_NOT_FOUND"
  | "NOT_RESCHEDULABLE"
  | "SERVER_ERROR";

export const SLOT_UNAVAILABLE_MESSAGE = "Bu vaqt endi bo‘sh emas. Iltimos, boshqa vaqtni tanlang.";

/** Database result codes → contract. `reason` keeps the precise cause. */
const ENGINE_ERRORS: Record<string, { status: number; code: BookingErrorCode; message: string }> = {
  slot_taken: { status: 409, code: "SLOT_UNAVAILABLE", message: SLOT_UNAVAILABLE_MESSAGE },
  time_blocked: { status: 409, code: "SLOT_UNAVAILABLE", message: SLOT_UNAVAILABLE_MESSAGE },
  outside_working_hours: { status: 422, code: "INVALID_TIME", message: "Bu vaqt shifokorning ish vaqtiga to‘g‘ri kelmaydi." },
  past_slot: { status: 422, code: "INVALID_TIME", message: "O‘tib ketgan vaqtga yozib bo‘lmaydi." },
  invalid_local_time: { status: 422, code: "INVALID_TIME", message: "Bunday sana yoki vaqt mavjud emas." },
  doctor_not_found: { status: 422, code: "INVALID_DOCTOR", message: "Shifokor topilmadi yoki qabul qilmaydi." },
  patient_not_found: { status: 422, code: "INVALID_PATIENT", message: "Bemor topilmadi." },
  service_not_found: { status: 422, code: "INVALID_SERVICE", message: "Xizmat topilmadi." },
  service_not_offered: { status: 422, code: "INVALID_SERVICE", message: "Bu shifokor ushbu xizmatni ko‘rsatmaydi." },
  clinic_not_found: { status: 422, code: "INVALID_CLINIC", message: "Klinika topilmadi." },
  idempotency_key_reused: {
    status: 409,
    code: "IDEMPOTENCY_KEY_REUSED",
    message: "Bu so‘rov boshqa yozuv uchun ishlatilgan. Sahifani yangilab, qaytadan urinib ko‘ring.",
  },
  appointment_not_found: { status: 404, code: "APPOINTMENT_NOT_FOUND", message: "Qabul topilmadi." },
  not_reschedulable: { status: 409, code: "NOT_RESCHEDULABLE", message: "Bu qabulning vaqtini o‘zgartirib bo‘lmaydi." },
};

export class BookingError extends ApiError {
  constructor(
    status: number,
    message: string,
    public readonly bookingCode: BookingErrorCode,
    public readonly reason?: string,
  ) {
    super(status, message, bookingCode, reason ? { reason } : undefined);
    this.name = "BookingError";
  }
}

/** The contract error for a database result code (unknown codes are server errors, never shown raw). */
export function bookingError(engineCode: string): BookingError {
  const known = ENGINE_ERRORS[engineCode];
  if (known) return new BookingError(known.status, known.message, known.code, engineCode);
  logger.error("unexpected booking result", { engineCode });
  return new BookingError(500, "Qabulni yozib bo‘lmadi, keyinroq urinib ko‘ring.", "SERVER_ERROR", engineCode);
}

/** Postgres exclusion_violation: another active appointment holds the time. */
export function isSlotConflict(error: { code?: string } | null | undefined): boolean {
  return error?.code === "23P01";
}

export function slotUnavailable(): BookingError {
  return bookingError("slot_taken");
}

/** Client-generated key of one booking attempt: repeat it on retries, a new one per new attempt. */
export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;

export type CreateAppointmentInput = {
  clinicId: string;
  patientId: string;
  doctorId: string;
  serviceId: string;
  startAt: string;
  source: AppointmentSource;
  /** A booking starts a visit: pending by default; the doctor's walk-in starts in progress. */
  status?: Extract<AppointmentStatus, "pending" | "confirmed" | "checked_in" | "in_progress">;
  notes?: string | null;
  createdBy?: string | null;
  idempotencyKey?: string | null;
};

export type CreatedAppointment = {
  appointmentId: string;
  amount: number;
  /** An earlier attempt with the same idempotency key created it: no new side effects. */
  replayed: boolean;
};

/**
 * Creates an appointment through the one booking operation. The caller has
 * authenticated and authorized the request and resolved clinic and patient on
 * the server; duration, price, end time and availability are decided in the
 * database. Throws BookingError on any refusal.
 */
export async function createAppointment(input: CreateAppointmentInput): Promise<CreatedAppointment> {
  const { data, error } = await createAdminClient().rpc("book_appointment", {
    p_clinic_id: input.clinicId,
    p_patient_id: input.patientId,
    p_doctor_id: input.doctorId,
    p_service_id: input.serviceId,
    p_start_at: input.startAt,
    p_status: input.status ?? "pending",
    p_source: input.source,
    p_notes: input.notes ?? undefined,
    p_created_by: input.createdBy ?? undefined,
    p_idempotency_key: input.idempotencyKey ?? undefined,
  });
  if (error) {
    logger.error("book_appointment failed", { code: error.code });
    throw bookingError("rpc_error");
  }
  const result = data as {
    appointment_id?: string | null;
    amount?: number | null;
    error_code?: string | null;
    replayed?: boolean | null;
  } | null;
  if (!result || result.error_code || !result.appointment_id) {
    throw bookingError(result?.error_code ?? "rpc_error");
  }
  return { appointmentId: result.appointment_id, amount: Number(result.amount ?? 0), replayed: result.replayed === true };
}

/**
 * Moves an appointment of `clinicId` to `newStartAt` through the one
 * reschedule operation (same per-doctor lock and constraint as booking; the
 * appointment never conflicts with itself). Throws BookingError on refusal.
 */
export async function rescheduleAppointment(input: {
  clinicId: string;
  appointmentId: string;
  newStartAt: string;
  actorId?: string | null;
}): Promise<void> {
  const { data, error } = await createAdminClient().rpc("reschedule_appointment", {
    p_clinic_id: input.clinicId,
    p_appointment_id: input.appointmentId,
    p_new_start_at: input.newStartAt,
    p_actor: input.actorId ?? undefined,
  });
  if (error) {
    logger.error("reschedule_appointment failed", { code: error.code });
    throw bookingError("rpc_error");
  }
  const result = data as { error_code?: string | null } | null;
  if (result?.error_code) throw bookingError(result.error_code);
}

import type { Database } from "@/lib/supabase/database.types";

type AppointmentStatus = Database["public"]["Enums"]["appointment_status"];

export type ConsultationStep = { status: AppointmentStatus; label: string };

// Doctors may only ever move an appointment forward through these three
// stages — the DB trigger (appointments_doctor_status_only) enforces
// status-only writes for a doctor session, and the API route
// (/api/doctor/appointments/[id]) enforces this exact rank order server-side.
// pending/confirmed -> checked_in is included so "Keldi" is reachable in one
// step regardless of whether reception already confirmed the booking.
const NEXT_STEP: Partial<Record<AppointmentStatus, ConsultationStep>> = {
  pending: { status: "checked_in", label: "Keldi" },
  confirmed: { status: "checked_in", label: "Keldi" },
  checked_in: { status: "in_progress", label: "Qabulni boshlash" },
  in_progress: { status: "completed", label: "Qabulni yakunlash" },
};

/** The doctor's one next action for an appointment's current status, or null once it's terminal (completed/cancelled/no_show). */
export function nextConsultationStep(status: AppointmentStatus): ConsultationStep | null {
  return NEXT_STEP[status] ?? null;
}

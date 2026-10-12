import { createAdminClient } from "@/lib/supabase/admin";
import { requireLinkedDoctor } from "@/lib/auth/guards";
import { ApiError, handleApiError, ok } from "@/lib/api/errors";
import { localDayWindow } from "@/lib/time/local";

export const dynamic = "force-dynamic";

/**
 * The doctor's own booked appointments of the clinic day, in one request.
 * Before, the doctor's home made four calls one after another (session, doctor
 * record, clinic timezone, appointments). The clinic day is computed here in
 * the clinic's timezone; only the linked doctor's own appointments, in their
 * own clinic, are returned. An account not linked to a doctor record gets
 * `linked: false` so the page can say so, instead of an error.
 */
export async function GET() {
  try {
    let doctor;
    try {
      doctor = await requireLinkedDoctor();
    } catch (e) {
      if (e instanceof ApiError && e.code === "doctor_not_linked") return ok({ linked: false, doctorName: null, appointments: [] });
      throw e;
    }
    const { start, end } = localDayWindow(doctor.clinicTimezone);
    const { data, error } = await createAdminClient()
      .from("appointments")
      .select("id, patient_id, start_at, status, patients(full_name, phone), services(name, price)")
      .eq("clinic_id", doctor.clinicId)
      .eq("doctor_id", doctor.doctorId)
      .gte("start_at", start)
      .lt("start_at", end)
      .not("status", "in", '("cancelled","no_show")')
      .order("start_at", { ascending: true })
      .limit(200);
    if (error) throw new ApiError(500, "Navbatni yuklab bo‘lmadi");
    return ok({ linked: true, doctorName: doctor.doctorName, day: { start, end }, appointments: data ?? [] });
  } catch (e) {
    return handleApiError(e);
  }
}

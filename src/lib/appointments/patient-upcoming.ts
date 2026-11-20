import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { logger } from "@/lib/logger";
import { patientRecordIds } from "@/lib/patients/record-group";
import { ACTIVE_STATUSES, formatClinicDateTime, isUpcoming, patientStatus } from "@/lib/appointments/patient-view";

export type UpcomingAppointment = {
  id: string;
  start_at: string;
  end_at: string;
  status: string;
  doctorName: string | null;
  serviceName: string | null;
};

/**
 * The patient's upcoming visits in their clinic (across merged records),
 * soonest first. The caller has already established who the patient is
 * (verified Telegram webhook or initData) — never an id from a browser.
 */
export async function listUpcomingAppointments(clinicId: string, patientId: string, limit = 5): Promise<UpcomingAppointment[]> {
  const ids = await patientRecordIds(clinicId, patientId);
  const { data, error } = await createAdminClient()
    .from("appointments")
    .select("id, start_at, end_at, status, doctors(name), services(name)")
    .eq("clinic_id", clinicId)
    .in("patient_id", ids)
    .in("status", [...ACTIVE_STATUSES])
    .gte("end_at", new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
    .order("start_at", { ascending: true })
    .limit(20);
  if (error) {
    logger.error("upcoming appointments: load failed", { code: error.code });
    throw error;
  }
  type Row = { id: string; start_at: string; end_at: string; status: string; doctors: { name: string } | null; services: { name: string } | null };
  return ((data ?? []) as unknown as Row[])
    .filter((a) => isUpcoming(a))
    .slice(0, limit)
    .map((a) => ({ id: a.id, start_at: a.start_at, end_at: a.end_at, status: a.status, doctorName: a.doctors?.name ?? null, serviceName: a.services?.name ?? null }));
}

/** The bot's chat reply listing the patient's upcoming visits. */
export function upcomingAppointmentsText(items: UpcomingAppointment[], timeZone: string): string {
  if (items.length === 0) {
    return "📋 Sizda hozircha rejalashtirilgan qabul yo‘q.\n\nQabulga yozilish uchun “📅 Qabulga yozilish” tugmasini bosing.";
  }
  const lines = items.map((a) => {
    const st = patientStatus(a.status);
    const who = [a.doctorName, a.serviceName].filter(Boolean).join(" — ");
    return `${st.emoji} ${formatClinicDateTime(a.start_at, timeZone)}${who ? `\n${who}` : ""}\nHolati: ${st.label}`;
  });
  return `📋 Mening qabullarim\n\n${lines.join("\n\n")}\n\nBatafsil ko‘rish va bekor qilish uchun quyidagi tugmani bosing.`;
}

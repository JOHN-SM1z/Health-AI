/**
 * How an appointment is shown to the patient — shared by the Mini App's
 * "Mening qabullarim" page and the bot's "📋 Mening qabullarim" reply so both
 * always say the same thing. Pure and client-safe (no server imports).
 */

export type PatientStatusTone = "green" | "red" | "amber" | "blue" | "gray";

export const PATIENT_STATUS: Record<string, { label: string; hint: string; tone: PatientStatusTone; emoji: string }> = {
  pending: { label: "Tasdiq kutilmoqda", hint: "Klinika qabulingizni tez orada tasdiqlaydi.", tone: "amber", emoji: "🕓" },
  confirmed: { label: "Tasdiqlangan", hint: "Belgilangan vaqtda klinikaga keling.", tone: "blue", emoji: "✅" },
  checked_in: { label: "Klinikadasiz", hint: "Kelganingiz qayd etildi — navbatingizni kuting.", tone: "blue", emoji: "🏥" },
  in_progress: { label: "Qabulda", hint: "Shifokor sizni qabul qilmoqda.", tone: "green", emoji: "👨‍⚕️" },
  completed: { label: "Yakunlangan", hint: "Qabul yakunlandi.", tone: "green", emoji: "✔️" },
  cancelled: { label: "Bekor qilingan", hint: "Bu qabul bekor qilingan.", tone: "red", emoji: "❌" },
  no_show: { label: "Kelmagan", hint: "Bu qabulga kelmaganingiz qayd etilgan.", tone: "gray", emoji: "⚪" },
};

export function patientStatus(status: string) {
  return PATIENT_STATUS[status] ?? { label: status, hint: "", tone: "gray" as const, emoji: "•" };
}

/** Statuses that still lie ahead of (or are happening to) the patient. */
export const ACTIVE_STATUSES = ["pending", "confirmed", "checked_in", "in_progress"] as const;

/** A visit is in progress or underway at the clinic right now. */
const AT_CLINIC = new Set(["checked_in", "in_progress"]);

/**
 * Upcoming = an active status whose visit has not long ended. A visit the
 * patient is at right now stays upcoming whatever the clock says; a pending or
 * confirmed visit that ended more than two hours ago is shown as past.
 */
export function isUpcoming(a: { status: string; end_at: string }, now: Date = new Date()): boolean {
  if (!(ACTIVE_STATUSES as readonly string[]).includes(a.status)) return false;
  if (AT_CLINIC.has(a.status)) return true;
  return new Date(a.end_at).getTime() > now.getTime() - 2 * 60 * 60 * 1000;
}

const UZ_MONTHS = ["yanvar", "fevral", "mart", "aprel", "may", "iyun", "iyul", "avgust", "sentabr", "oktabr", "noyabr", "dekabr"];

/** "20-oktabr, 15:15" in the clinic's time zone (not the phone's). */
export function formatClinicDateTime(iso: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    day: "numeric",
    month: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date(iso));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const month = UZ_MONTHS[Number(get("month")) - 1] ?? get("month");
  return `${Number(get("day"))}-${month}, ${get("hour")}:${get("minute")}`;
}

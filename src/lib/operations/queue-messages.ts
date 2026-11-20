/**
 * The patient-facing queue messages in Telegram — the digital ticket, "you
 * are called" and the on-demand status — shared by the notification worker
 * and the bot. A queue number is arrival order, never an appointment time.
 * No patient name appears: a follower of a visit (a Telegram user who scanned
 * that visit's QR at the kassa) sees the number and the queue only.
 */

export type QueuePlace = { queueNumber: number; lab: boolean; doctorName: string | null };

/** The bot's callback button: "where is my number now?" */
export const QUEUE_STATUS_CALLBACK = "queue_status";
export const queueStatusButton = { text: "🔄 Navbatim", callback_data: QUEUE_STATUS_CALLBACK };

const place = (p: QueuePlace) => (p.lab ? "🧪 Laboratoriya (tahlil topshirish)" : `👨‍⚕️ Shifokor: ${p.doctorName ?? "Shifokor"}`);

export function queueTicketText(p: QueuePlace & { ahead: number }): string {
  return (
    `🎫 Navbat raqamingiz: ${p.queueNumber}\n\n` +
    `${place(p)}\n` +
    `👥 Sizdan oldin: ${p.ahead} bemor\n\n` +
    `Bu kelish tartibi, aniq qabul vaqti emas. Navbatingiz kelganda chaqirasiz.`
  );
}

/**
 * Paid online (20261008000012): the number is issued now; at the clinic the doctor sees booked patients in the order
 * of their booked times. The patient tells reception they have arrived.
 */
export function bookedTicketText(p: { queueNumber: number; doctorName: string | null; startAt: string | null; timezone: string }): string {
  const when = p.startAt
    ? new Date(p.startAt).toLocaleString("uz-UZ", { timeZone: p.timezone, day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" })
    : null;
  return (
    `✅ To‘lov qabul qilindi.\n\n🎫 Navbat raqamingiz: ${p.queueNumber}\n` +
    `👨‍⚕️ Shifokor: ${p.doctorName ?? "Shifokor"}\n` +
    (when ? `🕘 Qabul vaqti: ${when}\n` : "") +
    `\nKlinikaga kelganingizda qabulxonaga navbat raqamingizni ayting.`
  );
}

export function queueCalledText(p: QueuePlace): string {
  return `📣 Navbatingiz keldi — № ${p.queueNumber}\n\n` + (p.lab ? "🧪 Laboratoriyaga kiring." : `👨‍⚕️ ${p.doctorName ?? "Shifokor"} qabuliga kiring.`);
}

const STATUS: Record<string, string> = {
  awaiting_payment: "kassada to‘lov kutilmoqda",
  waiting: "navbatda",
  called: "chaqirildingiz — kiring",
  in_progress: "qabulda",
};

export type QueueLine = { queueNumber: number | null; status: string; label: string; ahead: number | null };

/** The answer to "🔄 Navbatim": every unfinished visit this Telegram user follows or owns. */
export function queueStatusText(lines: QueueLine[]): string {
  if (lines.length === 0) return "Hozir kuzatilayotgan navbatingiz yo‘q. Kassadagi QR kodni skanerlang.";
  return lines
    .map((l) => {
      const head = l.queueNumber === null ? "Navbat raqami to‘lovdan keyin beriladi" : `№ ${l.queueNumber}`;
      const ahead = l.ahead !== null && l.status === "waiting" ? ` · oldingizda ${l.ahead} bemor` : "";
      return `${head} — ${l.label}: ${STATUS[l.status] ?? l.status}${ahead}`;
    })
    .join("\n");
}

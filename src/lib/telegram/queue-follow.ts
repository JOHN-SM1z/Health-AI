import "server-only";
import { sendTelegramMessage } from "@/lib/telegram/bot";
import { rateLimit } from "@/lib/rate-limit";
import { logger } from "@/lib/logger";
import { claimVisitFollow, telegramQueuePositions } from "@/lib/operations/outpatient";
import { queueStatusButton, queueStatusText, queueTicketText } from "@/lib/operations/queue-messages";

/**
 * Following a walk-in visit's queue from the QR shown at the kassa (owner,
 * 2026-10-08): `/start v_<token>` makes this Telegram user a follower of that
 * one visit — the ticket now, "you are called" later. It links no identity:
 * no patient card is created, matched or merged, and nothing but the queue is
 * shown. Every failure gets the same neutral answer.
 */

const NEUTRAL = "Bu havola yaroqsiz yoki muddati o‘tgan. Kassadan yangi QR kod so‘rang.";
const statusKeyboard = { inline_keyboard: [[queueStatusButton]] };

export async function handleQueueFollowStart(opts: { clinicId: string; chatId: number; telegramUserId: number; token: string }): Promise<void> {
  const limit = rateLimit({ key: `tg-follow:${opts.clinicId}:${opts.telegramUserId}`, limit: 10, windowMs: 10 * 60_000 });
  if (!limit.ok) {
    await sendTelegramMessage({ chatId: opts.chatId, text: "Urinishlar juda ko‘p. Birozdan so‘ng qayta urinib ko‘ring." }, opts.clinicId);
    return;
  }
  const claim = await claimVisitFollow(opts.clinicId, opts.token, opts.telegramUserId);
  if (claim.status === "invalid") {
    await sendTelegramMessage({ chatId: opts.chatId, text: NEUTRAL }, opts.clinicId);
    return;
  }
  const mine = (await telegramQueuePositions(opts.clinicId, opts.telegramUserId)).find((p) => p.visitId === claim.visitId);
  if (!mine) {
    await sendTelegramMessage({ chatId: opts.chatId, text: "Bu tashrif yakunlangan." }, opts.clinicId);
    return;
  }
  const text =
    mine.queueNumber === null
      ? "✅ Navbatingizni kuzatyapsiz. Navbat raqami kassada to‘lovdan keyin beriladi — «🔄 Navbatim» tugmasini bosib tekshiring."
      : mine.status === "called"
        ? `📣 Navbatingiz keldi — № ${mine.queueNumber}. ${mine.kind === "lab" ? "Laboratoriyaga" : `${mine.doctorName} qabuliga`} kiring.`
        : `${queueTicketText({ queueNumber: mine.queueNumber, lab: mine.kind === "lab", doctorName: mine.doctorName, ahead: mine.ahead ?? 0 })}\n\n` +
          "Chaqirilganingizda shu yerga xabar keladi.";
  const sent = await sendTelegramMessage({ chatId: opts.chatId, text, replyMarkup: statusKeyboard }, opts.clinicId);
  if (sent === null) logger.warn("queue follow: ticket reply not delivered", { clinicId: opts.clinicId });
}

/** "🔄 Navbatim": the live position of every unfinished visit this Telegram user follows or owns. */
export async function handleQueueStatus(opts: { clinicId: string; chatId: number; telegramUserId: number }): Promise<void> {
  const positions = await telegramQueuePositions(opts.clinicId, opts.telegramUserId);
  const text = queueStatusText(positions.map((p) => ({ queueNumber: p.queueNumber, status: p.status, label: p.doctorName, ahead: p.ahead })));
  await sendTelegramMessage({ chatId: opts.chatId, text, replyMarkup: positions.length > 0 ? statusKeyboard : undefined }, opts.clinicId);
}

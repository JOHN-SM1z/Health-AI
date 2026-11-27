import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { logger } from "@/lib/logger";
import { sendTelegramMessage, type TelegramMessagePayload } from "@/lib/telegram/bot";
import { finishNotificationClaim, renewNotificationClaim, type WorkerOutcome } from "@/lib/notifications/claims";
import { formatInClinicTz } from "@/lib/timezone";
import type { Database } from "@/lib/supabase/database.types";
import { resolveHttpsAppUrl } from "@/lib/telegram/bots";
// The one approved gateway from patient-facing code to lab results (Phase 12).
import { loadLabOrderNotice, loadLabResultNotice } from "@/lib/labs/patient-results";
import { bookedTicketText, queueCalledText, queueStatusButton, queueTicketText } from "@/lib/operations/queue-messages";
import { staleAppointmentMessage } from "@/lib/notifications/staleness";


const MESSAGE_TEMPLATES: Record<
  Database["public"]["Enums"]["notification_job_type"],
  (ctx: AppointmentContext, timezone: string) => string
> = {
  booking_confirmation: (a, tz) =>
    `✅ Qabul tasdiqlandi!\n\n` +
    `👨‍⚕️ Shifokor: ${a.doctorName}\n` +
    `🏥 Xizmat: ${a.serviceName}\n` +
    `📅 Sana: ${formatInClinicTz(a.startAt, tz, "dd.MM.yyyy")}\n` +
    `🕐 Vaqt: ${formatInClinicTz(a.startAt, tz, "HH:mm")}\n` +
    `💰 Narx: ${formatPrice(a.amount, a.currency)}\n\n` +
    `Qabuldan 24 soat va 2 soat oldin eslatib boramiz. Bekor qilish yoki o‘zgartirish uchun “Qabulga yozilish” bo‘limiga murojaat qiling.`,
  reminder_24h: (a, tz) =>
    `⏰ Eslatma: qabulingiz 24 soatdan so‘ng.\n\n` +
    `👨‍⚕️ ${a.doctorName} — ${a.serviceName}\n` +
    `📅 ${formatInClinicTz(a.startAt, tz, "dd.MM.yyyy, HH:mm")}\n\n` +
    `Vaqtni o‘zgartirish yoki bekor qilish kerak bo‘lsa, operatorlarimizga murojaat qiling.`,
  reminder_2h: (a, tz) =>
    `⏰ Eslatma: qabulingiz 2 soatdan so‘ng.\n\n` +
    `👨‍⚕️ ${a.doctorName} — ${a.serviceName}\n` +
    `📅 ${formatInClinicTz(a.startAt, tz, "dd.MM.yyyy, HH:mm")}`,
  cancellation: (a, tz) =>
    `Qabulingiz bekor qilindi.\n\n` +
    `👨‍⚕️ ${a.doctorName} — ${a.serviceName}\n` +
    `📅 ${formatInClinicTz(a.startAt, tz, "dd.MM.yyyy, HH:mm")}\n\n` +
    `Yangi vaqtga yozilish uchun “Qabulga yozilish” tugmasini bosing.`,
  reschedule: (a, tz) =>
    `Qabul vaqti o‘zgartirildi.\n\n` +
    `👨‍⚕️ ${a.doctorName} — ${a.serviceName}\n` +
    `📅 Yangi vaqt: ${formatInClinicTz(a.startAt, tz, "dd.MM.yyyy, HH:mm")}`,
  human_takeover: () =>
    `Operatorlarimiz siz bilan bog‘lanadi. Biroz kuting.`,
  // Lab jobs carry no appointment: lab_result_ready and lab_order_cancelled
  // are built by their own functions below; the other lab events are in-app
  // staff notifications (channel in_app) the Telegram worker never claims.
  lab_result_ready: () => "",
  lab_order_cancelled: () => "",
  lab_order_created: () => "",
  lab_sample_collected: () => "",
  lab_result_entered: () => "",
  lab_result_verified: () => "",
  lab_result_corrected: () => "",
  // Built by processQueueTicketJob from the visit, not an appointment.
  queue_ticket: () => "",
  // Built by processQueueCalledJob from the visit.
  queue_called: () => "",
};

type AppointmentContext = {
  doctorName: string;
  serviceName: string;
  startAt: string;
  status: Database["public"]["Enums"]["appointment_status"];
  amount: number;
  currency: string;
};

function formatPrice(amount: number, currency: string): string {
  return `${new Intl.NumberFormat("uz-UZ").format(amount)} ${currency}`;
}

async function loadAppointmentContext(supabase: ReturnType<typeof createAdminClient>, clinicId: string, appointmentId: string) {
  const { data, error } = await supabase
    .from("appointments")
    .select("start_at, status, doctors!inner(name), services!inner(name), payments!inner(amount, currency)")
    .eq("id", appointmentId)
    .eq("clinic_id", clinicId)
    .maybeSingle();
  if (error) throw new Error("appointment context unavailable");
  if (!data) return null;
  return {
    doctorName: data.doctors?.name ?? "Shifokor",
    serviceName: data.services?.name ?? "Xizmat",
    startAt: data.start_at,
    status: data.status,
    amount: data.payments?.amount ?? 0,
    currency: data.payments?.currency ?? "UZS",
  } satisfies AppointmentContext;
}

/**
 * Processes due notification jobs.
 * - `claim_due_notification_jobs` atomically claims due rows with
 *   `FOR UPDATE SKIP LOCKED` and moves them to `in_progress`, so concurrent
 *   cron invocations can never both send the same job.
 * - Every send renews its token/clinic-bound lease against the database clock.
 *   Every outcome is finalized with that claim; stale workers cannot overwrite it.
 * - Idempotency keys prevent enqueue-time duplicates.
 * - Automated messages pause while the conversation is taken over by an
 *   admin (conversation.status = 'assigned').
 */
export async function processDueNotificationJobs(
  limit = 50,
  /** Only these clinics' jobs (default: every clinic — the scheduler's run). */
  clinicIds?: string[],
): Promise<{ processed: number; sent: number; failed: number }> {
  const supabase = createAdminClient();
  // No global gate here: bots are per-clinic (clinic_telegram_integrations),
  // not a single shared credential, so "Telegram" can never be globally
  // on/off. sendTelegramMessage() already resolves the bot for each job's
  // own clinic_id and returns null gracefully when THAT clinic has none
  // configured — which the loop below already treats as a retryable send
  // failure. A prior version gated the whole function behind the legacy
  // global TELEGRAM_BOT_TOKEN (telegramConfigured()), which silently
  // skipped every reminder/confirmation for every clinic whenever that
  // unrelated legacy var was unset — including clinics with a fully active
  // bot of their own.

  const { data: jobs, error: claimError } = await supabase.rpc("claim_due_notification_jobs", {
    p_limit: limit,
    ...(clinicIds ? { p_clinic_ids: clinicIds } : {}),
  });
  if (claimError) {
    logger.error("notification processor: claim failed", { code: claimError.code });
    return { processed: 0, sent: 0, failed: 0 };
  }
  if (!jobs || jobs.length === 0) return { processed: 0, sent: 0, failed: 0 };

  let sent = 0;
  let failed = 0;

  for (const job of jobs) {
    const jobId = job.id;
    const nextAttempts = job.attempts + 1;

    // Preparation failures can retry. Once provider I/O starts, an uncertain
    // result is quarantined and never automatically resent.
    try {
      // Pause automated messages while an admin holds the conversation.
      if (job.conversation_id) {
        const { data: conv, error: conversationError } = await supabase
          .from("conversations")
          .select("status")
          .eq("id", job.conversation_id)
          .eq("clinic_id", job.clinic_id)
          .maybeSingle();
        if (conversationError || !conv) throw new Error("conversation state unavailable");
        if (conv && conv.status === "assigned") {
          // Defer: mark skipped so an admin can retry after release.
          await markJob(job, "skipped", "conversation held by admin", supabase);
          continue;
        }
      }

      if (!job.patient_telegram_user_id) {
        await markJob(job, "failed", "no telegram recipient", supabase);
        failed += 1;
        continue;
      }

      if (job.type === "queue_ticket" || job.type === "queue_called") {
        const outcome = job.type === "queue_ticket" ? await processQueueTicketJob(supabase, job) : await processQueueCalledJob(supabase, job);
        if (outcome === "sent") sent += 1;
        else if (outcome === "failed") failed += 1;
        continue;
      }

      if (job.type === "lab_result_ready" || job.type === "lab_order_cancelled") {
        const outcome = job.type === "lab_result_ready" ? await processLabResultJob(supabase, job) : await processLabOrderCancelledJob(supabase, job);
        if (outcome === "sent") sent += 1;
        else if (outcome === "failed") failed += 1;
        continue;
      }

      if (job.appointment_id) {
        const ctx = await loadAppointmentContext(supabase, job.clinic_id, job.appointment_id);
        if (!ctx) {
          await markJob(job, "skipped", "appointment gone", supabase);
          continue;
        }

        // If the appointment was cancelled or closed, skip sending reminders.
        if (
          (job.type === "reminder_24h" || job.type === "reminder_2h") &&
          ["cancelled", "no_show", "completed"].includes(ctx.status)
        ) {
          await markJob(job, "skipped", `appointment is ${ctx.status}`, supabase);
          continue;
        }
        // A backlog (scheduler down, bot not connected) never reaches the patient late.
        const stale = staleAppointmentMessage(job.type, job.scheduled_for, ctx.startAt);
        if (stale) {
          await markJob(job, "skipped", stale, supabase);
          continue;
        }
        const { data: clinic } = await supabase
          .from("clinics")
          .select("timezone")
          .eq("id", job.clinic_id)
          .maybeSingle();

        const text = MESSAGE_TEMPLATES[job.type](ctx, clinic?.timezone ?? "Asia/Tashkent");
        // A web_app button, so the app opens inside Telegram with initData (identity first);
        // a plain link would open a browser without it. HTTPS only — Telegram rejects anything else.
        const bookUrl = resolveHttpsAppUrl(`/book?clinic=${encodeURIComponent(job.clinic_id)}`);
        const messageId = await sendClaimedTelegramMessage(supabase, job,
          {
            chatId: job.patient_telegram_user_id,
            text,
            replyMarkup: {
              // Each row is an array of buttons.
              inline_keyboard: [
                ...(bookUrl ? [[{ text: "📅 Qabulga yozilish", web_app: { url: bookUrl } }]] : []),
                [{ text: "👤 Operator bilan bog‘lanish", callback_data: "contact_operator" }],
              ],
            },
          }
        );

        if (await finishNotificationClaim(supabase, job, "sent", null, messageId)) sent += 1;
        else failed += 1;
      } else {
        await markJob(job, "skipped", "job has no appointment", supabase);
      }
    } catch (e) {
      if (e instanceof NotificationClaimLost) {
        logger.warn("notification claim no longer owned", { jobId });
        failed += 1;
        continue;
      }
      if (e instanceof NotificationDeliveryUnknown) {
        await markJob(job, "quarantined", "delivery outcome unknown; review before resending", supabase);
        failed += 1;
        continue;
      }
      // No provider I/O started: a bounded retry is safe. Provider failures
      // are caught above and are never automatically replayed.
      logger.error("notification preparation failed", { jobId });
      if (nextAttempts >= (job.max_attempts ?? 3)) {
        await markJob(job, "failed", "processing error after retries", supabase);
        failed += 1;
      } else {
        await markJob(job, "pending", "processing error, retrying", supabase);
      }
    }
  }

  logger.info("notification jobs processed", { processed: jobs.length, sent, failed });
  return { processed: jobs.length, sent, failed };
}

type ClaimedJob = Database["public"]["Tables"]["notification_jobs"]["Row"];

/**
 * "Your laboratory result is ready" (Phase 12). Sent only while the result is
 * still the current verified version, the clinic still releases results to
 * patients and the recipient is still the patient's Telegram identity. The
 * message names the test and the date — never values; the button opens the
 * result in the Mini App, where the patient's identity is verified again.
 */
async function processLabResultJob(
  supabase: ReturnType<typeof createAdminClient>,
  job: ClaimedJob,
): Promise<"sent" | "failed" | "skipped" | "retry"> {
  const notice = await loadLabResultNotice(job.clinic_id, job.lab_result_id ?? "");
  if (!notice || !notice.current) {
    await markJob(job, "skipped", "result no longer current", supabase);
    return "skipped";
  }
  if (!notice.released) {
    await markJob(job, "skipped", "results not released to patients", supabase);
    return "skipped";
  }
  if (!job.patient_telegram_user_id || notice.telegramUserId === null || Number(notice.telegramUserId) !== Number(job.patient_telegram_user_id)) {
    await markJob(job, "skipped", "recipient changed", supabase);
    return "skipped";
  }
  const { data: clinic } = await supabase.from("clinics").select("timezone").eq("id", job.clinic_id).maybeSingle();
  const date = formatInClinicTz(notice.date, clinic?.timezone ?? "Asia/Tashkent", "dd.MM.yyyy");
  // A notification preview can be read on a locked screen: no test name, no
  // values (Phase 16) — the app shows the result after verifying the patient.
  const text =
    (notice.corrected ? `🧪 Laboratoriya natijangiz yangilandi (tuzatilgan).\n\n` : `🧪 Laboratoriya natijangiz tayyor.\n\n`) +
    `Sana: ${date}\n\n` +
    `Natijani ilovada ko‘rishingiz mumkin — Telegram hisobingiz tasdiqlangandan keyin.`;
  const url = labResultUrl(job.clinic_id, notice.itemId);
  const messageId = await sendClaimedTelegramMessage(supabase, job,
    {
      chatId: job.patient_telegram_user_id,
      text,
      replyMarkup: url ? { inline_keyboard: [[url.webApp ? { text: "📄 Natijani ko‘rish", web_app: { url: url.href } } : { text: "📄 Natijani ko‘rish", url: url.href }]] } : undefined,
    }
  );
  return (await finishNotificationClaim(supabase, job, "sent", null, messageId)) ? "sent" : "failed";
}

/**
 * "Your laboratory order was cancelled" (Phase 16) — only when the clinic
 * enables it. Sent only while the order is still cancelled and the recipient
 * is still the patient's Telegram identity; no test names.
 */
async function processLabOrderCancelledJob(
  supabase: ReturnType<typeof createAdminClient>,
  job: ClaimedJob,
): Promise<"sent" | "failed" | "skipped" | "retry"> {
  const notice = await loadLabOrderNotice(job.clinic_id, job.lab_order_id ?? "");
  if (!notice || notice.status !== "cancelled") {
    await markJob(job, "skipped", "order not cancelled", supabase);
    return "skipped";
  }
  if (!job.patient_telegram_user_id || notice.telegramUserId === null || Number(notice.telegramUserId) !== Number(job.patient_telegram_user_id)) {
    await markJob(job, "skipped", "recipient changed", supabase);
    return "skipped";
  }
  const messageId = await sendClaimedTelegramMessage(supabase, job,
    {
      chatId: job.patient_telegram_user_id,
      text: `Laboratoriya buyurtmangiz bekor qilindi.\n\nSavollaringiz bo‘lsa, klinikaga murojaat qiling.`,
      replyMarkup: { inline_keyboard: [[{ text: "👤 Operator bilan bog‘lanish", callback_data: "contact_operator" }]] },
    }
  );
  return (await finishNotificationClaim(supabase, job, "sent", null, messageId)) ? "sent" : "failed";
}

type QueueVisit = {
  id: string;
  clinic_id: string;
  kind: string;
  status: string;
  queue_date: string | null;
  queue_number: number | null;
  doctor_id: string | null;
  patients: { telegram_user_id: number | null } | null;
  doctors: { name: string } | null;
  appointments: { start_at: string } | null;
  clinics: { timezone: string } | null;
};

async function loadQueueVisit(supabase: ReturnType<typeof createAdminClient>, job: ClaimedJob): Promise<QueueVisit | null> {
  const { data } = await supabase
    .from("visits")
    .select("id, clinic_id, kind, status, queue_date, queue_number, doctor_id, patients!inner(telegram_user_id), doctors(name), appointments(start_at), clinics(timezone)")
    .eq("id", job.visit_id ?? "")
    .eq("clinic_id", job.clinic_id)
    .maybeSingle();
  return (data as QueueVisit | null) ?? null;
}

/**
 * A queue message goes only to the visit's own patient's linked Telegram, or
 * to a Telegram user who follows this visit (scanned its QR at the kassa,
 * 20261008000003). Anyone else — a card re-linked, a follower gone — is skipped.
 */
async function isQueueRecipient(supabase: ReturnType<typeof createAdminClient>, visit: QueueVisit, chat: number | null): Promise<"patient" | "follower" | null> {
  if (!chat) return null;
  const own = visit.patients?.telegram_user_id ?? null;
  if (own !== null && Number(own) === Number(chat)) return "patient";
  const { count } = await supabase
    .from("visit_followers")
    .select("id", { count: "exact", head: true })
    .eq("visit_id", visit.id)
    .eq("clinic_id", visit.clinic_id)
    .eq("telegram_user_id", chat);
  return (count ?? 0) > 0 ? "follower" : null;
}


/**
 * The patient's digital queue ticket (no paper talon). Sent only while the
 * visit is still waiting or called, and only to the visit's own patient's
 * verified Telegram chat. States arrival order, never a time. (A follower
 * gets the ticket from the bot the moment they scan the QR.)
 */
async function processQueueTicketJob(
  supabase: ReturnType<typeof createAdminClient>,
  job: ClaimedJob,
): Promise<"sent" | "failed" | "skipped" | "retry"> {
  const visit = await loadQueueVisit(supabase, job);
  if (!visit || visit.queue_number === null || !["booked", "waiting", "called"].includes(visit.status)) {
    await markJob(job, "skipped", "visit no longer waiting", supabase);
    return "skipped";
  }
  if ((await isQueueRecipient(supabase, visit, job.patient_telegram_user_id)) !== "patient") {
    await markJob(job, "skipped", "recipient changed", supabase);
    return "skipped";
  }
  // Paid online, not yet arrived: the number, the booked time, and what to do at the clinic.
  if (visit.status === "booked") {
    const appUrl = resolveHttpsAppUrl(`/my-appointments?clinic=${encodeURIComponent(job.clinic_id)}`);
    const messageId = await sendClaimedTelegramMessage(supabase, job,
      {
        chatId: job.patient_telegram_user_id!,
        text: bookedTicketText({
          queueNumber: visit.queue_number,
          doctorName: visit.doctors?.name ?? null,
          startAt: visit.appointments?.start_at ?? null,
          timezone: visit.clinics?.timezone ?? "Asia/Tashkent",
        }),
        ...(appUrl ? { replyMarkup: { inline_keyboard: [[{ text: "📋 Yozuvlarim", web_app: { url: appUrl } }]] } } : {}),
      }
    );
    return (await finishNotificationClaim(supabase, job, "sent", null, messageId)) ? "sent" : "failed";
  }
  // The same queue: this doctor's, or the laboratory's.
  let aheadQuery = supabase
    .from("visits")
    .select("id", { count: "exact", head: true })
    .eq("clinic_id", visit.clinic_id)
    .in("status", ["waiting", "called"]);
  aheadQuery = visit.doctor_id ? aheadQuery.eq("doctor_id", visit.doctor_id) : aheadQuery.eq("kind", "lab");
  const { count: ahead } = await aheadQuery
    .or(`queue_date.lt.${visit.queue_date},and(queue_date.eq.${visit.queue_date},queue_number.lt.${visit.queue_number})`);
  const appUrl = resolveHttpsAppUrl(`/my-appointments?clinic=${encodeURIComponent(job.clinic_id)}`);
  const messageId = await sendClaimedTelegramMessage(supabase, job,
    {
      chatId: job.patient_telegram_user_id!,
      text: queueTicketText({ queueNumber: visit.queue_number, lab: visit.kind === "lab", doctorName: visit.doctors?.name ?? null, ahead: ahead ?? 0 }),
      ...(appUrl ? { replyMarkup: { inline_keyboard: [[{ text: "📋 Navbatni kuzatish", web_app: { url: appUrl } }]] } } : {}),
    }
  );
  return (await finishNotificationClaim(supabase, job, "sent", null, messageId)) ? "sent" : "failed";
}

/**
 * "You are called" (20261008000003): to the patient's linked Telegram and to
 * the visit's followers. Sent only while the number is still being called —
 * once the patient is in, or was sent back to the queue, it is stale.
 */
async function processQueueCalledJob(
  supabase: ReturnType<typeof createAdminClient>,
  job: ClaimedJob,
): Promise<"sent" | "failed" | "skipped" | "retry"> {
  const visit = await loadQueueVisit(supabase, job);
  if (!visit || visit.queue_number === null || visit.status !== "called") {
    await markJob(job, "skipped", "visit no longer called", supabase);
    return "skipped";
  }
  if (!(await isQueueRecipient(supabase, visit, job.patient_telegram_user_id))) {
    await markJob(job, "skipped", "recipient changed", supabase);
    return "skipped";
  }
  const messageId = await sendClaimedTelegramMessage(supabase, job,
    {
      chatId: job.patient_telegram_user_id!,
      text: queueCalledText({ queueNumber: visit.queue_number, lab: visit.kind === "lab", doctorName: visit.doctors?.name ?? null }),
      replyMarkup: { inline_keyboard: [[queueStatusButton]] },
    }
  );
  return (await finishNotificationClaim(supabase, job, "sent", null, messageId)) ? "sent" : "failed";
}

/**
 * The Mini App page of one result: a web_app button to an HTTPS app URL
 * (opens inside Telegram with verified initData), or — when the app is only
 * reachable as a t.me Mini App link — that link with startapp=lab_<item id>.
 */
export function labResultUrl(clinicId: string, itemId: string): { href: string; webApp: boolean } | null {
  const https = resolveHttpsAppUrl(`/lab-results/${itemId}?clinic=${encodeURIComponent(clinicId)}`);
  if (https) return { href: https, webApp: true };
  const base = process.env.NEXT_PUBLIC_APP_URL?.trim() ?? "";
  if (base.startsWith("https://t.me/")) {
    const url = new URL(base);
    url.searchParams.set("startapp", `lab_${itemId}`);
    return { href: url.toString(), webApp: false };
  }
  return null;
}

class NotificationClaimLost extends Error {}
class NotificationDeliveryUnknown extends Error {}

/** A NULL/throw from the legacy sender cannot distinguish rejection from a
 * provider timeout after acceptance. Quarantine it rather than risk a replay. */
async function sendClaimedTelegramMessage(
  supabase: ReturnType<typeof createAdminClient>,
  job: ClaimedJob,
  payload: TelegramMessagePayload,
): Promise<number> {
  if (!(await renewNotificationClaim(supabase, job))) throw new NotificationClaimLost();
  try {
    const id = await sendTelegramMessage(payload, job.clinic_id);
    if (id === null) throw new NotificationDeliveryUnknown();
    return id;
  } catch {
    throw new NotificationDeliveryUnknown();
  }
}

async function markJob(
  job: ClaimedJob,
  status: WorkerOutcome,
  errorCode: string,
  supabase: ReturnType<typeof createAdminClient>,
) {
  return finishNotificationClaim(supabase, job, status, errorCode);
}

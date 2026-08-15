import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { logger } from "@/lib/logger";
import { sendTelegramMessage, telegramConfigured } from "@/lib/telegram/bot";
import { formatInClinicTz } from "@/lib/timezone";
import type { Database } from "@/lib/supabase/database.types";


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

async function loadAppointmentContext(supabase: ReturnType<typeof createAdminClient>, appointmentId: string) {
  const { data } = await supabase
    .from("appointments")
    .select("start_at, status, doctors!inner(name), services!inner(name), payments!inner(amount, currency)")
    .eq("id", appointmentId)
    .maybeSingle();
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
 * - Only the worker that claimed a job may mark it sent, retry, failed, or
 *   skipped; other workers never see its `in_progress` rows.
 * - Idempotency keys prevent enqueue-time duplicates.
 * - Automated messages pause while the conversation is taken over by an
 *   admin (conversation.status = 'assigned').
 */
export async function processDueNotificationJobs(limit = 50): Promise<{ processed: number; sent: number; failed: number }> {
  const supabase = createAdminClient();
  if (!telegramConfigured()) {
    logger.warn("notification processor: telegram not configured, skipping");
    return { processed: 0, sent: 0, failed: 0 };
  }

  const { data: jobs, error: claimError } = await supabase.rpc("claim_due_notification_jobs", {
    p_limit: limit,
  });
  if (claimError) {
    logger.error("notification processor: claim failed", { error: claimError.message });
    return { processed: 0, sent: 0, failed: 0 };
  }
  if (!jobs || jobs.length === 0) return { processed: 0, sent: 0, failed: 0 };

  let sent = 0;
  let failed = 0;

  for (const job of jobs) {
    const jobId = job.id;
    const nextAttempts = job.attempts + 1;

    // Any unexpected failure must RELEASE the claim so the next run retries
    // it. Otherwise the job stays 'in_progress' forever and is never picked
    // up again (claim_due_notification_jobs only claims 'pending' rows).
    try {
      // Pause automated messages while an admin holds the conversation.
      if (job.conversation_id) {
        const { data: conv } = await supabase
          .from("conversations")
          .select("status")
          .eq("id", job.conversation_id)
          .maybeSingle();
        if (conv && conv.status === "assigned") {
          // Defer: mark skipped so an admin can retry after release.
          await markJob(jobId, "skipped", nextAttempts, "conversation held by admin", supabase);
          continue;
        }
      }

      if (!job.patient_telegram_user_id) {
        await markJob(jobId, "failed", nextAttempts, "no telegram recipient", supabase);
        failed += 1;
        continue;
      }

      if (job.appointment_id) {
        const ctx = await loadAppointmentContext(supabase, job.appointment_id);
        if (!ctx) {
          await markJob(jobId, "skipped", nextAttempts, "appointment gone", supabase);
          continue;
        }

        // If the appointment was cancelled or closed, skip sending reminders.
        if (
          (job.type === "reminder_24h" || job.type === "reminder_2h") &&
          ["cancelled", "no_show", "completed"].includes(ctx.status)
        ) {
          await markJob(jobId, "skipped", nextAttempts, `appointment is ${ctx.status}`, supabase);
          continue;
        }
        const { data: clinic } = await supabase
          .from("clinics")
          .select("timezone")
          .eq("id", job.clinic_id)
          .maybeSingle();

        const text = MESSAGE_TEMPLATES[job.type](ctx, clinic?.timezone ?? "Asia/Tashkent");
        const messageId = await sendTelegramMessage({
          chatId: job.patient_telegram_user_id,
          text,
          replyMarkup: {
            inline_keyboard: [
              [{ text: "📅 Qabulga yozilish", url: miniAppUrl() }],
              [{ text: "👤 Operator bilan bog‘lanish", callback_data: "contact_operator" }],
            ],
          },
        });

        if (messageId !== null) {
          sent += 1;
          // The message was already delivered. If recording it fails we
          // must NOT release the job for retry — that would send the same
          // message to the patient a second time.
          try {
            await supabase
              .from("notification_jobs")
              .update({ status: "sent", sent_at: new Date().toISOString(), telegram_message_id: messageId, attempts: nextAttempts })
              .eq("id", jobId);
          } catch (e) {
            logger.error("notification sent but not recorded", {
              jobId,
              error: e instanceof Error ? e.message : String(e),
            });
            await markJob(jobId, "failed", nextAttempts, "sent but not recorded", supabase);
            failed += 1;
          }
        } else if (nextAttempts >= (job.max_attempts ?? 3)) {
          await markJob(jobId, "failed", nextAttempts, "send failed after retries", supabase);
          failed += 1;
        } else {
          await markJob(jobId, "pending", nextAttempts, "send failed, retrying", supabase);
        }
      } else {
        await markJob(jobId, "skipped", nextAttempts, "job has no appointment", supabase);
      }
    } catch (e) {
      // Release the claim so the next run retries. After max attempts the
      // job is failed so it stops consuming worker time.
      logger.error("notification job processing failed, releasing claim", {
        jobId,
        error: e instanceof Error ? e.message : String(e),
      });
      if (nextAttempts >= (job.max_attempts ?? 3)) {
        await markJob(jobId, "failed", nextAttempts, "processing error after retries", supabase);
        failed += 1;
      } else {
        await markJob(jobId, "pending", nextAttempts, "processing error, retrying", supabase);
      }
    }
  }

  logger.info("notification jobs processed", { processed: jobs.length, sent, failed });
  return { processed: jobs.length, sent, failed };
}

function miniAppUrl(): string {
  const base = process.env.NEXT_PUBLIC_APP_URL ?? "";
  if (base.startsWith("https://t.me/") || base.startsWith("https://t.me")) {
    // Telegram deep link form when the app is hosted on t.me
    return base;
  }
  return `${base}/book`;
}

async function markJob(
  jobId: string,
  status: Database["public"]["Enums"]["notification_job_status"],
  attempts: number,
  error: string,
  supabase: ReturnType<typeof createAdminClient>,
) {
  try {
    await supabase.from("notification_jobs").update({ status, attempts, error }).eq("id", jobId);
  } catch (e) {
    // Never let a failed bookkeeping write crash the whole batch.
    logger.error("failed to update notification job", {
      jobId,
      status,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}
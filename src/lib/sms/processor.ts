import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { logger } from "@/lib/logger";
import { activeSmsProvider } from "@/lib/sms/provider";
import { queueCalledSms, queueTicketSms } from "@/lib/sms/templates";
import { uzPhoneKey } from "@/lib/patients/online-identity";

type SmsJob = { id: string; clinic_id: string; visit_id: string | null; type: string; recipient_patient_id: string | null; attempts: number; max_attempts: number | null };

async function finish(id: string, status: "sent" | "failed" | "skipped" | "pending", attempts: number, error: string | null) {
  await createAdminClient()
    .from("notification_jobs")
    .update({
      status,
      attempts,
      error,
      ...(status === "sent" ? { sent_at: new Date().toISOString() } : {}),
      ...(status === "pending" ? { scheduled_for: new Date(Date.now() + 60_000).toISOString() } : {}),
    })
    .eq("id", id);
}

/**
 * Sends due queue SMS (20261008000013). Each job is claimed atomically (claim_due_sms_jobs, FOR UPDATE SKIP LOCKED),
 * so concurrent workers never send the same SMS. Every condition is checked again at send time — the patient may have
 * linked Telegram, withdrawn consent, or the visit moved on. "sent" means the provider accepted the message; the
 * delivery report updates sms_messages later. No phone number or text is logged or stored.
 */
export async function processDueSmsJobs(limit = 50, clinicIds?: string[]): Promise<{ processed: number; sent: number; failed: number; skipped: number }> {
  const db = createAdminClient();
  const { data, error } = await db.rpc("claim_due_sms_jobs", { p_limit: limit, ...(clinicIds ? { p_clinic_ids: clinicIds } : {}) });
  if (error) {
    logger.error("sms jobs could not be claimed", { code: error.code });
    return { processed: 0, sent: 0, failed: 0, skipped: 0 };
  }
  const jobs = (data ?? []) as unknown as SmsJob[];
  const provider = activeSmsProvider();
  const out = { processed: jobs.length, sent: 0, failed: 0, skipped: 0 };

  for (const job of jobs) {
    const attempts = job.attempts + 1;
    if (!provider) {
      await finish(job.id, "skipped", attempts, "sms provider not configured");
      out.skipped++;
      continue;
    }
    const [{ data: visit }, { data: patient }, { data: clinic }] = await Promise.all([
      db.from("visits").select("status, queue_number").eq("id", job.visit_id ?? "").eq("clinic_id", job.clinic_id).maybeSingle(),
      db.from("patients").select("phone, telegram_user_id, sms_consent_at").eq("id", job.recipient_patient_id ?? "").eq("clinic_id", job.clinic_id).maybeSingle(),
      db.from("clinics").select("name, sms_enabled").eq("id", job.clinic_id).maybeSingle(),
    ]);
    const phoneKey = uzPhoneKey(patient?.phone);
    const stillWanted =
      !!visit && visit.queue_number !== null && !!patient && !!clinic?.sms_enabled && patient.telegram_user_id === null && !!patient.sms_consent_at && !!phoneKey &&
      (job.type === "queue_ticket" ? ["booked", "waiting", "called"].includes(visit.status) : visit.status === "called");
    if (!stillWanted) {
      await finish(job.id, "skipped", attempts, "no longer applicable");
      out.skipped++;
      continue;
    }
    const text = job.type === "queue_called" ? queueCalledSms(clinic!.name, visit!.queue_number!) : queueTicketSms(clinic!.name, visit!.queue_number!);
    const result = await provider.send(`+998${phoneKey}`, text, job.id);
    if (result.accepted) {
      await db.from("sms_messages").insert({ clinic_id: job.clinic_id, job_id: job.id, purpose: job.type, provider: provider.name, provider_message_id: result.providerMessageId });
      await finish(job.id, "sent", attempts, null);
      out.sent++;
    } else if (attempts >= (job.max_attempts ?? 3)) {
      await finish(job.id, "failed", attempts, `sms not accepted: ${result.error}`);
      out.failed++;
    } else {
      await finish(job.id, "pending", attempts, `sms not accepted, retrying: ${result.error}`);
    }
  }
  return out;
}

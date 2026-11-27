import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { logger } from "@/lib/logger";
import { activeSmsProvider } from "@/lib/sms/provider";
import { queueCalledSms, queueTicketSms } from "@/lib/sms/templates";
import { uzPhoneKey } from "@/lib/patients/online-identity";
import { finishNotificationClaim, renewNotificationClaim } from "@/lib/notifications/claims";

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
  const jobs = data ?? [];
  const provider = activeSmsProvider();
  const out = { processed: jobs.length, sent: 0, failed: 0, skipped: 0 };

  for (const job of jobs) {
    const attempts = job.attempts + 1;
    let sending = false;
    try {
      if (!provider) {
        if (await finishNotificationClaim(db, job, "skipped", "sms provider not configured")) out.skipped++;
        else out.failed++;
        continue;
      }
      const [visitResult, patientResult, clinicResult] = await Promise.all([
      db.from("visits").select("status, queue_number").eq("id", job.visit_id ?? "").eq("clinic_id", job.clinic_id).maybeSingle(),
      db.from("patients").select("phone, telegram_user_id, sms_consent_at").eq("id", job.recipient_patient_id ?? "").eq("clinic_id", job.clinic_id).maybeSingle(),
      db.from("clinics").select("name, sms_enabled").eq("id", job.clinic_id).maybeSingle(),
      ]);
      if (visitResult.error || patientResult.error || clinicResult.error) throw new Error("sms context unavailable");
      const visit = visitResult.data;
      const patient = patientResult.data;
      const clinic = clinicResult.data;
      const phoneKey = uzPhoneKey(patient?.phone);
      const stillWanted =
      !!visit && visit.queue_number !== null && !!patient && !!clinic?.sms_enabled && patient.telegram_user_id === null && !!patient.sms_consent_at && !!phoneKey &&
      ["queue_ticket", "queue_called"].includes(job.type) &&
      (job.type === "queue_ticket" ? ["booked", "waiting", "called"].includes(visit.status) : visit.status === "called");
      if (!stillWanted) {
        if (await finishNotificationClaim(db, job, "skipped", "no longer applicable")) out.skipped++;
        else out.failed++;
        continue;
      }
      // The batch may have spent time on earlier jobs. Expired or replaced
      // claims cannot proceed to external I/O, even if this copy looked valid.
      if (!(await renewNotificationClaim(db, job))) {
        out.failed++;
        continue;
      }
      const text = job.type === "queue_called" ? queueCalledSms(clinic!.name, visit!.queue_number!) : queueTicketSms(clinic!.name, visit!.queue_number!);
      sending = true;
      const result = await provider.send(`+998${phoneKey}`, text, job.id);
      if (result.accepted) {
        const { error: receiptError } = await db.from("sms_messages").insert({ clinic_id: job.clinic_id, job_id: job.id, purpose: job.type, provider: provider.name, provider_message_id: result.providerMessageId });
        if (receiptError) {
          await finishNotificationClaim(db, job, "quarantined", "sms accepted but receipt not recorded");
          out.failed++;
        } else if (await finishNotificationClaim(db, job, "sent")) out.sent++;
        else out.failed++;
      } else if (result.outcome === "unknown") {
        await finishNotificationClaim(db, job, "quarantined", "delivery outcome unknown; review before resending");
        out.failed++;
      } else if (attempts >= (job.max_attempts ?? 3)) {
        await finishNotificationClaim(db, job, "failed", "sms rejected after retries");
        out.failed++;
      } else if (!(await finishNotificationClaim(db, job, "pending", "sms rejected, retrying"))) out.failed++;
    } catch {
      // Once the request started we cannot know whether a timeout concealed
      // provider acceptance. Do not let an exception release it for replay.
      await finishNotificationClaim(db, job, sending ? "quarantined" : attempts >= job.max_attempts ? "failed" : "pending",
        sending ? "delivery outcome unknown; review before resending" : "sms preparation failed");
      out.failed++;
    }
  }
  return out;
}

import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { ApiError } from "@/lib/api/errors";
import { logger } from "@/lib/logger";
import { deliverClinicNotificationsSoon } from "@/lib/notifications/deliver-soon";
import { rahmatProvider } from "@/lib/payments/online/rahmat";
import { testOnlineProvider } from "@/lib/payments/online/test-provider";
import type { OnlinePaymentProvider, OnlineProviderName } from "@/lib/payments/online/types";

/**
 * Pay online, get the queue number online (Slice C, 20261008000012). The server prices; the provider only collects
 * and signs; the database settles in one transaction (payment paid → appointment confirmed → visit with the next
 * number of the slot's day → Telegram ticket). Nothing here trusts an amount, a status or an id from the browser.
 */

const PROVIDERS: Record<OnlineProviderName, OnlinePaymentProvider> = { rahmat: rahmatProvider, test_online: testOnlineProvider };

/** The configured online provider, or null: patients pay at the kassa. */
export function activeOnlineProvider(): OnlinePaymentProvider | null {
  const name = process.env.ONLINE_PAYMENT_PROVIDER ?? "none";
  const provider = PROVIDERS[name as OnlineProviderName];
  return provider && provider.configured() ? provider : null;
}

const REFUSALS: Record<string, [number, string]> = {
  appointment_not_found: [404, "Yozuv topilmadi"],
  not_payable: [409, "Bu yozuvni onlayn to‘lab bo‘lmaydi"],
  nothing_due: [409, "To‘lanadigan summa yo‘q"],
  provider_unavailable: [503, "Onlayn to‘lov hozircha ishlamaydi — kassada to‘lang"],
  not_today: [409, "Bu onlayn yozuv boshqa kun uchun"],
  reason_required: [400, "To‘lov tizimidagi qaytarish raqamini kiriting"],
  refund_not_found: [404, "Qaytarish topilmadi"],
  forbidden: [403, "Ruxsat yo‘q"],
};
function refusal(error: { hint?: string | null; code?: string }, op: string): ApiError {
  const known = error.hint ? REFUSALS[error.hint] : undefined;
  if (known) return new ApiError(known[0], known[1], error.hint!);
  if (error.code === "42501") return new ApiError(403, REFUSALS.forbidden[1], "forbidden");
  logger.error("online payment rpc failed", { op, code: error.code });
  return new ApiError(500, "Amalni bajarib bo‘lmadi");
}

/** The patient's own booking → a checkout link for the amount the server priced at booking. */
export async function createOnlineCheckout(clinicId: string, patientId: string, appointmentId: string): Promise<{ payUrl: string; invoiceId: string; amount: number; currency: string }> {
  const provider = activeOnlineProvider();
  if (!provider) throw new ApiError(...REFUSALS.provider_unavailable, "provider_unavailable");
  const db = createAdminClient();
  const { data, error } = await db.rpc("create_online_invoice", {
    p_clinic: clinicId,
    p_patient: patientId,
    p_appointment: appointmentId,
    p_provider: provider.name,
  });
  if (error) throw refusal(error, "create_online_invoice");
  const invoice = data as unknown as { id: string; clinic_id: string; amount: number; currency: string; expires_at: string; pay_url: string | null };
  if (invoice.pay_url) return { payUrl: invoice.pay_url, invoiceId: invoice.id, amount: Number(invoice.amount), currency: invoice.currency };

  const checkout = await provider.createCheckout({
    id: invoice.id,
    clinicId: invoice.clinic_id,
    amount: Number(invoice.amount),
    currency: invoice.currency,
    expiresAt: invoice.expires_at,
  });
  await db.from("payment_invoices").update({ pay_url: checkout.payUrl, provider_invoice_id: checkout.providerInvoiceId }).eq("id", invoice.id);
  return { payUrl: checkout.payUrl, invoiceId: invoice.id, amount: Number(invoice.amount), currency: invoice.currency };
}

export type SettleOutcome = { outcome: "settled" | "replayed" | "refund_requested" | "rejected"; reason?: string };

/**
 * A provider webhook. The signature is verified over the raw body BEFORE any database call; an unverified request
 * changes nothing and learns nothing. Returns null when the signature does not verify.
 */
export async function handleOnlinePaymentWebhook(providerName: string, rawBody: string, headers: Headers): Promise<SettleOutcome | null> {
  const provider = PROVIDERS[providerName as OnlineProviderName];
  if (!provider || !provider.configured()) return null;
  const event = provider.verifyWebhook(rawBody, headers);
  if (!event) return null;
  if (!/^[0-9a-f-]{36}$/.test(event.invoiceId)) return { outcome: "rejected", reason: "unknown_invoice" };

  const { data, error } = await createAdminClient().rpc("settle_online_payment", {
    p_provider: provider.name,
    p_event_id: event.eventId,
    p_invoice: event.invoiceId,
    p_amount: event.amount,
    p_currency: event.currency,
    p_provider_reference: event.providerReference,
  });
  if (error) {
    logger.error("online payment settlement failed", { provider: provider.name, code: error.code });
    throw new ApiError(500, "Settlement failed");
  }
  const result = data as { outcome: SettleOutcome["outcome"]; reason?: string };
  if (result.outcome === "settled") {
    const { data: inv } = await createAdminClient().from("payment_invoices").select("clinic_id").eq("id", event.invoiceId).maybeSingle();
    if (inv) deliverClinicNotificationsSoon(inv.clinic_id);
  }
  return { outcome: result.outcome, reason: result.reason };
}

export type OnlinePaymentStatus = {
  paymentStatus: string;
  onlineAvailable: boolean;
  queueNumber: number | null;
  queueDate: string | null;
  visitStatus: string | null;
};

/** The patient's own booking: paid? and the queue number once the server issued it. */
export async function onlinePaymentStatus(clinicId: string, patientId: string, appointmentId: string): Promise<OnlinePaymentStatus> {
  const db = createAdminClient();
  const { data: appointment } = await db.from("appointments").select("id").eq("clinic_id", clinicId).eq("patient_id", patientId).eq("id", appointmentId).maybeSingle();
  if (!appointment) throw new ApiError(404, "Yozuv topilmadi", "appointment_not_found");
  const [{ data: payment }, { data: visit }] = await Promise.all([
    db.from("payments").select("status").eq("clinic_id", clinicId).eq("appointment_id", appointmentId).maybeSingle(),
    db.from("visits").select("status, queue_number, queue_date").eq("clinic_id", clinicId).eq("appointment_id", appointmentId).maybeSingle(),
  ]);
  return {
    paymentStatus: payment?.status ?? "unpaid",
    onlineAvailable: activeOnlineProvider() !== null,
    queueNumber: visit?.queue_number ?? null,
    queueDate: visit?.queue_date ?? null,
    visitStatus: visit?.status ?? null,
  };
}

export type RefundRequest = { id: string; amount: number; currency: string; reason: string; requestedAt: string; patientName: string | null; phone: string | null };

/** Owner/manager: money to send back (duplicate payments, lost slots, cancelled bookings). */
export async function listRefundRequests(clinicId: string): Promise<RefundRequest[]> {
  const db = createAdminClient();
  const { data, error } = await db
    .from("payment_refunds")
    .select("id, amount, currency, reason, requested_at, payment_id")
    .eq("clinic_id", clinicId)
    .eq("status", "requested")
    .order("requested_at")
    .limit(200);
  if (error) throw new ApiError(500, "Qaytarishlarni yuklab bo‘lmadi");
  const paymentIds = (data ?? []).map((r) => r.payment_id);
  const { data: payments } = paymentIds.length
    ? await db.from("payments").select("id, patients(full_name, phone)").in("id", paymentIds)
    : { data: [] };
  const who = new Map((payments ?? []).map((p) => [p.id, (p as unknown as { patients: { full_name: string | null; phone: string | null } | null }).patients]));
  return (data ?? []).map((r) => ({
    id: r.id,
    amount: Number(r.amount),
    currency: r.currency,
    reason: r.reason,
    requestedAt: r.requested_at,
    patientName: who.get(r.payment_id)?.full_name ?? null,
    phone: who.get(r.payment_id)?.phone ?? null,
  }));
}

export async function markRefundDone(staff: { clinicId: string; profileId: string }, refundId: string, reference: string) {
  const { data, error } = await createAdminClient().rpc("mark_online_refund_done", {
    p_clinic: staff.clinicId,
    p_actor: staff.profileId,
    p_refund: refundId,
    p_reference: reference,
  });
  if (error) throw refusal(error, "mark_online_refund_done");
  return data as { refund_id: string; replayed: boolean };
}

import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { isProduction } from "@/lib/env";
import type { OnlinePaymentProvider, VerifiedPaymentEvent } from "@/lib/payments/online/types";

/**
 * A signed test provider for local development and the E2E runs — the same contract a real provider meets: the server
 * prices the invoice, the provider signs a webhook over the raw body with a shared secret (HMAC-SHA256, hex, header
 * x-test-signature), and only a verified event reaches settle_online_payment. Refused in production unless the build
 * is an E2E run against a local database (src/instrumentation.ts, testOnlinePaymentAllowed).
 */
export const TEST_SIGNATURE_HEADER = "x-test-signature";

function secret(): string | null {
  const s = process.env.TEST_ONLINE_PAYMENT_SECRET;
  if (!s || s.length < 32) return null;
  if (!isProduction) return s;
  const local = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/?$/.test(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "");
  return process.env.ALLOW_TEST_ONLINE_PAYMENT === "true" && local ? s : null;
}

export function signTestEvent(rawBody: string): string | null {
  const s = secret();
  return s ? createHmac("sha256", s).update(rawBody).digest("hex") : null;
}

export const testOnlineProvider: OnlinePaymentProvider = {
  name: "test_online",
  configured: () => secret() !== null,
  async createCheckout(invoice) {
    // The local "provider page": a button that has the provider pay this invoice (src/app/pay/test/[invoiceId]).
    return { payUrl: `/pay/test/${invoice.id}?clinic=${encodeURIComponent(invoice.clinicId)}`, providerInvoiceId: `test-${invoice.id}` };
  },
  verifyWebhook(rawBody, headers) {
    const expected = signTestEvent(rawBody);
    const given = headers.get(TEST_SIGNATURE_HEADER) ?? "";
    if (!expected || !/^[0-9a-f]{64}$/.test(given)) return null;
    if (!timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(given, "hex"))) return null;
    try {
      const e = JSON.parse(rawBody) as Partial<{ eventId: string; invoiceId: string; amount: number; currency: string; reference: string }>;
      if (typeof e.eventId !== "string" || typeof e.invoiceId !== "string" || typeof e.amount !== "number" || typeof e.currency !== "string") return null;
      const event: VerifiedPaymentEvent = { eventId: e.eventId, invoiceId: e.invoiceId, amount: e.amount, currency: e.currency, providerReference: e.reference ?? null };
      return event;
    } catch {
      return null;
    }
  },
};

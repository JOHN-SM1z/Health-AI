import "server-only";
import { ApiError } from "@/lib/api/errors";
import type { OnlinePaymentProvider } from "@/lib/payments/online/types";

/**
 * Rahmat (owner decision 2026-10-08) — NOT IMPLEMENTED, and it fails closed: no checkout is created and every webhook is
 * rejected, so no payment can be marked paid through it. Production refuses to start with ONLINE_PAYMENT_PROVIDER=rahmat
 * (src/instrumentation.ts).
 *
 * To implement, from Rahmat's merchant documentation and a signed contract:
 *   * the checkout/invoice API (amount in so‘m or tiyin? currency, return URL, expiry, our invoice id as the order id);
 *   * the webhook: its signature scheme (algorithm, which fields or the raw body, header name), its event id (for
 *     payment_provider_events), the paid/failed/refunded states, and its retry behaviour;
 *   * the refund API (mark_online_refund_done records a refund made in Rahmat's merchant cabinet until then);
 *   * test credentials and a sandbox, then contract tests like test-provider.test.ts.
 * Credentials go in RAHMAT_MERCHANT_ID / RAHMAT_SECRET_KEY / RAHMAT_API_BASE_URL — never in code or logs.
 */
export const rahmatProvider: OnlinePaymentProvider = {
  name: "rahmat",
  configured: () => false,
  async createCheckout() {
    throw new ApiError(503, "Onlayn to‘lov hozircha ishlamaydi — kassada to‘lang", "online_payment_unavailable");
  },
  verifyWebhook() {
    return null;
  },
};

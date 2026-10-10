/**
 * An online payment provider for the Mini App (Slice C, 20261008000012). A provider does two things only: it creates a
 * checkout for an invoice the SERVER priced, and it verifies the provider's own signature on a webhook. Everything
 * that changes money state happens in the database (settle_online_payment), never on the provider's say-so alone.
 */
export type OnlineProviderName = "rahmat" | "test_online";

export type CheckoutInvoice = { id: string; clinicId: string; amount: number; currency: string; expiresAt: string };

/** A payment the provider has signed for. Amounts are in the clinic's currency units (so‘m), never tiyin. */
export type VerifiedPaymentEvent = {
  eventId: string;
  invoiceId: string;
  amount: number;
  currency: string;
  providerReference: string | null;
};

export interface OnlinePaymentProvider {
  readonly name: OnlineProviderName;
  /** Credentials present and the adapter able to work. */
  configured(): boolean;
  createCheckout(invoice: CheckoutInvoice): Promise<{ payUrl: string; providerInvoiceId: string | null }>;
  /** The provider's signature checked over the RAW body; null when it does not verify. Never throws on bad input. */
  verifyWebhook(rawBody: string, headers: Headers): VerifiedPaymentEvent | null;
}

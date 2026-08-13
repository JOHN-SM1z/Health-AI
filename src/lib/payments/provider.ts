import { env } from "@/lib/env";
import { logger } from "@/lib/logger";

export type PaymentInitResult = {
  status: "unpaid" | "pending" | "paid" | "failed" | "manual_review";
  providerReference?: string;
  paymentUrl?: string;
  manualConfirmationRequired: boolean;
};

export type PaymentProviderName = "manual" | "click" | "payme";

/**
 * Provider-based payment interface. All payment initiation and status
 * changes happen server-side. The webhook-facing method is idempotent by
 * design (callers deduplicate via processed_webhooks + payment status).
 *
 * The Manual provider is the built-in development / clinic-assisted mode:
 * it creates the payment record truthfully as 'unpaid' and requires an
 * authorized staff action to mark it paid — no fake "paid" states.
 */
export interface PaymentProvider {
  readonly name: PaymentProviderName;
  /** Called after an appointment is created; returns the initial payment state. */
  createPayment(opts: {
    appointmentId: string;
    patientId: string;
    clinicId: string;
    amount: number;
    currency: string;
  }): Promise<PaymentInitResult>;
  /** For redirect-based providers (e.g. Click/Payme) — returns the URL to send the patient to. */
  getPaymentUrl(paymentId: string, appointmentId: string): string | null;
  /** Verifies a webhook payload signature. Returns false when invalid. */
  verifyWebhook(payload: string, signature: string): boolean;
}

export class ManualPaymentProvider implements PaymentProvider {
  readonly name = "manual" as const;

  async createPayment(): Promise<PaymentInitResult> {
    return { status: "unpaid", manualConfirmationRequired: true };
  }

  getPaymentUrl(): string | null {
    return null;
  }

  verifyWebhook(): boolean {
    // The manual provider never receives webhooks.
    return false;
  }
}

/**
 * Adapter skeletons for real Uzbekistan providers.
 * They are intentionally NOT implemented: activating real payment processing
 * requires explicit merchant configuration. When the clinic provides
 * credentials, implement createPayment/verifyWebhook per the provider's API
 * and enable the provider via PAYMENT_PROVIDER.
 */
export class ClickPaymentProvider implements PaymentProvider {
  readonly name = "click" as const;
  async createPayment(): Promise<PaymentInitResult> {
    throw new Error("Click provider is not configured — implement with merchant credentials");
  }
  getPaymentUrl(): string | null {
    return null;
  }
  verifyWebhook(): boolean {
    return false;
  }
}

export class PaymePaymentProvider implements PaymentProvider {
  readonly name = "payme" as const;
  async createPayment(): Promise<PaymentInitResult> {
    throw new Error("Payme provider is not configured — implement with merchant credentials");
  }
  getPaymentUrl(): string | null {
    return null;
  }
  verifyWebhook(): boolean {
    return false;
  }
}

let active: PaymentProvider | null = null;

export function getPaymentProvider(): PaymentProvider {
  if (active) return active;
  switch (env.PAYMENT_PROVIDER) {
    case "click":
      active = new ClickPaymentProvider();
      break;
    case "payme":
      active = new PaymePaymentProvider();
      break;
    case "manual":
    default:
      active = new ManualPaymentProvider();
      break;
  }
  return active;
}

/** True when a real (non-manual) payment provider is active. */
export function isManualPaymentMode(): boolean {
  return getPaymentProvider().name === "manual";
}

export function logPaymentProviderState() {
  logger.info("payment provider active", { provider: getPaymentProvider().name });
}
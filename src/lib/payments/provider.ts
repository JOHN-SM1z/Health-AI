import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { createClickInvoice, clickWebhookSignatureValid } from "@/lib/payments/click";

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
 * Click (click.uz) adapter. Activation is explicit: PAYMENT_PROVIDER=click
 * with CLICK_MERCHANT_ID/SERVICE_ID/SECRET_KEY (validated in env.ts, which
 * fails closed otherwise). Invoice creation calls the Click merchant API;
 * payment completion arrives via signature-verified webhooks
 * (/api/payments/click/prepare|complete) that transition the payment row.
 */
export class ClickPaymentProvider implements PaymentProvider {
  readonly name = "click" as const;

  async createPayment(opts: {
    appointmentId: string;
    patientId: string;
    clinicId: string;
    amount: number;
    currency: string;
  }): Promise<PaymentInitResult> {
    const invoice = await createClickInvoice({
      merchantTransId: opts.appointmentId,
      amount: opts.amount,
      currency: opts.currency,
      returnUrl: env.CLICK_RETURN_URL,
    });
    return {
      status: "pending",
      providerReference: invoice.invoiceId,
      paymentUrl: invoice.paymentUrl,
      manualConfirmationRequired: false,
    };
  }

  getPaymentUrl(): string | null {
    // The payment URL is returned at invoice creation and stored on the
    // payment row (payments.payment_url); the webhook route re-serves it.
    return null;
  }

  verifyWebhook(payload: string, signature: string): boolean {
    if (!payload || !signature) return false;
    try {
      const params = new URLSearchParams(payload);
      const required = ["click_trans_id", "service_id", "merchant_trans_id", "amount", "error", "click_paydoc_id", "sign_time"];
      for (const key of required) {
        if (!params.get(key)) return false;
      }
      return clickWebhookSignatureValid({
        clickTransId: params.get("click_trans_id")!,
        serviceId: params.get("service_id")!,
        secretKey: env.CLICK_SECRET_KEY ?? "",
        merchantTransId: params.get("merchant_trans_id")!,
        amount: params.get("amount")!,
        error: params.get("error") ?? "0",
        clickPaydocId: params.get("click_paydoc_id")!,
        signTime: params.get("sign_time")!,
        signString: signature,
      });
    } catch {
      return false;
    }
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
import "server-only";
import { createHash, timingSafeEqual } from "node:crypto";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";

/**
 * Click (click.uz) merchant integration.
 *
 * Invoice creation: POST /v2/merchant/invoice/create (merchant API).
 * Payment callbacks: Click POSTs urlencoded prepare/complete payloads to the
 * registered webhook URLs; every callback is verified by its md5 signature
 * before any state change, and handlers are idempotent via
 * processed_webhooks (claim_webhook_update).
 *
 * Merchant credentials come from env and are validated at startup: selecting
 * PAYMENT_PROVIDER=click without CLICK_MERCHANT_ID/SERVICE_ID/SECRET_KEY
 * fails closed.
 */

export const CLICK_DEFAULT_API_BASE = "https://api.click.uz";

const CLICK_CURRENCY_ISO_NUMERIC: Record<string, string> = {
  UZS: "860",
  USD: "840",
  RUB: "643",
};

function isoNumericCurrency(currency: string): string {
  return CLICK_CURRENCY_ISO_NUMERIC[currency.toUpperCase()] ?? "860";
}

/** Click amounts are decimal strings with exactly two fraction digits. */
export function clickAmount(value: number): string {
  return value.toFixed(2);
}

/** Seconds since epoch (Click sign_time format). */
export function clickSignTime(date = new Date()): string {
  return String(Math.floor(date.getTime() / 1000));
}

/**
 * Signature for invoice creation:
 * md5(merchant_id + service_id + secret_key + merchant_trans_id + amount + currency + sign_time)
 */
export function clickInvoiceSignature(opts: {
  merchantId: string;
  serviceId: string;
  secretKey: string;
  merchantTransId: string;
  amount: string;
  currency: string;
  signTime: string;
}): string {
  const raw = [
    opts.merchantId,
    opts.serviceId,
    opts.secretKey,
    opts.merchantTransId,
    opts.amount,
    opts.currency,
    opts.signTime,
  ].join("");
  return createHash("md5").update(raw).digest("hex");
}

/**
 * Webhook callback signature:
 * md5(click_trans_id + service_id + secret_key + merchant_trans_id + amount + error + click_paydoc_id + sign_time)
 */
export function clickWebhookSignature(opts: {
  clickTransId: string;
  serviceId: string;
  secretKey: string;
  merchantTransId: string;
  amount: string;
  error: string;
  clickPaydocId: string;
  signTime: string;
}): string {
  const raw = [
    opts.clickTransId,
    opts.serviceId,
    opts.secretKey,
    opts.merchantTransId,
    opts.amount,
    opts.error,
    opts.clickPaydocId,
    opts.signTime,
  ].join("");
  return createHash("md5").update(raw).digest("hex");
}

function safeEqualHex(a: string, b: string): boolean {
  const ab = Buffer.from(a.toLowerCase(), "hex");
  const bb = Buffer.from(b.toLowerCase(), "hex");
  return ab.length === bb.length && ab.length > 0 && timingSafeEqual(ab, bb);
}

/** Constant-time signature comparison for webhook callbacks. */
export function clickWebhookSignatureValid(opts: {
  clickTransId: string;
  serviceId: string;
  secretKey: string;
  merchantTransId: string;
  amount: string;
  error: string;
  clickPaydocId: string;
  signTime: string;
  signString: string;
}): boolean {
  const { signString, ...rest } = opts;
  return safeEqualHex(clickWebhookSignature(rest), signString);
}

export type ClickInvoice = {
  invoiceId: string;
  paymentUrl: string;
};

export class ClickInvoiceError extends Error {
  readonly errorCode: number;

  constructor(errorCode: number, message: string) {
    super(message);
    this.errorCode = errorCode;
    this.name = "ClickInvoiceError";
  }
}

/**
 * Creates a prepaid Click invoice via the merchant API.
 * Throws ClickInvoiceError on a merchant-side rejection; throws on
 * transport errors so callers can fall back to manual payment collection
 * (the booking itself is already committed — payment state stays truthful).
 */
export async function createClickInvoice(opts: {
  merchantTransId: string;
  amount: number;
  currency: string;
  returnUrl?: string;
}): Promise<ClickInvoice> {
  const { CLICK_MERCHANT_ID, CLICK_SERVICE_ID, CLICK_SECRET_KEY, CLICK_API_BASE_URL } = env;
  const merchantId = CLICK_MERCHANT_ID ?? "";
  const serviceId = CLICK_SERVICE_ID ?? "";
  const secretKey = CLICK_SECRET_KEY ?? "";

  const amount = clickAmount(opts.amount);
  const currency = isoNumericCurrency(opts.currency);
  const signTime = clickSignTime();
  const signString = clickInvoiceSignature({
    merchantId,
    serviceId,
    secretKey,
    merchantTransId: opts.merchantTransId,
    amount,
    currency,
    signTime,
  });

  const baseUrl = CLICK_API_BASE_URL ?? CLICK_DEFAULT_API_BASE;
  const res = await fetch(`${baseUrl}/v2/merchant/invoice/create`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      service_id: serviceId,
      merchant_id: merchantId,
      merchant_trans_id: opts.merchantTransId,
      amount,
      currency,
      sign_time: signTime,
      sign_string: signString,
      prepaid: true,
      return_url: opts.returnUrl,
    }),
  });

  if (!res.ok) {
    logger.error("click invoice http error", { status: res.status });
    throw new Error(`Click invoice request failed (HTTP ${res.status})`);
  }

  const body = (await res.json()) as {
    error_code?: number;
    error_note?: string;
    invoice_id?: string;
    url?: string;
  };

  if (body.error_code !== undefined && body.error_code !== 0) {
    throw new ClickInvoiceError(body.error_code, body.error_note ?? "Click invoice rejected");
  }

  if (!body.invoice_id || !body.url) {
    throw new Error("Click invoice response missing invoice_id/url");
  }

  return { invoiceId: body.invoice_id, paymentUrl: body.url };
}
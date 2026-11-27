import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { clickAmount, clickWebhookSignatureValid } from "@/lib/payments/click";
import { transitionPaymentStatus } from "@/lib/payments/status";
import {
  claimWebhookProcessing,
  finishWebhookProcessing,
  releaseWebhookProcessing,
} from "@/lib/telegram/idempotency";

/**
 * Shared Click webhook handling for the prepare and complete callbacks.
 *
 * Every callback is signature-verified (md5 with the merchant secret) before
 * any state change, then atomically claimed via processed_webhooks so
 * concurrent or repeated deliveries cannot double-process. Duplicate
 * deliveries of an already-processed transaction receive a success ack
 * (Click expects "0" for retried/duplicate callbacks).
 */

export type ClickWebhookParams = {
  clickTransId: string;
  serviceId: string;
  clickPaydocId: string;
  merchantTransId: string;
  amount: string;
  action?: string;
  error: string;
  signTime: string;
  signString: string;
  merchantPrepareId?: string;
};

const CLICK_FIELD_MAP: Record<keyof ClickWebhookParams, string> = {
  clickTransId: "click_trans_id",
  serviceId: "service_id",
  clickPaydocId: "click_paydoc_id",
  merchantTransId: "merchant_trans_id",
  amount: "amount",
  error: "error",
  signTime: "sign_time",
  signString: "sign_string",
  action: "action",
  merchantPrepareId: "merchant_prepare_id",
};

function parseParams(body: string): ClickWebhookParams | null {
  const p = new URLSearchParams(body);
  const required: Array<keyof ClickWebhookParams> = [
    "clickTransId",
    "serviceId",
    "clickPaydocId",
    "merchantTransId",
    "amount",
    "error",
    "signTime",
    "signString",
  ];
  const out: Partial<Record<keyof ClickWebhookParams, string>> = {};
  for (const key of required) {
    const value = p.get(CLICK_FIELD_MAP[key]);
    if (!value) return null;
    out[key] = value;
  }
  out.action = p.get(CLICK_FIELD_MAP.action) ?? undefined;
  out.merchantPrepareId = p.get(CLICK_FIELD_MAP.merchantPrepareId) ?? undefined;
  return out as unknown as ClickWebhookParams;
}

function signError(note: string, code = "-1") {
  return Response.json({ error_code: code, error_note: note }, { status: 200 });
}

/**
 * Click callbacks are accepted only while Click is the configured provider
 * with its merchant secret and service id. Without the secret the signature
 * would be an MD5 over public values and an EMPTY key — one anybody can
 * compute — so a forged "payment completed" would be accepted (security
 * assessment 2026-11-27, SAST-1). Unconfigured, the endpoints do not exist.
 */
export function clickCallbacksEnabled(): boolean {
  return env.PAYMENT_PROVIDER === "click" && !!env.CLICK_SECRET_KEY && !!env.CLICK_SERVICE_ID;
}

/**
 * Handles one Click callback. `complete` selects the prepare vs complete
 * processing path (Click registers two separate webhook URLs).
 */
export async function handleClickWebhook(requestBody: string, complete: boolean): Promise<Response> {
  if (!clickCallbacksEnabled()) {
    return new Response("Not found", { status: 404 });
  }
  const secretKey = env.CLICK_SECRET_KEY as string;

  const params = parseParams(requestBody);
  if (!params) {
    return signError("INVALID PAYLOAD", "-6");
  }

  // 1. Signature verification — constant-time against the merchant secret.
  const signatureValid = clickWebhookSignatureValid({
    clickTransId: params.clickTransId,
    serviceId: params.serviceId,
    secretKey,
    merchantTransId: params.merchantTransId,
    amount: params.amount,
    error: params.error,
    clickPaydocId: params.clickPaydocId,
    signTime: params.signTime,
    signString: params.signString,
  });
  if (!signatureValid) {
    logger.warn("click webhook signature mismatch", { complete });
    return signError("SIGN CHECK FAILED!");
  }

  if (params.serviceId !== env.CLICK_SERVICE_ID) {
    return signError("INSUFFICIENT PERMISSIONS", "-2");
  }

  // A correctly signed callback can still report a FAILED or cancelled payment (error below zero).
  // It must never reserve or complete one: only "0" means Click took the money.
  if (params.error !== "0") {
    logger.warn("click webhook reported a failed payment", { complete });
    return signError("TRANSACTION CANCELLED", "-9");
  }

  // 2. Atomic idempotency claim (one winner per click_trans_id).
  const claimed = await claimWebhookProcessing("click", params.clickTransId);
  if (!claimed) {
    // Already processed (or being processed). Click retries until "0".
    return Response.json({ error_code: "0", error_note: "Success" });
  }

  try {
    const supabase = createAdminClient();

    // merchant_trans_id is our appointment id (see ClickPaymentProvider).
    const { data: payment, error: fetchError } = await supabase
      .from("payments")
      .select("id, appointment_id, clinic_id, amount, currency, status, provider_reference")
      .eq("appointment_id", params.merchantTransId)
      .maybeSingle();

    if (fetchError || !payment) {
      logger.warn("click webhook unknown appointment", { complete });
      return signError("TRANSACTION NOT FOUND", "-5");
    }

    // 3. Amount must match the committed payment exactly.
    if (clickAmount(Number(payment.amount)) !== params.amount) {
      return signError("INVALID AMOUNT", "-4");
    }

    if (complete) {
      // Completion: pending/unpaid -> paid. Already-paid is an idempotent ack.
      if (payment.status !== "paid") {
        await transitionPaymentStatus({
          paymentId: payment.id,
          clinicId: payment.clinic_id,
          to: "paid",
          actorType: "system",
          providerReference: payment.provider_reference ?? params.clickTransId,
          metadata: {
            click_trans_id: params.clickTransId,
            click_paydoc_id: params.clickPaydocId,
            click_merchant_prepare_id: params.merchantPrepareId ?? null,
            complete: true,
          },
        });
        logger.info("click payment completed", {
          appointmentId: payment.appointment_id,
          clickTransId: params.clickTransId,
        });
      }
      await finishWebhookProcessing("click", params.clickTransId, claimed);
      return Response.json({
        error_code: "0",
        error_note: "Success",
        click_trans_id: params.clickTransId,
        merchant_trans_id: params.merchantTransId,
        merchant_confirm_id: params.clickTransId,
      });
    }

    // Prepare: mark the invoice as pending (reserved).
    if (payment.status === "unpaid") {
      await transitionPaymentStatus({
        paymentId: payment.id,
        clinicId: payment.clinic_id,
        to: "pending",
        actorType: "system",
        providerReference: payment.provider_reference ?? params.clickTransId,
        metadata: {
          click_trans_id: params.clickTransId,
          click_paydoc_id: params.clickPaydocId,
          click_merchant_prepare_id: params.merchantPrepareId ?? null,
          prepare: true,
        },
      });
      logger.info("click payment prepared", {
        appointmentId: payment.appointment_id,
        clickTransId: params.clickTransId,
      });
    }
    await finishWebhookProcessing("click", params.clickTransId, claimed);
    return Response.json({
      error_code: "0",
      error_note: "Success",
      click_trans_id: params.clickTransId,
      merchant_trans_id: params.merchantTransId,
      merchant_prepare_id: params.merchantPrepareId ?? "",
    });
  } catch {
    // Release the claim so the next Click delivery retries.
    await releaseWebhookProcessing("click", params.clickTransId, claimed).catch(() => {});
    logger.error("click webhook handler failed", { complete });
    return signError("INTERNAL ERROR", "-9");
  }
}

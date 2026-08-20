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
 * Handles one Click callback. `complete` selects the prepare vs complete
 * processing path (Click registers two separate webhook URLs).
 */
export async function handleClickWebhook(requestBody: string, complete: boolean): Promise<Response> {
  const params = parseParams(requestBody);
  if (!params) {
    return signError("INVALID PAYLOAD", "-6");
  }

  // 1. Signature verification — constant-time against the merchant secret.
  const signatureValid = clickWebhookSignatureValid({
    clickTransId: params.clickTransId,
    serviceId: params.serviceId,
    secretKey: env.CLICK_SECRET_KEY ?? "",
    merchantTransId: params.merchantTransId,
    amount: params.amount,
    error: params.error,
    clickPaydocId: params.clickPaydocId,
    signTime: params.signTime,
    signString: params.signString,
  });
  if (!signatureValid) {
    logger.warn("click webhook signature mismatch", {
      clickTransId: params.clickTransId,
      complete,
    });
    return signError("SIGN CHECK FAILED!");
  }

  if (env.CLICK_SERVICE_ID && params.serviceId !== env.CLICK_SERVICE_ID) {
    return signError("INSUFFICIENT PERMISSIONS", "-2");
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
      logger.warn("click webhook unknown appointment", { merchantTransId: params.merchantTransId });
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
      await finishWebhookProcessing("click", params.clickTransId);
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
    await finishWebhookProcessing("click", params.clickTransId);
    return Response.json({
      error_code: "0",
      error_note: "Success",
      click_trans_id: params.clickTransId,
      merchant_trans_id: params.merchantTransId,
      merchant_prepare_id: params.merchantPrepareId ?? "",
    });
  } catch (e) {
    // Release the claim so the next Click delivery retries.
    await releaseWebhookProcessing("click", params.clickTransId).catch(() => {});
    logger.error("click webhook handler failed", {
      error: e instanceof Error ? e.message : String(e),
      clickTransId: params.clickTransId,
      complete,
    });
    return signError("INTERNAL ERROR", "-9");
  }
}
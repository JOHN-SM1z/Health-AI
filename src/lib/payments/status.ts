import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { ApiError } from "@/lib/api/errors";
import { recordAudit } from "@/lib/audit";
import { logger } from "@/lib/logger";
import type { Database } from "@/lib/supabase/database.types";

type PaymentStatus = Database["public"]["Enums"]["payment_status"];

const LEGAL_TRANSITIONS: Record<PaymentStatus, PaymentStatus[]> = {
  unpaid: ["pending", "paid", "failed", "manual_review", "refunded"],
  pending: ["paid", "failed", "manual_review", "unpaid", "refunded"],
  manual_review: ["paid", "failed", "unpaid", "refunded"],
  paid: ["refunded", "manual_review"],
  failed: ["pending", "unpaid"],
  refunded: [],
};

export function canTransition(from: PaymentStatus, to: PaymentStatus): boolean {
  return LEGAL_TRANSITIONS[from]?.includes(to) ?? false;
}

/**
 * Server-side only payment status transition, with audit trail and
 * idempotency (setting the same status twice is a no-op).
 * The `paid_by` profile is recorded for manual confirmations.
 */
export async function transitionPaymentStatus(opts: {
  paymentId: string;
  to: PaymentStatus;
  actorId?: string | null;
  actorType?: "staff" | "system";
  providerReference?: string | null;
  metadata?: Record<string, unknown>;
}): Promise<{ ok: boolean; alreadyInState?: boolean }> {
  const supabase = createAdminClient();

  const { data: payment, error: fetchError } = await supabase
    .from("payments")
    .select("id, status, clinic_id, appointment_id, amount, currency, provider, paid_at, paid_by, provider_reference")
    .eq("id", opts.paymentId)
    .maybeSingle();
  if (fetchError || !payment) {
    throw new ApiError(404, "To‘lov topilmadi", "payment_not_found");
  }

  if (payment.status === opts.to) {
    return { ok: true, alreadyInState: true };
  }

  if (!canTransition(payment.status, opts.to)) {
    throw new ApiError(
      409,
      `To‘lov holatini “${payment.status}” dan “${opts.to}” ga o‘zgartirib bo‘lmaydi`,
      "invalid_transition",
    );
  }

  const { error } = await supabase
    .from("payments")
    .update({
      status: opts.to,
      paid_at: opts.to === "paid" ? new Date().toISOString() : payment.paid_at,
      paid_by: opts.to === "paid" ? opts.actorId ?? null : payment.paid_by,
      provider_reference: opts.providerReference ?? payment.provider_reference,
      metadata: (opts.metadata ?? {}) as never,
    })
    .eq("id", payment.id);

  if (error) {
    logger.error("payment transition failed", { error: error.message, paymentId: payment.id });
    throw new ApiError(500, "To‘lov holatini yangilab bo‘lmadi", "payment_update_failed");
  }

  await recordAudit({
    clinicId: payment.clinic_id,
    action: "payment_status_changed",
    entityType: "payments",
    entityId: payment.id,
    actor: { actorId: opts.actorId, actorType: opts.actorType ?? "staff" },
    newValues: { status: opts.to, provider: payment.provider },
    oldValues: { status: payment.status },
  });

  return { ok: true };
}
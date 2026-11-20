import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { ApiError } from "@/lib/api/errors";
import { logger } from "@/lib/logger";
import { transitionPaymentStatus } from "@/lib/payments/status";
import type { ClinicStaff } from "@/lib/labs/guards";

/**
 * Lab orders at the Kassa (Phase 6) — the existing payment engine, not a
 * second one. Every lab order has one payment row (created with the order by
 * create_lab_order, amount = stored item prices). Staff only ever move its
 * status through transitionPaymentStatus (legal transitions, compare-and-set,
 * audit); the amount is never taken from a request and the database refuses
 * any amount that does not match the order.
 *
 * Lab payments are always recorded manually (cash or card terminal at the
 * desk): online provider adapters are built for appointments only.
 */

export type LabPaymentRow = {
  orderId: string;
  paymentId: string;
  createdAt: string;
  patientName: string | null;
  orderStatus: string;
  tests: Array<{ name: string; status: string }>;
  amount: number;
  currency: string;
  paymentStatus: string;
  method: string | null;
  paidAt: string | null;
};

export async function listLabPayments(staff: ClinicStaff, filter: "open" | "all"): Promise<LabPaymentRow[]> {
  let query = createAdminClient()
    .from("payments")
    .select(
      "id, amount, currency, status, paid_at, metadata, lab_order_id, " +
        "lab_orders!payments_lab_order_fkey(id, created_at, status, patients!lab_orders_patient_fkey(full_name), lab_order_items(test_name_snapshot, status))",
    )
    .eq("clinic_id", staff.clinicId)
    .not("lab_order_id", "is", null)
    .order("created_at", { ascending: false })
    .limit(200);
  if (filter === "open") query = query.in("status", ["unpaid", "pending", "failed", "manual_review"]);
  const { data, error } = await query;
  if (error) {
    logger.error("lab payments list failed", { code: error.code });
    throw new ApiError(500, "Laboratoriya to‘lovlarini yuklab bo‘lmadi", "load_failed");
  }

  type Row = {
    id: string;
    amount: number;
    currency: string;
    status: string;
    paid_at: string | null;
    metadata: Record<string, unknown> | null;
    lab_orders: {
      id: string;
      created_at: string;
      status: string;
      patients: { full_name: string | null } | null;
      lab_order_items: Array<{ test_name_snapshot: string; status: string }>;
    } | null;
  };
  return ((data ?? []) as unknown as Row[])
    .filter((p) => p.lab_orders)
    .map((p) => ({
      orderId: p.lab_orders!.id,
      paymentId: p.id,
      createdAt: p.lab_orders!.created_at,
      patientName: p.lab_orders!.patients?.full_name ?? null,
      orderStatus: p.lab_orders!.status,
      tests: p.lab_orders!.lab_order_items.map((i) => ({ name: i.test_name_snapshot, status: i.status })),
      amount: Number(p.amount),
      currency: p.currency,
      paymentStatus: p.status,
      method: typeof p.metadata?.method === "string" ? p.metadata.method : null,
      paidAt: p.paid_at,
    }));
}

export type LabPaymentChange = { status: "paid" | "refunded" | "manual_review" | "failed"; method?: "cash" | "card_terminal" };

/** Records a desk payment, refund or review for one lab order of the staff member's clinic. */
export async function changeLabPayment(staff: ClinicStaff, orderId: string, change: LabPaymentChange) {
  const { data: payment, error } = await createAdminClient()
    .from("payments")
    .select("id")
    .eq("clinic_id", staff.clinicId)
    .eq("lab_order_id", orderId)
    .maybeSingle();
  if (error) {
    logger.error("lab payment lookup failed", { code: error.code });
    throw new ApiError(500, "To‘lovni topib bo‘lmadi", "load_failed");
  }
  if (!payment) throw new ApiError(404, "To‘lov topilmadi", "payment_not_found");
  if (change.status === "paid" && !change.method) throw new ApiError(400, "To‘lov usulini tanlang", "method_required");

  return transitionPaymentStatus({
    paymentId: payment.id,
    clinicId: staff.clinicId,
    to: change.status,
    actorId: staff.profileId,
    actorType: "staff",
    metadata: {
      manual_confirmation: true,
      subject: "lab_order",
      ...(change.status === "paid" ? { method: change.method } : {}),
      ...(change.status === "refunded" ? { refunded_by: staff.profileId, refunded_at: new Date().toISOString() } : {}),
    },
  });
}

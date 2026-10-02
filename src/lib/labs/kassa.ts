import "server-only";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { ApiError } from "@/lib/api/errors";
import { recordAudit } from "@/lib/audit";
import { transitionPaymentStatus } from "@/lib/payments/status";
import { logger } from "@/lib/logger";
import type { Database } from "@/lib/supabase/database.types";

/**
 * Laboratory Kassa (phase 5): the clinic's EXISTING payments, for laboratory orders.
 *
 * No second payment engine: a lab order's payment is a `payments` row (created with the order, priced by the
 * database from the order's snapshots) and every status change goes through `transitionPaymentStatus` — the
 * same legal transitions, compare-and-set and audit as every other payment. This module only finds the
 * payment of an order inside the caller's clinic, applies who-may-do-what, and shapes what the cashier sees.
 *
 * Never trusted from a request: the amount, the currency, the clinic, the patient, the status. A request can
 * only ask for "confirm" or "refund" of an order (by id), and the server decides whether that is legal.
 *
 * Never shown here: the ordering doctor's note (clinical text) or any result.
 */

type PaymentStatus = Database["public"]["Enums"]["payment_status"];
type Db = ReturnType<typeof createAdminClient>;

const notFound = () => new ApiError(404, "Buyurtma topilmadi", "lab_not_found");

export const PAYMENT_METHODS = ["cash", "card", "transfer"] as const;
export const REFUND_REASONS = ["duplicate_payment", "order_cancelled", "patient_request", "other"] as const;

export const confirmPaymentSchema = z.object({ action: z.literal("confirm"), method: z.enum(PAYMENT_METHODS) }).strict();
export const refundPaymentSchema = z.object({ action: z.literal("refund"), reason: z.enum(REFUND_REASONS) }).strict();
export const paymentActionSchema = z.discriminatedUnion("action", [confirmPaymentSchema, refundPaymentSchema]);
export type PaymentAction = z.infer<typeof paymentActionSchema>;

export type KassaOrder = {
  orderId: string;
  createdAt: string;
  orderStatus: string;
  priority: string;
  patient: { id: string; fullName: string | null };
  /** How many tests the order has — never their names: the list is browsed by everyone at the desk. */
  itemCount: number;
  payment: { id: string; status: PaymentStatus; amount: number; currency: string; paidAt: string | null };
};

export type KassaFilter = "unpaid" | "paid" | "all";

/** Laboratory orders of the clinic with their payment, newest first (the payment status is the engine's, not a copy). */
export async function listKassaOrders(clinicId: string, filter: KassaFilter, limit = 100): Promise<KassaOrder[]> {
  const db = createAdminClient();
  let query = db
    .from("payments")
    .select(
      "id, status, amount, currency, paid_at, lab_order_id, patient_id, lab_orders!payments_lab_order_fkey(id, status, priority, created_at, lab_order_items(status)), patients(id, full_name)",
    )
    .eq("clinic_id", clinicId)
    .not("lab_order_id", "is", null)
    .order("created_at", { ascending: false })
    .limit(Math.min(limit, 200));
  if (filter === "unpaid") query = query.in("status", ["unpaid", "pending", "manual_review", "failed"]);
  if (filter === "paid") query = query.in("status", ["paid", "refunded"]);
  const { data, error } = await query;
  if (error) {
    logger.error("kassa list failed", { code: error.code });
    throw new ApiError(500, "Kassani yuklab bo‘lmadi");
  }

  type Row = {
    id: string;
    status: PaymentStatus;
    amount: number;
    currency: string;
    paid_at: string | null;
    patients: { id: string; full_name: string | null } | null;
    lab_orders: {
      id: string;
      status: string;
      priority: string;
      created_at: string;
      lab_order_items: Array<{ status: string }>;
    } | null;
  };
  return ((data ?? []) as unknown as Row[])
    // A cancelled order is not owed: it stays visible under "all" (with its truthful payment status) but not as work to collect.
    .filter((r) => r.lab_orders && !(filter === "unpaid" && r.lab_orders.status === "cancelled"))
    .map((r) => ({
      orderId: r.lab_orders!.id,
      createdAt: r.lab_orders!.created_at,
      orderStatus: r.lab_orders!.status,
      priority: r.lab_orders!.priority,
      patient: { id: r.patients?.id ?? "", fullName: r.patients?.full_name ?? null },
      itemCount: r.lab_orders!.lab_order_items.filter((i) => i.status === "active").length,
      payment: { id: r.id, status: r.status, amount: Number(r.amount), currency: r.currency, paidAt: r.paid_at },
    }));
}

/** The order and its payment, inside the clinic. Another clinic's order is "not found", like a missing one. */
async function loadOrderPayment(db: Db, clinicId: string, orderId: string) {
  const { data: order } = await db
    .from("lab_orders")
    .select("id, status, patient_id")
    .eq("id", orderId)
    .eq("clinic_id", clinicId)
    .maybeSingle();
  if (!order) throw notFound();
  const { data: payment } = await db
    .from("payments")
    .select("id, status, amount, currency, paid_at, paid_by, provider")
    .eq("clinic_id", clinicId)
    .eq("lab_order_id", orderId)
    .maybeSingle();
  if (!payment) throw new ApiError(404, "Bu buyurtma uchun to‘lov topilmadi", "payment_not_found");
  return { order, payment };
}

/**
 * Staff records that the order was paid (manual payment): unpaid/pending/manual_review → paid. Idempotent (a
 * repeat reports `alreadyInState`), refused for a cancelled order, and the status change is the engine's.
 */
export async function confirmLabPayment(staff: { clinicId: string; profileId: string }, orderId: string, method: (typeof PAYMENT_METHODS)[number]) {
  const db = createAdminClient();
  const { order, payment } = await loadOrderPayment(db, staff.clinicId, orderId);
  if (order.status === "cancelled") throw new ApiError(409, "Bekor qilingan buyurtma uchun to‘lov olinmaydi", "order_cancelled");

  const result = await transitionPaymentStatus({
    paymentId: payment.id,
    clinicId: staff.clinicId,
    to: "paid",
    actorId: staff.profileId,
    actorType: "staff",
    metadata: { manual_confirmation: true, provider: "manual", method },
  });
  if (!result.alreadyInState) {
    await recordAudit({
      clinicId: staff.clinicId,
      action: "lab_payment_confirmed",
      entityType: "lab_orders",
      entityId: orderId,
      patientId: order.patient_id,
      actor: { actorId: staff.profileId, actorType: "staff" },
      metadata: { payment_id: payment.id, method },
    });
  }
  return { paymentId: payment.id, alreadyInState: result.alreadyInState ?? false };
}

/**
 * Staff refunds a paid laboratory payment (paid → refunded). The order, its samples and its results are not
 * touched: a refund is a money event, and the clinical history is not rewritten by it.
 */
export async function refundLabPayment(staff: { clinicId: string; profileId: string }, orderId: string, reason: (typeof REFUND_REASONS)[number]) {
  const db = createAdminClient();
  const { order, payment } = await loadOrderPayment(db, staff.clinicId, orderId);
  const result = await transitionPaymentStatus({
    paymentId: payment.id,
    clinicId: staff.clinicId,
    to: "refunded",
    actorId: staff.profileId,
    actorType: "staff",
    metadata: { refund_reason: reason },
  });
  if (!result.alreadyInState) {
    await recordAudit({
      clinicId: staff.clinicId,
      action: "lab_payment_refunded",
      entityType: "lab_orders",
      entityId: orderId,
      patientId: order.patient_id,
      actor: { actorId: staff.profileId, actorType: "staff" },
      metadata: { payment_id: payment.id, reason },
    });
  }
  return { paymentId: payment.id, alreadyInState: result.alreadyInState ?? false };
}

export type LabPaymentTotals = { paid: number; unpaid: number; refunded: number; orders: number };

/**
 * Laboratory money for the finance view, for orders created in the window. Kept SEPARATE from the
 * appointment figures on purpose: the existing finance numbers are derived from appointments and a lab
 * payment has none, so adding it silently would change what they mean. unpaid = unpaid + pending + under
 * review; failed payments are neither owed nor received. Callers gate this with canViewPaymentDynamics.
 */
export async function labPaymentTotals(clinicId: string, since: string, until: string | null): Promise<LabPaymentTotals> {
  let query = createAdminClient()
    .from("payments")
    .select("status, amount, lab_orders!payments_lab_order_fkey(status)")
    .eq("clinic_id", clinicId)
    .not("lab_order_id", "is", null)
    .gte("created_at", since)
    .limit(10000);
  if (until) query = query.lt("created_at", until);
  const { data, error } = await query;
  if (error) throw new ApiError(500, "Laboratoriya to‘lovlarini yuklab bo‘lmadi");
  const totals: LabPaymentTotals = { paid: 0, unpaid: 0, refunded: 0, orders: (data ?? []).length };
  for (const p of (data ?? []) as unknown as Array<{ status: string; amount: number; lab_orders: { status: string } | null }>) {
    const amount = Number(p.amount);
    // Money owed for an order that was cancelled is not owed.
    if (p.lab_orders?.status === "cancelled" && p.status !== "paid" && p.status !== "refunded") continue;
    if (p.status === "paid") totals.paid += amount;
    else if (p.status === "refunded") totals.refunded += amount;
    else if (p.status === "unpaid" || p.status === "pending" || p.status === "manual_review") totals.unpaid += amount;
  }
  return totals;
}

// ---------------------------------------------------------------------------
// The payment-confirmation receipt
// ---------------------------------------------------------------------------

export type LabReceipt = {
  /** Always false: this is a payment confirmation, never a fiscal or legal receipt. */
  fiscal: false;
  disclaimer: string;
  number: string;
  clinic: { name: string };
  patient: { fullName: string | null };
  orderId: string;
  orderedAt: string;
  items: Array<{ code: string; name: string; price: number }>;
  amount: number;
  currency: string;
  status: PaymentStatus;
  paidAt: string | null;
  method: string | null;
  refunded: boolean;
};

export const RECEIPT_DISCLAIMER = "Bu to‘lovni tasdiqlovchi hujjat. Fiskal chek emas.";

/**
 * A minimal payment confirmation for an order: what was bought, the amount the SERVER computed, the payment's
 * authoritative status. Issued only for a payment that was actually received (paid, or refunded afterwards —
 * a refunded receipt says so); an unpaid order has no receipt (409), so nothing can be shown as proof of a
 * payment that did not happen. Staff of the clinic only; no clinical text, no results.
 */
export async function buildLabReceipt(clinicId: string, orderId: string): Promise<LabReceipt> {
  const db = createAdminClient();
  const { order, payment } = await loadOrderPayment(db, clinicId, orderId);
  if (payment.status !== "paid" && payment.status !== "refunded") {
    throw new ApiError(409, "To‘lov qabul qilinmagan — hujjat berilmaydi", "payment_not_received");
  }
  const [{ data: clinic }, { data: patient }, { data: full }, { data: items }] = await Promise.all([
    db.from("clinics").select("name").eq("id", clinicId).single(),
    db.from("patients").select("full_name").eq("id", order.patient_id).eq("clinic_id", clinicId).single(),
    db.from("lab_orders").select("created_at").eq("id", orderId).eq("clinic_id", clinicId).single(),
    db.from("lab_order_items").select("test_code, test_name, price_snapshot").eq("order_id", orderId).eq("clinic_id", clinicId).eq("status", "active").order("test_name"),
  ]);
  const { data: meta } = await db.from("payments").select("metadata").eq("id", payment.id).eq("clinic_id", clinicId).single();
  const method = (meta?.metadata as { method?: string } | null)?.method ?? null;
  return {
    fiscal: false,
    disclaimer: RECEIPT_DISCLAIMER,
    number: payment.id.slice(0, 8).toUpperCase(),
    clinic: { name: clinic?.name ?? "" },
    patient: { fullName: patient?.full_name ?? null },
    orderId,
    orderedAt: full?.created_at ?? "",
    items: (items ?? []).map((i) => ({ code: i.test_code, name: i.test_name, price: Number(i.price_snapshot) })),
    amount: Number(payment.amount),
    currency: payment.currency,
    status: payment.status,
    paidAt: payment.paid_at,
    method,
    refunded: payment.status === "refunded",
  };
}

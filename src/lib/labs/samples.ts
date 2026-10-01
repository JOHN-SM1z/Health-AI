import "server-only";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { ApiError } from "@/lib/api/errors";
import { logger } from "@/lib/logger";
import type { Database } from "@/lib/supabase/database.types";

/**
 * The laboratory worklist and sample collection (phase 5), for laboratory staff of the clinic.
 *
 * Order, payment and sample are three states in three tables. "Ready for collection" is DERIVED here from
 * them (never stored): an active order whose payment satisfies the clinic's policy. The policy and the
 * payment check that matter are applied INSIDE the database function that collects (lab_sample_transition,
 * which locks the sample and the payment), so a refund between "the worklist said ready" and "collect" cannot
 * be missed. This module authorises nothing by itself: the routes require laboratory staff, every query is
 * scoped by the session's clinic, and the phase-2 triggers re-check the actor's role.
 *
 * Shown to the technician: the patient's name (to label and identify the sample), the tests, sample types,
 * priority, the ordering doctor's name and the payment STATUS (never an amount). Never the doctor's note
 * (clinical text) and never a result.
 */

type SampleStatus = Database["public"]["Enums"]["lab_sample_status"];
type PaymentStatus = Database["public"]["Enums"]["payment_status"];

export type WorklistSample = { id: string; code: string; sampleType: string; status: SampleStatus; collectedAt: string | null; tests: string[] };
export type WorklistOrder = {
  orderId: string;
  createdAt: string;
  priority: string;
  orderStatus: string;
  patient: { id: string; fullName: string | null };
  orderedBy: string | null;
  tests: Array<{ name: string; sampleType: string | null }>;
  paymentStatus: PaymentStatus | null;
  /** "awaiting_payment": the clinic requires payment before collection and it is not paid; otherwise "ready". */
  readiness: "awaiting_payment" | "ready";
  samples: WorklistSample[];
};

export async function labCollectionRequiresPayment(clinicId: string): Promise<boolean> {
  const { data, error } = await createAdminClient().rpc("lab_collection_requires_payment", { p_clinic: clinicId });
  if (error) throw new ApiError(500, "Sozlamani o‘qib bo‘lmadi");
  return data === true;
}

export async function listWorklist(clinicId: string, limit = 100): Promise<{ requiresPayment: boolean; orders: WorklistOrder[] }> {
  const db = createAdminClient();
  const requiresPayment = await labCollectionRequiresPayment(clinicId);
  const { data, error } = await db
    .from("lab_orders")
    .select(
      "id, status, priority, created_at, patient_id, patients(id, full_name), doctors(name), lab_order_items(id, test_name, sample_type, status), lab_samples(id, sample_code, sample_type, status, collected_at, lab_sample_items(lab_order_items(test_name)))",
    )
    .eq("clinic_id", clinicId)
    .in("status", ["ordered", "in_progress"])
    .order("created_at", { ascending: true })
    .limit(Math.min(limit, 200));
  if (error) {
    logger.error("worklist failed", { code: error.code });
    throw new ApiError(500, "Ish ro‘yxatini yuklab bo‘lmadi");
  }
  const ids = (data ?? []).map((o) => o.id);
  const paymentOf = new Map<string, PaymentStatus>();
  if (ids.length) {
    const { data: payments } = await db.from("payments").select("lab_order_id, status").eq("clinic_id", clinicId).in("lab_order_id", ids);
    for (const p of payments ?? []) if (p.lab_order_id) paymentOf.set(p.lab_order_id, p.status);
  }

  type Row = {
    id: string;
    status: string;
    priority: string;
    created_at: string;
    patients: { id: string; full_name: string | null } | null;
    doctors: { name: string } | null;
    lab_order_items: Array<{ test_name: string; sample_type: string | null; status: string }>;
    lab_samples: Array<{
      id: string;
      sample_code: string;
      sample_type: string;
      status: SampleStatus;
      collected_at: string | null;
      lab_sample_items: Array<{ lab_order_items: { test_name: string } | null }>;
    }>;
  };
  const orders = ((data ?? []) as unknown as Row[]).map((o): WorklistOrder => {
    const paymentStatus = paymentOf.get(o.id) ?? null;
    return {
      orderId: o.id,
      createdAt: o.created_at,
      priority: o.priority,
      orderStatus: o.status,
      patient: { id: o.patients?.id ?? "", fullName: o.patients?.full_name ?? null },
      orderedBy: o.doctors?.name ?? null,
      tests: o.lab_order_items.filter((i) => i.status === "active").map((i) => ({ name: i.test_name, sampleType: i.sample_type })),
      paymentStatus,
      readiness: requiresPayment && paymentStatus !== "paid" ? "awaiting_payment" : "ready",
      samples: o.lab_samples
        .filter((s) => s.status !== "cancelled")
        .map((s) => ({
          id: s.id,
          code: s.sample_code,
          sampleType: s.sample_type,
          status: s.status,
          collectedAt: s.collected_at,
          tests: s.lab_sample_items.map((si) => si.lab_order_items?.test_name ?? "").filter(Boolean),
        })),
    };
  });
  // Urgent first, then oldest first.
  orders.sort((a, b) => Number(b.priority === "urgent") - Number(a.priority === "urgent") || a.createdAt.localeCompare(b.createdAt));
  return { requiresPayment, orders };
}

export const sampleActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("collect") }).strict(),
  z.object({ action: z.literal("process") }).strict(),
  z.object({ action: z.literal("cancel") }).strict(),
  z.object({ action: z.literal("reject"), reason: z.string().trim().min(3).max(300) }).strict(),
]);
export type SampleAction = z.infer<typeof sampleActionSchema>;
const TARGET: Record<SampleAction["action"], SampleStatus> = { collect: "collected", process: "processing", cancel: "cancelled", reject: "rejected" };

/** Maps a database refusal of a sample step to an API error, without echoing row data. */
function sampleError(error: { code?: string; message?: string }): ApiError {
  const m = error.message ?? "";
  if (m.includes("payment required")) return new ApiError(409, "Namuna olishdan oldin to‘lov qabul qilinishi kerak", "payment_required");
  if (m.includes("already collected by another")) return new ApiError(409, "Namuna boshqa xodim tomonidan olingan", "already_collected");
  if (m.includes("not found")) return new ApiError(404, "Topilmadi", "lab_not_found");
  if (m.includes("invalid status transition")) return new ApiError(409, "Namunaning joriy holatida bu amalni bajarib bo‘lmaydi", "invalid_transition");
  if (m.includes("order is") || m.includes("order is closed") || m.includes("no sample for an order")) return new ApiError(409, "Buyurtma yopilgan yoki bekor qilingan", "order_closed");
  if (m.includes("only lab staff")) return new ApiError(403, "Bu amal uchun ruxsat yo‘q", "forbidden");
  if (error.code === "23514") return new ApiError(400, "Qiymatlar noto‘g‘ri", "validation");
  logger.error("lab sample step failed", { code: error.code });
  return new ApiError(500, "Amalni bajarib bo‘lmadi", "lab_sample_failed");
}

/** Creates the awaiting-collection samples for an order's tests (one per sample type); idempotent. */
export async function createSamples(staff: { clinicId: string; profileId: string }, orderId: string): Promise<{ created: number }> {
  const db = createAdminClient();
  const { data: order } = await db.from("lab_orders").select("id, patient_id").eq("id", orderId).eq("clinic_id", staff.clinicId).maybeSingle();
  if (!order) throw new ApiError(404, "Buyurtma topilmadi", "lab_not_found");
  const { data, error } = await db.rpc("lab_create_samples", { p_clinic: staff.clinicId, p_actor: staff.profileId, p_order: orderId });
  if (error) throw sampleError(error);
  // Each sample's creation is audited by the database (lab_sample_created, ids only).
  const created = Number((data as { created?: number } | null)?.created ?? 0);
  return { created };
}

/** One step of a sample's lifecycle. Collection applies the clinic's payment policy inside the database. */
export async function moveSample(staff: { clinicId: string; profileId: string }, sampleId: string, input: SampleAction) {
  const { data, error } = await createAdminClient().rpc("lab_sample_transition", {
    p_clinic: staff.clinicId,
    p_actor: staff.profileId,
    p_sample: sampleId,
    p_to: TARGET[input.action],
    p_reason: (input.action === "reject" ? input.reason : null) as never,
  });
  if (error) throw sampleError(error);
  const result = data as { status: SampleStatus; unchanged: boolean };
  return { status: result.status, unchanged: result.unchanged };
}

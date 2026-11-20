import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { ApiError } from "@/lib/api/errors";
import { logger } from "@/lib/logger";
import { readPaged } from "@/lib/labs/paged";
import type { LabAnalyticsItem, LabAnalyticsOrder, LabPaymentStatus, LabRepeatHistory } from "@/lib/analytics/lab";

/**
 * Loads the rows for the laboratory management analytics (Phase 17) — the
 * lab counterpart of the appointments read in /api/admin/analytics. Reads
 * order, test, status, time and payment columns only: never result values,
 * flags, comments, documents or patient names. Patients are reduced to an
 * opaque key (the canonical record id, Phase 14) used only to count repeats.
 * Historical imports are not clinic activity and are left out.
 */

export const MAX_ORDERS = 20_000;
const ID_CHUNK = 300;

function loadFailed(what: string, error: { code?: string }) {
  logger.error(`lab analytics: ${what} failed`, { code: error.code });
  return new ApiError(500, "Laboratoriya tahlilini yuklab bo‘lmadi", "load_failed");
}

type OrderRow = {
  id: string;
  created_at: string;
  status: LabAnalyticsOrder["status"];
  source: string;
  cancel_reason: string | null;
  patient_id: string;
  payments: { status: LabPaymentStatus; amount: number | string; paid_at: string | null } | Array<{ status: LabPaymentStatus; amount: number | string; paid_at: string | null }> | null;
  lab_order_items: Array<{
    id: string;
    test_id: string;
    test_name_snapshot: string;
    price_snapshot: number | string;
    status: LabAnalyticsItem["status"];
    status_changed_at: string;
    lab_tests: { turnaround_hours: number | null; lab_test_categories: { name: string } | null } | null;
  }>;
};

async function chunked<T>(ids: string[], load: (chunk: string[]) => Promise<T[]>): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += ID_CHUNK) out.push(...(await load(ids.slice(i, i + ID_CHUNK))));
  return out;
}

export async function loadLabAnalyticsRows(
  clinicId: string,
  since: string,
  until: string | null,
  repeatWindowDays: number,
): Promise<{ orders: LabAnalyticsOrder[]; history: LabRepeatHistory; truncated: boolean }> {
  const db = createAdminClient();

  let read: { rows: OrderRow[]; truncated: boolean };
  try {
    read = await readPaged<OrderRow>((from, to) => {
      let q = db
        .from("lab_orders")
        .select(
          "id, created_at, status, source, cancel_reason, patient_id, " +
            "payments!payments_lab_order_fkey(status, amount, paid_at), " +
            "lab_order_items!lab_order_items_order_fkey(id, test_id, test_name_snapshot, price_snapshot, status, status_changed_at, " +
            "lab_tests!lab_order_items_test_fkey(turnaround_hours, lab_test_categories!lab_tests_category_fkey(name)))",
        )
        .eq("clinic_id", clinicId)
        .neq("source", "external_import")
        .gte("created_at", since);
      if (until) q = q.lt("created_at", until);
      return q.order("created_at", { ascending: true }).order("id").range(from, to);
    }, MAX_ORDERS);
  } catch (e) {
    throw loadFailed("orders", e as { code?: string });
  }
  const rows = read.rows;

  // Collection times of the verified tests (turnaround from collection).
  const verifiedIds = rows.flatMap((o) => o.lab_order_items.filter((i) => i.status === "verified").map((i) => i.id));
  const samples = await chunked(verifiedIds, async (chunk) => {
    const { data, error } = await db
      .from("lab_sample_items")
      .select("order_item_id, lab_samples!lab_sample_items_sample_fkey(collected_at, status)")
      .eq("clinic_id", clinicId)
      .in("order_item_id", chunk);
    if (error) throw loadFailed("samples", error);
    return (data ?? []) as unknown as Array<{ order_item_id: string; lab_samples: { collected_at: string; status: string } | null }>;
  });
  const collectedAt = new Map<string, string>();
  for (const s of samples) {
    if (!s.lab_samples || s.lab_samples.status === "rejected") continue;
    const prev = collectedAt.get(s.order_item_id);
    if (!prev || s.lab_samples.collected_at > prev) collectedAt.set(s.order_item_id, s.lab_samples.collected_at);
  }

  // Earlier orders in the look-back window, to recognise repeats at the start of the period.
  const lookbackFrom = new Date(Date.parse(since) - repeatWindowDays * 86_400_000).toISOString();
  let historyRows: Array<{ patient_id: string; test_id: string; created_at: string }>;
  try {
    historyRows = (
      await readPaged<{ patient_id: string; test_id: string; created_at: string }>(
        (from, to) =>
          db
            .from("lab_order_items")
            .select("patient_id, test_id, created_at, lab_orders!lab_order_items_order_fkey!inner(source)")
            .eq("clinic_id", clinicId)
            .neq("status", "cancelled")
            .neq("lab_orders.source", "external_import")
            .gte("created_at", lookbackFrom)
            .lt("created_at", since)
            .order("created_at")
            .order("id")
            .range(from, to),
        MAX_ORDERS,
      )
    ).rows;
  } catch (e) {
    throw loadFailed("history", e as { code?: string });
  }

  // One key per person: a record merged into another counts as that person.
  const patientIds = [...new Set([...rows.map((o) => o.patient_id), ...historyRows.map((h) => h.patient_id)])];
  const canonical = new Map<string, string>();
  for (const p of await chunked(patientIds, async (chunk) => {
    const { data, error } = await db.from("patients").select("id, merged_into_patient_id").eq("clinic_id", clinicId).in("id", chunk);
    if (error) throw loadFailed("patients", error);
    return data ?? [];
  })) {
    canonical.set(p.id, p.merged_into_patient_id ?? p.id);
  }
  const keyOf = (patientId: string) => canonical.get(patientId) ?? patientId;

  const orders: LabAnalyticsOrder[] = rows.map((o) => {
    const payment = Array.isArray(o.payments) ? (o.payments[0] ?? null) : o.payments;
    return {
      createdAt: o.created_at,
      status: o.status,
      source: o.source,
      cancelReason: o.cancel_reason,
      patientKey: keyOf(o.patient_id),
      payment: payment ? { status: payment.status, amount: Number(payment.amount), paidAt: payment.paid_at } : null,
      items: o.lab_order_items.map((i) => ({
        testId: i.test_id,
        testName: i.test_name_snapshot,
        category: i.lab_tests?.lab_test_categories?.name ?? null,
        price: Number(i.price_snapshot),
        status: i.status,
        statusChangedAt: i.status_changed_at,
        collectedAt: collectedAt.get(i.id) ?? null,
        targetHours: i.lab_tests?.turnaround_hours ?? null,
      })),
    };
  });
  return {
    orders,
    history: historyRows.map((h) => ({ patientKey: keyOf(h.patient_id), testId: h.test_id, createdAt: h.created_at })),
    truncated: read.truncated,
  };
}

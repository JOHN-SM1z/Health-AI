import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { ApiError } from "@/lib/api/errors";
import { recordAudits } from "@/lib/audit";
import { logger } from "@/lib/logger";
import type { LinkedDoctor } from "@/lib/auth/guards";
import { formatRange } from "@/lib/labs/values";
import { readPaged } from "@/lib/labs/paged";

/**
 * The doctor's laboratory dashboard (Phase 17).
 *
 * Every patient shown passes doctor_patient_access() — own patient or an
 * active, unexpired referral — evaluated in the database for the whole set
 * (lab_doctor_accessible_patients), on every request. A patient whose access
 * has ended disappears, even from the doctor's own past orders. Never
 * clinic-wide.
 *
 *  * myOrders / pending — orders this doctor placed: status only;
 *  * recentResults      — VERIFIED results of the doctor's patients from the
 *                         last 30 days (whoever ordered them, O3), with the
 *                         number of values outside the configured range and
 *                         the date of the previous comparable result (same
 *                         test, same person);
 *  * abnormal           — the values of those results that sit outside the
 *                         configured range, critical first. Placement against
 *                         the range only: no interpretation, no advice, and no
 *                         alerting (critical-result alerts remain deferred).
 *
 * Results whose flags or values are returned are audited (lab_result_viewed,
 * via doctor_dashboard, ids only) before the response is sent.
 */

export const WINDOW_DAYS = 30;
const ORDER_LIMIT = 20;
const PENDING_LIMIT = 50;
const RESULT_LIMIT = 30;
const RESULT_SCAN = 3000;
const ID_CHUNK = 300;
const OUT_OF_RANGE = ["low", "high", "critical_low", "critical_high", "abnormal"];
const CRITICAL = ["critical_low", "critical_high"];

export type DoctorLabDashboard = {
  windowDays: number;
  myOrders: Array<{ orderId: string; createdAt: string; status: string; patientId: string; patientName: string | null; tests: Array<{ name: string; status: string }> }>;
  pending: Array<{ itemId: string; testName: string; status: string; orderedAt: string; patientId: string; patientName: string | null }>;
  pendingCount: number;
  recentResults: Array<{
    resultId: string;
    patientId: string;
    patientName: string | null;
    testName: string;
    verifiedAt: string;
    corrected: boolean;
    outOfRange: number;
    critical: boolean;
    previousVerifiedAt: string | null;
  }>;
  abnormal: Array<{
    resultId: string;
    patientId: string;
    patientName: string | null;
    testName: string;
    verifiedAt: string;
    parameter: string;
    value: string;
    unit: string | null;
    range: string | null;
    flag: string;
  }>;
};

function loadFailed(what: string, error: { code?: string }) {
  logger.error(`doctor lab dashboard: ${what} failed`, { code: error.code });
  return new ApiError(500, "Laboratoriya ma’lumotlarini yuklab bo‘lmadi", "load_failed");
}

async function chunked<T>(ids: string[], load: (chunk: string[]) => Promise<T[]>): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += ID_CHUNK) out.push(...(await load(ids.slice(i, i + ID_CHUNK))));
  return out;
}

/** The patients of `candidates` this doctor may see right now (doctor_patient_access, in the database). */
async function accessible(doctor: LinkedDoctor, candidates: string[]): Promise<Set<string>> {
  const unique = [...new Set(candidates)];
  if (unique.length === 0) return new Set();
  const allowed = new Set<string>();
  for (let i = 0; i < unique.length; i += 5000) {
    const { data, error } = await createAdminClient().rpc("lab_doctor_accessible_patients", {
      p_clinic_id: doctor.clinicId,
      p_doctor_id: doctor.doctorId,
      p_patient_ids: unique.slice(i, i + 5000),
    });
    if (error) {
      logger.error("doctor lab dashboard: access check failed", { code: error.code });
      throw new ApiError(503, "Ruxsatni tekshirib bo‘lmadi, keyinroq urinib ko‘ring", "access_check_failed");
    }
    for (const id of (data ?? []) as string[]) allowed.add(id);
  }
  return allowed;
}

export async function getDoctorLabDashboard(doctor: LinkedDoctor, now = new Date()): Promise<DoctorLabDashboard> {
  const db = createAdminClient();
  const since = new Date(now.getTime() - WINDOW_DAYS * 86_400_000).toISOString();

  const [ordersRes, pendingRes] = await Promise.all([
    db
      .from("lab_orders")
      .select("id, created_at, status, patient_id, lab_order_items!lab_order_items_order_fkey(test_name_snapshot, status)")
      .eq("clinic_id", doctor.clinicId)
      .eq("ordering_doctor_id", doctor.doctorId)
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(200),
    db
      .from("lab_order_items")
      .select("id, test_name_snapshot, status, created_at, patient_id, lab_orders!lab_order_items_order_fkey!inner(ordering_doctor_id, status)")
      .eq("clinic_id", doctor.clinicId)
      .eq("lab_orders.ordering_doctor_id", doctor.doctorId)
      .eq("lab_orders.status", "active")
      .in("status", ["ordered", "ready_for_collection", "collected", "processing", "resulted"])
      .order("created_at", { ascending: true })
      .limit(1000),
  ]);
  if (ordersRes.error) throw loadFailed("orders", ordersRes.error);
  if (pendingRes.error) throw loadFailed("pending", pendingRes.error);
  type OrderRow = { id: string; created_at: string; status: string; patient_id: string; lab_order_items: Array<{ test_name_snapshot: string; status: string }> };
  type PendingRow = { id: string; test_name_snapshot: string; status: string; created_at: string; patient_id: string };
  const orderRows = (ordersRes.data ?? []) as unknown as OrderRow[];
  const pendingRows = (pendingRes.data ?? []) as unknown as PendingRow[];

  let resultScan: Array<{ id: string; patient_id: string }>;
  try {
    resultScan = (
      await readPaged<{ id: string; patient_id: string }>(
        (from, to) =>
          db
            .from("lab_results")
            .select("id, patient_id")
            .eq("clinic_id", doctor.clinicId)
            .eq("status", "verified")
            .gte("verified_at", since)
            .order("verified_at", { ascending: false })
            .order("id")
            .range(from, to),
        RESULT_SCAN,
      )
    ).rows;
  } catch (e) {
    throw loadFailed("results", e as { code?: string });
  }

  const allowed = await accessible(doctor, [...orderRows.map((o) => o.patient_id), ...pendingRows.map((p) => p.patient_id), ...resultScan.map((r) => r.patient_id)]);
  const myOrders = orderRows.filter((o) => allowed.has(o.patient_id)).slice(0, ORDER_LIMIT);
  const pendingAllowed = pendingRows.filter((p) => allowed.has(p.patient_id));
  const resultIds = resultScan.filter((r) => allowed.has(r.patient_id)).slice(0, RESULT_LIMIT).map((r) => r.id);

  type ResultRow = {
    id: string;
    patient_id: string;
    order_item_id: string;
    verified_at: string;
    supersedes_result_id: string | null;
    lab_order_items: { test_id: string; test_name_snapshot: string } | null;
    lab_result_values: Array<{
      value_numeric: number | string | null;
      value_text: string | null;
      value_boolean: boolean | null;
      unit_snapshot: string | null;
      flag: string;
      range_low: number | string | null;
      range_high: number | string | null;
      range_text: string | null;
      lab_test_parameters: { name: string; sort_order: number } | null;
    }>;
  };
  const results = resultIds.length
    ? await chunked(resultIds, async (chunk) => {
        const { data, error } = await db
          .from("lab_results")
          .select(
            "id, patient_id, order_item_id, verified_at, supersedes_result_id, " +
              "lab_order_items!lab_results_item_fkey(test_id, test_name_snapshot), " +
              "lab_result_values(value_numeric, value_text, value_boolean, unit_snapshot, flag, range_low, range_high, range_text, lab_test_parameters(name, sort_order))",
          )
          .eq("clinic_id", doctor.clinicId)
          .eq("status", "verified")
          .in("id", chunk);
        if (error) throw loadFailed("result details", error);
        return (data ?? []) as unknown as ResultRow[];
      })
    : [];
  results.sort((a, b) => (a.verified_at < b.verified_at ? 1 : -1));

  // Patient names and record groups (Phase 14: a person's merged records are one).
  const shownPatients = [...new Set([...myOrders.map((o) => o.patient_id), ...pendingAllowed.slice(0, PENDING_LIMIT).map((p) => p.patient_id), ...results.map((r) => r.patient_id)])];
  const people = await chunked(shownPatients, async (chunk) => {
    const { data, error } = await db.from("patients").select("id, full_name, merged_into_patient_id").eq("clinic_id", doctor.clinicId).in("id", chunk);
    if (error) throw loadFailed("patients", error);
    return data ?? [];
  });
  const nameOf = new Map(people.map((p) => [p.id, p.full_name as string | null]));
  const canonicalOf = new Map(people.map((p) => [p.id, (p.merged_into_patient_id as string | null) ?? p.id]));

  // The previous comparable result: the latest earlier verified result of the same test for the same person.
  const resultPatients = [...new Set(results.map((r) => canonicalOf.get(r.patient_id) ?? r.patient_id))];
  const groupMembers = resultPatients.length
    ? await chunked(resultPatients, async (chunk) => {
        const { data, error } = await db
          .from("patients")
          .select("id, merged_into_patient_id")
          .eq("clinic_id", doctor.clinicId)
          .or(`id.in.(${chunk.join(",")}),merged_into_patient_id.in.(${chunk.join(",")})`);
        if (error) throw loadFailed("record groups", error);
        return data ?? [];
      })
    : [];
  for (const m of groupMembers) canonicalOf.set(m.id, (m.merged_into_patient_id as string | null) ?? m.id);
  const testIds = [...new Set(results.map((r) => r.lab_order_items?.test_id).filter((t): t is string => Boolean(t)))];
  const earlier = groupMembers.length && testIds.length
    ? await chunked(groupMembers.map((m) => m.id), async (chunk) => {
        const { data, error } = await db
          .from("lab_results")
          .select("id, patient_id, verified_at, lab_order_items!lab_results_item_fkey!inner(test_id)")
          .eq("clinic_id", doctor.clinicId)
          .eq("status", "verified")
          .in("patient_id", chunk)
          .in("lab_order_items.test_id", testIds)
          .order("verified_at", { ascending: false })
          .limit(1000);
        if (error) throw loadFailed("previous results", error);
        return (data ?? []) as unknown as Array<{ id: string; patient_id: string; verified_at: string; lab_order_items: { test_id: string } | null }>;
      })
    : [];

  const display = (v: ResultRow["lab_result_values"][number]) =>
    v.value_numeric !== null ? String(v.value_numeric) : v.value_boolean !== null ? (v.value_boolean ? "Ha" : "Yo‘q") : (v.value_text ?? "—");

  const recentResults: DoctorLabDashboard["recentResults"] = [];
  const abnormal: DoctorLabDashboard["abnormal"] = [];
  for (const r of results) {
    const person = canonicalOf.get(r.patient_id) ?? r.patient_id;
    const testId = r.lab_order_items?.test_id;
    const previous = earlier
      .filter((e) => e.id !== r.id && e.lab_order_items?.test_id === testId && (canonicalOf.get(e.patient_id) ?? e.patient_id) === person && e.verified_at < r.verified_at)
      .sort((a, b) => (a.verified_at < b.verified_at ? 1 : -1))[0];
    const out = r.lab_result_values.filter((v) => OUT_OF_RANGE.includes(v.flag));
    const testName = r.lab_order_items?.test_name_snapshot ?? "—";
    recentResults.push({
      resultId: r.id,
      patientId: person,
      patientName: nameOf.get(r.patient_id) ?? null,
      testName,
      verifiedAt: r.verified_at,
      corrected: r.supersedes_result_id !== null,
      outOfRange: out.length,
      critical: out.some((v) => CRITICAL.includes(v.flag)),
      previousVerifiedAt: previous?.verified_at ?? null,
    });
    for (const v of [...out].sort((a, b) => (a.lab_test_parameters?.sort_order ?? 0) - (b.lab_test_parameters?.sort_order ?? 0))) {
      abnormal.push({
        resultId: r.id,
        patientId: person,
        patientName: nameOf.get(r.patient_id) ?? null,
        testName,
        verifiedAt: r.verified_at,
        parameter: v.lab_test_parameters?.name ?? "—",
        value: display(v),
        unit: v.unit_snapshot,
        range: formatRange({ low: v.range_low, high: v.range_high, text: v.range_text }),
        flag: v.flag,
      });
    }
  }
  abnormal.sort((a, b) => Number(CRITICAL.includes(b.flag)) - Number(CRITICAL.includes(a.flag)) || (a.verifiedAt < b.verifiedAt ? 1 : -1));

  if (results.length > 0) {
    await recordAudits(
      results.map((r) => ({
        clinicId: doctor.clinicId,
        action: "lab_result_viewed",
        entityType: "lab_results",
        entityId: r.id,
        patientId: r.patient_id,
        actor: { actorId: doctor.profileId, actorType: "staff" as const },
        metadata: { order_item_id: r.order_item_id, via: "doctor_dashboard" },
      })),
      { strict: true },
    );
  }

  return {
    windowDays: WINDOW_DAYS,
    myOrders: myOrders.map((o) => ({
      orderId: o.id,
      createdAt: o.created_at,
      status: o.status,
      patientId: canonicalOf.get(o.patient_id) ?? o.patient_id,
      patientName: nameOf.get(o.patient_id) ?? null,
      tests: o.lab_order_items.map((i) => ({ name: i.test_name_snapshot, status: i.status })),
    })),
    pending: pendingAllowed.slice(0, PENDING_LIMIT).map((p) => ({
      itemId: p.id,
      testName: p.test_name_snapshot,
      status: p.status,
      orderedAt: p.created_at,
      patientId: canonicalOf.get(p.patient_id) ?? p.patient_id,
      patientName: nameOf.get(p.patient_id) ?? null,
    })),
    pendingCount: pendingAllowed.length,
    recentResults,
    abnormal,
  };
}

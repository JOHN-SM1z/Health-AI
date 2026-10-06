import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { ApiError } from "@/lib/api/errors";
import { logger } from "@/lib/logger";
import { localDayWindow } from "@/lib/time/local";
import { NO_CATEGORY } from "@/lib/analytics/lab";
import { readPaged } from "@/lib/labs/paged";

/**
 * The laboratory's current work, by stage (Phase 17) — what the lab staff
 * dashboard shows and what management sees as "pending work".
 *
 * STATUS ONLY: counts, waiting times and test categories. No patient, no
 * result value, no flag, no amount — so every role allowed to see the work
 * queue (queue.read) may see it. Historical imports are not work and are
 * left out.
 *
 * Every open test is in exactly one stage:
 *   awaitingCollection    ordered / ready for collection
 *   inTransit             sample collected, not yet started in the lab
 *   awaitingEntry         in the lab, no result started, not sent out
 *   inProgress            in the lab with a draft result, or at an external laboratory
 *   awaitingVerification  result submitted, waiting for a second person
 */

export const WORK_STAGES = ["awaitingCollection", "inTransit", "awaitingEntry", "inProgress", "awaitingVerification"] as const;
export type WorkStage = (typeof WORK_STAGES)[number];

export type LabWorkload = {
  activeOrders: number;
  stages: Record<WorkStage, { count: number; oldestSince: string | null }>;
  completedToday: number;
  completedLast7Days: number;
  /** Open tests past their test's target turnaround, counted from collection. */
  overdue: number;
  byCategory: Array<{ name: string; open: number }>;
  /** True when there were more open tests than one read covers (counts are then lower bounds). */
  truncated: boolean;
};

const OPEN_LIMIT = 5000;
const ID_CHUNK = 300;

function loadFailed(what: string, error: { code?: string }) {
  logger.error(`lab workload: ${what} failed`, { code: error.code });
  return new ApiError(500, "Laboratoriya ko‘rsatkichlarini yuklab bo‘lmadi", "load_failed");
}

async function inChunks<T>(ids: string[], load: (chunk: string[]) => Promise<T[]>): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += ID_CHUNK) out.push(...(await load(ids.slice(i, i + ID_CHUNK))));
  return out;
}

export async function loadLabWorkload(clinicId: string, clinicTimezone: string, now = new Date()): Promise<LabWorkload> {
  const db = createAdminClient();
  const sevenDaysAgo = new Date(now.getTime() - 7 * 86_400_000).toISOString();
  const today = localDayWindow(clinicTimezone, now);

  type Open = {
    id: string;
    status: string;
    status_changed_at: string;
    lab_tests: { turnaround_hours: number | null; lab_test_categories: { name: string } | null } | null;
  };
  const verifiedSince = (since: string, until?: string) => {
    let q = db
      .from("lab_order_items")
      .select("id, lab_orders!lab_order_items_order_fkey!inner(source)", { count: "exact", head: true })
      .eq("clinic_id", clinicId)
      .eq("status", "verified")
      .gte("status_changed_at", since)
      .neq("lab_orders.source", "external_import");
    if (until) q = q.lt("status_changed_at", until);
    return q;
  };

  let openRead: { rows: Open[]; truncated: boolean };
  try {
    openRead = await readPaged<Open>(
      (from, to) =>
        db
          .from("lab_order_items")
          .select("id, status, status_changed_at, lab_tests!lab_order_items_test_fkey(turnaround_hours, lab_test_categories!lab_tests_category_fkey(name)), lab_orders!lab_order_items_order_fkey!inner(source)")
          .eq("clinic_id", clinicId)
          .in("status", ["ordered", "ready_for_collection", "collected", "processing", "resulted"])
          .neq("lab_orders.source", "external_import")
          .order("status_changed_at", { ascending: true })
          .order("id")
          .range(from, to),
      OPEN_LIMIT,
    );
  } catch (e) {
    throw loadFailed("open tests", e as { code?: string });
  }
  const [ordersRes, todayRes, weekRes] = await Promise.all([
    db.from("lab_orders").select("id", { count: "exact", head: true }).eq("clinic_id", clinicId).eq("status", "active").neq("source", "external_import"),
    verifiedSince(today.start, today.end),
    verifiedSince(sevenDaysAgo),
  ]);
  if (ordersRes.error) throw loadFailed("orders", ordersRes.error);
  if (todayRes.error || weekRes.error) throw loadFailed("completed tests", (todayRes.error ?? weekRes.error)!);

  const { rows: open, truncated } = openRead;
  const inLab = open.filter((i) => i.status === "processing").map((i) => i.id);
  const collected = open.filter((i) => ["collected", "processing", "resulted"].includes(i.status)).map((i) => i.id);

  const [drafts, sendOuts, samples] = await Promise.all([
    inChunks(inLab, async (chunk) => {
      const { data, error } = await db.from("lab_results").select("order_item_id").eq("clinic_id", clinicId).in("order_item_id", chunk).eq("status", "draft");
      if (error) throw loadFailed("drafts", error);
      return data ?? [];
    }),
    inChunks(inLab, async (chunk) => {
      const { data, error } = await db
        .from("lab_external_requests")
        .select("order_item_id")
        .eq("clinic_id", clinicId)
        .in("order_item_id", chunk)
        .in("status", ["queued", "sent", "in_progress"]);
      if (error) throw loadFailed("send-outs", error);
      return data ?? [];
    }),
    inChunks(collected, async (chunk) => {
      const { data, error } = await db
        .from("lab_sample_items")
        .select("order_item_id, lab_samples!lab_sample_items_sample_fkey(collected_at, status)")
        .eq("clinic_id", clinicId)
        .in("order_item_id", chunk);
      if (error) throw loadFailed("samples", error);
      return (data ?? []) as unknown as Array<{ order_item_id: string; lab_samples: { collected_at: string; status: string } | null }>;
    }),
  ]);
  const started = new Set([...drafts, ...sendOuts].map((r) => r.order_item_id));
  const collectedAt = new Map<string, string>();
  for (const s of samples) {
    if (!s.lab_samples || s.lab_samples.status === "rejected") continue;
    const prev = collectedAt.get(s.order_item_id);
    if (!prev || s.lab_samples.collected_at > prev) collectedAt.set(s.order_item_id, s.lab_samples.collected_at);
  }

  const stages = Object.fromEntries(WORK_STAGES.map((s) => [s, { count: 0, oldestSince: null as string | null }])) as LabWorkload["stages"];
  const byCategory = new Map<string, number>();
  let overdue = 0;
  for (const item of open) {
    const stage: WorkStage =
      item.status === "ordered" || item.status === "ready_for_collection"
        ? "awaitingCollection"
        : item.status === "collected"
          ? "inTransit"
          : item.status === "resulted"
            ? "awaitingVerification"
            : started.has(item.id)
              ? "inProgress"
              : "awaitingEntry";
    const s = stages[stage];
    s.count += 1;
    if (!s.oldestSince || item.status_changed_at < s.oldestSince) s.oldestSince = item.status_changed_at;
    const category = item.lab_tests?.lab_test_categories?.name ?? NO_CATEGORY;
    byCategory.set(category, (byCategory.get(category) ?? 0) + 1);
    const target = item.lab_tests?.turnaround_hours;
    const since = collectedAt.get(item.id);
    if (target && since && now.getTime() - Date.parse(since) > target * 3_600_000) overdue += 1;
  }

  return {
    activeOrders: ordersRes.count ?? 0,
    stages,
    completedToday: todayRes.count ?? 0,
    completedLast7Days: weekRes.count ?? 0,
    overdue,
    byCategory: [...byCategory.entries()].sort((a, b) => b[1] - a[1]).map(([name, n]) => ({ name, open: n })),
    truncated,
  };
}

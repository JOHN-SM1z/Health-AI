import { clinicDateKey } from "@/lib/time/local";
import { monthKeyFromDayKey, weekKeyFromDayKey } from "@/lib/analytics/aggregate";

/**
 * Laboratory management analytics (Phase 17) — the lab counterpart of
 * aggregateAppointments(), with the same rules:
 *
 *  * Pure: rows in, figures out. The rows carry ORDER, TEST, STATUS, TIME and
 *    PAYMENT facts only — never a result value, flag, comment or patient
 *    identifier (a patient is an opaque key used only to count repeats).
 *  * Revenue comes from the authoritative payment record, never the catalog:
 *    a lab order's payment (payments.lab_order_id) is recognized only when it
 *    is "paid" AND the work was delivered (the test verified) — the lab
 *    analogue of "completed and paid". The paid amount is allocated to the
 *    order's tests by the prices stored on the order at ordering time
 *    (price_snapshot, which already holds a panel's allocated share); if
 *    those do not add up to the paid amount the shares are scaled so the
 *    figures always add up to the money actually received. A later change of
 *    the catalog price changes nothing here.
 *  * A refund moves the payment away from "paid" and so drops out of every
 *    revenue figure, as for appointments.
 *
 * Paid money is split three ways, which always add up to the paid total:
 *   recognized         — paid, test verified (delivered);
 *   prepaidInProgress  — paid, test still being done;
 *   toRefund           — paid, test cancelled after payment (the Kassa shows
 *                        these as "Qaytarish kerak").
 */

export type LabItemStatus = "ordered" | "ready_for_collection" | "collected" | "processing" | "resulted" | "verified" | "cancelled";
export type LabPaymentStatus = "unpaid" | "pending" | "paid" | "failed" | "refunded" | "manual_review";

export type LabAnalyticsItem = {
  testId: string;
  testName: string;
  category: string | null;
  /** Stored at ordering time (catalog or allocated panel share). */
  price: number;
  status: LabItemStatus;
  statusChangedAt: string;
  /** When the sample holding this test was collected, if it was. */
  collectedAt: string | null;
  /** The test's target turnaround in hours (catalog), if configured. */
  targetHours: number | null;
};

export type LabAnalyticsOrder = {
  createdAt: string;
  status: "active" | "completed" | "cancelled";
  source: string;
  cancelReason: string | null;
  /** Opaque per-person key (canonical patient id); only counted, never returned. */
  patientKey: string;
  payment: { status: LabPaymentStatus; amount: number; paidAt: string | null } | null;
  items: LabAnalyticsItem[];
};

/** Earlier orders (a look-back window before the range) used to recognise repeats. */
export type LabRepeatHistory = Array<{ patientKey: string; testId: string; createdAt: string }>;

export type DurationStats = { count: number; medianHours: number | null; p90Hours: number | null };

export type LabAggregate = {
  orders: number;
  tests: number;
  bySource: Array<[string, number]>;
  byItemStatus: Array<[string, number]>;
  byTest: Array<{ name: string; count: number }>;
  byCategory: Array<{ name: string; count: number }>;
  volumeTrend: Array<{ date: string; tests: number }>;
  cancelledOrders: number;
  cancelledTests: number;
  cancellationRate: number;
  cancelReasons: Array<{ reason: string; count: number }>;
  turnaround: {
    orderToVerified: DurationStats;
    collectedToVerified: DurationStats;
    /** Verified tests with a target: within it / late. */
    onTime: number;
    late: number;
    byTest: Array<{ name: string } & DurationStats>;
  };
  repeats: { repeatedTests: number; rate: number; windowDays: number; byTest: Array<{ name: string; count: number }> };
  finance: {
    paidTotal: number;
    recognized: number;
    prepaidInProgress: number;
    toRefund: number;
    refunded: number;
    unpaid: number;
    pending: number;
    paidOrders: number;
    averagePaidOrder: number;
    revenueByTest: Array<{ name: string; revenue: number; count: number }>;
    revenueByCategory: Array<{ name: string; revenue: number }>;
    revenueTrend: Array<{ date: string; revenue: number }>;
    revenueByWeek: Array<{ key: string; revenue: number }>;
    revenueByMonth: Array<{ key: string; revenue: number }>;
  };
};

export const NO_CATEGORY = "Bo‘limsiz";
const NO_REASON = "Sabab ko‘rsatilmagan";
const HOUR = 3_600_000;

const money = (n: number) => Math.round(n * 100) / 100;
const hours = (n: number) => Math.round(n * 10) / 10;

function percent(part: number, whole: number): number {
  if (whole <= 0) return 0;
  return Math.round((part / whole) * 1000) / 10;
}

/** Nearest-rank percentile of sorted values. */
function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[rank - 1];
}

export function durationStats(values: number[]): DurationStats {
  const sorted = [...values].sort((a, b) => a - b);
  const median = percentile(sorted, 50);
  const p90 = percentile(sorted, 90);
  return { count: sorted.length, medianHours: median === null ? null : hours(median), p90Hours: p90 === null ? null : hours(p90) };
}

const bump = <K>(map: Map<K, number>, key: K, by = 1) => map.set(key, (map.get(key) ?? 0) + by);
const desc = <K>(map: Map<K, number>) => [...map.entries()].sort((a, b) => b[1] - a[1]);
const byKey = <T extends string>(map: Map<T, number>) => [...map.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));

/**
 * Splits a paid payment over the order's tests: the tests it paid for (all
 * but those cancelled before it was paid) by their stored prices, scaled so
 * the shares add up to the paid amount exactly.
 */
export function allocatePayment(amount: number, paidAt: string | null, items: LabAnalyticsItem[]): Array<{ item: LabAnalyticsItem; share: number }> {
  const paidAtMs = paidAt ? Date.parse(paidAt) : Number.POSITIVE_INFINITY;
  const billed = items.filter((i) => !(i.status === "cancelled" && Date.parse(i.statusChangedAt) < paidAtMs));
  const stored = billed.reduce((s, i) => s + Number(i.price), 0);
  if (billed.length === 0) return [];
  if (stored <= 0) {
    // Nothing to weight by: split evenly.
    return billed.map((item) => ({ item, share: amount / billed.length }));
  }
  const scale = amount / stored;
  return billed.map((item) => ({ item, share: Number(item.price) * scale }));
}

export function aggregateLabOrders(
  orders: LabAnalyticsOrder[],
  history: LabRepeatHistory,
  clinicTimezone: string,
  opts: { topN?: number; repeatWindowDays?: number } = {},
): LabAggregate {
  const topN = opts.topN ?? 10;
  const windowDays = opts.repeatWindowDays ?? 30;

  const bySource = new Map<string, number>();
  const byItemStatus = new Map<string, number>();
  const byTest = new Map<string, number>();
  const byCategory = new Map<string, number>();
  const volumeTrend = new Map<string, number>();
  const cancelReasons = new Map<string, number>();
  const tatOrder: number[] = [];
  const tatCollected: number[] = [];
  const tatByTest = new Map<string, number[]>();
  let onTime = 0;
  let late = 0;
  let tests = 0;
  let cancelledOrders = 0;
  let cancelledTests = 0;

  const fin = { paidTotal: 0, recognized: 0, prepaid: 0, toRefund: 0, refunded: 0, unpaid: 0, pending: 0, paidOrders: 0 };
  const revenueByTest = new Map<string, { revenue: number; count: number }>();
  const revenueByCategory = new Map<string, number>();
  const revenueTrend = new Map<string, number>();
  const revenueByWeek = new Map<string, number>();
  const revenueByMonth = new Map<string, number>();

  // Repeats: the same person, the same test, within the window before it.
  const seen = new Map<string, number[]>();
  const remember = (patientKey: string, testId: string, at: number) => {
    const key = `${patientKey}|${testId}`;
    const list = seen.get(key) ?? [];
    list.push(at);
    seen.set(key, list);
  };
  for (const h of history) remember(h.patientKey, h.testId, Date.parse(h.createdAt));
  const repeatsByTest = new Map<string, number>();
  let repeatedTests = 0;
  const chronological = [...orders].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));

  for (const order of chronological) {
    const created = Date.parse(order.createdAt);
    const day = clinicDateKey(clinicTimezone, new Date(order.createdAt));
    bump(bySource, order.source);
    if (order.status === "cancelled") {
      cancelledOrders += 1;
      bump(cancelReasons, (order.cancelReason ?? "").trim() || NO_REASON);
    }

    for (const item of order.items) {
      tests += 1;
      bump(byItemStatus, item.status);
      bump(volumeTrend, day);
      if (item.status === "cancelled") {
        cancelledTests += 1;
        continue;
      }
      bump(byTest, item.testName);
      bump(byCategory, item.category ?? NO_CATEGORY);

      const key = `${order.patientKey}|${item.testId}`;
      const earlier = (seen.get(key) ?? []).filter((t) => t < created && created - t <= windowDays * 86_400_000);
      if (earlier.length > 0) {
        repeatedTests += 1;
        bump(repeatsByTest, item.testName);
      }
      remember(order.patientKey, item.testId, created);

      if (item.status === "verified") {
        const verified = Date.parse(item.statusChangedAt);
        const fromOrder = (verified - created) / HOUR;
        tatOrder.push(fromOrder);
        const list = tatByTest.get(item.testName) ?? [];
        list.push(fromOrder);
        tatByTest.set(item.testName, list);
        if (item.collectedAt) {
          const fromCollection = (verified - Date.parse(item.collectedAt)) / HOUR;
          tatCollected.push(fromCollection);
          if (item.targetHours !== null && item.targetHours > 0) {
            if (fromCollection <= item.targetHours) onTime += 1;
            else late += 1;
          }
        }
      }
    }

    const payment = order.payment;
    if (!payment) continue;
    const amount = Number(payment.amount);
    // As for appointments: a failed attempt never held money, so it is in no total.
    if (payment.status === "unpaid") fin.unpaid += amount;
    else if (payment.status === "pending" || payment.status === "manual_review") fin.pending += amount;
    else if (payment.status === "refunded") fin.refunded += amount;
    else if (payment.status === "paid") {
      fin.paidTotal += amount;
      fin.paidOrders += 1;
      const shares = allocatePayment(amount, payment.paidAt, order.items);
      if (shares.length === 0) fin.prepaid += amount; // nothing billable left to attribute to
      for (const { item, share } of shares) {
        if (item.status === "verified") {
          fin.recognized += share;
          const t = revenueByTest.get(item.testName) ?? { revenue: 0, count: 0 };
          t.revenue += share;
          t.count += 1;
          revenueByTest.set(item.testName, t);
          bump(revenueByCategory, item.category ?? NO_CATEGORY, share);
          bump(revenueTrend, day, share);
          bump(revenueByWeek, weekKeyFromDayKey(day), share);
          bump(revenueByMonth, monthKeyFromDayKey(day), share);
        } else if (item.status === "cancelled") {
          fin.toRefund += share;
        } else {
          fin.prepaid += share;
        }
      }
    }
  }

  const live = tests - cancelledTests;
  return {
    orders: orders.length,
    tests,
    bySource: desc(bySource),
    byItemStatus: desc(byItemStatus),
    byTest: desc(byTest).slice(0, topN).map(([name, count]) => ({ name, count })),
    byCategory: desc(byCategory).map(([name, count]) => ({ name, count })),
    volumeTrend: byKey(volumeTrend).map(([date, n]) => ({ date, tests: n })),
    cancelledOrders,
    cancelledTests,
    cancellationRate: percent(cancelledTests, tests),
    cancelReasons: desc(cancelReasons).slice(0, topN).map(([reason, count]) => ({ reason, count })),
    turnaround: {
      orderToVerified: durationStats(tatOrder),
      collectedToVerified: durationStats(tatCollected),
      onTime,
      late,
      byTest: [...tatByTest.entries()]
        .sort((a, b) => b[1].length - a[1].length)
        .slice(0, topN)
        .map(([name, values]) => ({ name, ...durationStats(values) })),
    },
    repeats: {
      repeatedTests,
      rate: percent(repeatedTests, live),
      windowDays,
      byTest: desc(repeatsByTest).slice(0, topN).map(([name, count]) => ({ name, count })),
    },
    finance: {
      paidTotal: money(fin.paidTotal),
      recognized: money(fin.recognized),
      prepaidInProgress: money(fin.prepaid),
      toRefund: money(fin.toRefund),
      refunded: money(fin.refunded),
      unpaid: money(fin.unpaid),
      pending: money(fin.pending),
      paidOrders: fin.paidOrders,
      averagePaidOrder: fin.paidOrders > 0 ? Math.round(fin.paidTotal / fin.paidOrders) : 0,
      revenueByTest: [...revenueByTest.entries()]
        .sort((a, b) => b[1].revenue - a[1].revenue)
        .slice(0, topN)
        .map(([name, v]) => ({ name, revenue: money(v.revenue), count: v.count })),
      revenueByCategory: desc(revenueByCategory).map(([name, revenue]) => ({ name, revenue: money(revenue) })),
      revenueTrend: byKey(revenueTrend).map(([date, revenue]) => ({ date, revenue: money(revenue) })),
      revenueByWeek: byKey(revenueByWeek).map(([key, revenue]) => ({ key, revenue: money(revenue) })),
      revenueByMonth: byKey(revenueByMonth).map(([key, revenue]) => ({ key, revenue: money(revenue) })),
    },
  };
}

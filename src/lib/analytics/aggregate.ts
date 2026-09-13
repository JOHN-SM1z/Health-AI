import type { Database } from "@/lib/supabase/database.types";
import { clinicDateKey } from "@/lib/time/local";

export type AnalyticsRow = {
  id: string;
  source: Database["public"]["Enums"]["appointment_source"];
  status: Database["public"]["Enums"]["appointment_status"];
  cancelled_reason: string | null;
  no_show_reason: string | null;
  start_at: string;
  patients: { full_name: string } | null;
  services: { name: string; price: number } | null;
  doctors: { name: string } | null;
  payments: {
    status: Database["public"]["Enums"]["payment_status"];
    amount: number;
    // Optional only so existing fixtures that predate this field keep
    // compiling; every real row from the database always has one (NOT NULL
    // column) — defaults to "manual" below, matching what every current
    // write path already sets when a method isn't explicitly recorded.
    provider?: Database["public"]["Enums"]["payment_provider"];
  } | null;
};

export type LedgerEntry = {
  id: string;
  date: string;
  patientName: string;
  serviceName: string;
  doctorName: string;
  amount: number;
  status: Database["public"]["Enums"]["payment_status"];
  provider: Database["public"]["Enums"]["payment_provider"];
};

export type AppointmentsAggregate = {
  total: number;
  cancelled: number;
  noShows: number;
  completed: number;
  cancellationRate: number;
  noShowRate: number;
  bySource: Array<[string, number]>;
  byStatus: Array<[string, number]>;
  byPaymentStatus: Array<[string, number]>;
  cancelReasons: Array<{ reason: string; count: number }>;
  noShowReasons: Array<{ reason: string; count: number }>;
  totalRevenue: number;
  revenueTrend: Array<{ date: string; revenue: number }>;
  revenueByWeek: Array<{ key: string; revenue: number }>;
  revenueByMonth: Array<{ key: string; revenue: number }>;
  /** Recognized revenue (completed + paid) grouped by how it was collected, busiest first. */
  revenueByProvider: Array<{ provider: string; revenue: number }>;
  topServices: Array<{ name: string; count: number; completedCount: number; revenue: number }>;
  topDoctors: Array<{ name: string; count: number; completedCount: number; revenue: number; completionRate: number }>;
  /** Sum of payments.amount currently sitting at "unpaid" (money owed, not yet collected). */
  unpaidTotal: number;
  /** Sum of payments.amount currently sitting at "pending" (in flight — e.g. awaiting a manual-review confirmation). */
  pendingTotal: number;
  /** Sum of payments.amount currently sitting at "refunded" (money paid out back to the patient). */
  refundedTotal: number;
  /** totalRevenue / count of recognized-revenue payments — 0 when there are none (never NaN). */
  averageTicket: number;
  /** Every appointment that has a payment record at all (any status), newest first, capped at `ledgerLimit`. */
  recentPayments: LedgerEntry[];
};

/**
 * ISO week key (2026-W34) and month key (2026-08) derived from a
 * clinic-local calendar day key (YYYY-MM-DD). The day key is already
 * timezone-correct, so no further timezone math is needed here.
 */
export function weekKeyFromDayKey(dayKey: string): string {
  const [y, m, d] = dayKey.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  const dayOfWeek = date.getUTCDay();
  const monday = new Date(date);
  monday.setUTCDate(monday.getUTCDate() - ((dayOfWeek + 6) % 7));
  const year = monday.getUTCFullYear();
  const thursday = new Date(monday);
  thursday.setUTCDate(thursday.getUTCDate() + 3);
  const week = Math.ceil(((thursday.getTime() - Date.UTC(year, 0, 1)) / 86400000 + 1) / 7);
  return `${year}-W${String(week).padStart(2, "0")}`;
}

export function monthKeyFromDayKey(dayKey: string): string {
  return dayKey.slice(0, 7);
}

/** Percentage of `part` over `whole`, rounded to one decimal. 0 when `whole` is 0 (never NaN/Infinity). */
function percent(part: number, whole: number): number {
  if (whole <= 0) return 0;
  return Math.round((part / whole) * 1000) / 10;
}

/**
 * Pure aggregation over appointment rows — the single source of truth for
 * the management analytics endpoint.
 *
 * Revenue is recognized ONLY when a service was actually delivered
 * (appointment status "completed") AND actually paid for (payment status
 * "paid") — an appointment's own status is never, by itself, treated as a
 * financial fact, and a service's catalog list price is never used as the
 * charged amount (a doctor can have a `doctor_services.price_override` for
 * a service, which is what `payments.amount` already correctly reflects
 * from booking time — see book_appointment()). A later refund moves
 * payments.status away from "paid" and so automatically and correctly
 * drops that appointment back out of every revenue figure, with no special
 * case needed here.
 *
 * Cancellation/no-show reasons are grouped by (trimmed) reason; the
 * revenue trend buckets by clinic-local calendar day, ISO week, and
 * calendar month.
 */
export function aggregateAppointments(
  rows: AnalyticsRow[],
  clinicTimezone: string,
  topN = 8,
  ledgerLimit = 20,
): AppointmentsAggregate {
  const bySource = new Map<string, number>();
  const byStatus = new Map<string, number>();
  const byPaymentStatus = new Map<string, number>();
  const cancelReasons = new Map<string, number>();
  const noShowReasons = new Map<string, number>();
  const trend = new Map<string, number>();
  const weekTrend = new Map<string, number>();
  const monthTrend = new Map<string, number>();
  const providerRevenue = new Map<string, number>();
  const services = new Map<string, { count: number; completedCount: number; revenue: number }>();
  const doctors = new Map<string, { count: number; completedCount: number; revenue: number }>();
  const ledger: LedgerEntry[] = [];
  let cancelled = 0;
  let noShows = 0;
  let completed = 0;
  let total = 0;
  let totalRevenue = 0;
  let paidCount = 0;
  let unpaidTotal = 0;
  let pendingTotal = 0;
  let refundedTotal = 0;

  for (const a of rows) {
    total += 1;
    bySource.set(a.source, (bySource.get(a.source) ?? 0) + 1);
    byStatus.set(a.status, (byStatus.get(a.status) ?? 0) + 1);
    if (a.payments?.status) {
      byPaymentStatus.set(a.payments.status, (byPaymentStatus.get(a.payments.status) ?? 0) + 1);
    }
    if (a.status === "cancelled") {
      cancelled += 1;
      const reason = (a.cancelled_reason ?? "Sabab ko‘rsatilmagan").trim();
      cancelReasons.set(reason, (cancelReasons.get(reason) ?? 0) + 1);
    }
    if (a.status === "no_show") {
      noShows += 1;
      const reason = (a.no_show_reason ?? "Sabab ko‘rsatilmagan").trim();
      noShowReasons.set(reason, (noShowReasons.get(reason) ?? 0) + 1);
    }

    const isCompleted = a.status === "completed";
    if (isCompleted) completed += 1;

    const isRevenue = isCompleted && a.payments?.status === "paid";
    const amount = isRevenue ? Number(a.payments?.amount ?? 0) : 0;
    if (isRevenue) {
      totalRevenue += amount;
      paidCount += 1;
      const day = clinicDateKey(clinicTimezone, new Date(a.start_at));
      trend.set(day, (trend.get(day) ?? 0) + amount);
      const week = weekKeyFromDayKey(day);
      weekTrend.set(week, (weekTrend.get(week) ?? 0) + amount);
      const month = monthKeyFromDayKey(day);
      monthTrend.set(month, (monthTrend.get(month) ?? 0) + amount);
      const provider = a.payments?.provider ?? "manual";
      providerRevenue.set(provider, (providerRevenue.get(provider) ?? 0) + amount);
    }

    // Money owed / in flight / paid back — distinct from `totalRevenue`,
    // which recognizes only completed-and-paid appointments. These sums
    // reflect the payment's own amount regardless of appointment status, so
    // an unpaid balance still shows up even if, say, the visit is done.
    if (a.payments) {
      const paymentAmount = Number(a.payments.amount ?? 0);
      if (a.payments.status === "unpaid") unpaidTotal += paymentAmount;
      else if (a.payments.status === "pending" || a.payments.status === "manual_review") pendingTotal += paymentAmount;
      else if (a.payments.status === "refunded") refundedTotal += paymentAmount;
      // "failed" and "paid" are deliberately excluded here: a failed attempt
      // never held real money (nothing to add to receivables), and paid
      // money is already counted in totalRevenue above.

      ledger.push({
        id: a.id,
        date: a.start_at,
        patientName: a.patients?.full_name?.trim() || "Noma’lum bemor",
        serviceName: a.services?.name ?? "Noma’lum xizmat",
        doctorName: a.doctors?.name ?? "Noma’lum shifokor",
        amount: paymentAmount,
        status: a.payments.status,
        provider: a.payments.provider ?? "manual",
      });
    }

    const svcName = a.services?.name ?? "Noma’lum xizmat";
    const svc = services.get(svcName) ?? { count: 0, completedCount: 0, revenue: 0 };
    svc.count += 1;
    if (isCompleted) svc.completedCount += 1;
    if (isRevenue) svc.revenue += amount;
    services.set(svcName, svc);

    const docName = a.doctors?.name ?? "Noma’lum shifokor";
    const doc = doctors.get(docName) ?? { count: 0, completedCount: 0, revenue: 0 };
    doc.count += 1;
    if (isCompleted) doc.completedCount += 1;
    if (isRevenue) doc.revenue += amount;
    doctors.set(docName, doc);
  }

  return {
    total,
    cancelled,
    noShows,
    completed,
    cancellationRate: percent(cancelled, total),
    noShowRate: percent(noShows, total),
    bySource: [...bySource.entries()].sort((a, b) => b[1] - a[1]),
    byStatus: [...byStatus.entries()].sort((a, b) => b[1] - a[1]),
    byPaymentStatus: [...byPaymentStatus.entries()].sort((a, b) => b[1] - a[1]),
    cancelReasons: [...cancelReasons.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, topN)
      .map(([reason, count]) => ({ reason, count })),
    noShowReasons: [...noShowReasons.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, topN)
      .map(([reason, count]) => ({ reason, count })),
    totalRevenue,
    revenueTrend: [...trend.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([date, revenue]) => ({ date, revenue })),
    revenueByWeek: [...weekTrend.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([key, revenue]) => ({ key, revenue })),
    revenueByMonth: [...monthTrend.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([key, revenue]) => ({ key, revenue })),
    revenueByProvider: [...providerRevenue.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([provider, revenue]) => ({ provider, revenue })),
    topServices: [...services.entries()]
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, topN)
      .map(([name, v]) => ({ name, count: v.count, completedCount: v.completedCount, revenue: v.revenue })),
    topDoctors: [...doctors.entries()]
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, topN)
      .map(([name, v]) => ({
        name,
        count: v.count,
        completedCount: v.completedCount,
        revenue: v.revenue,
        completionRate: percent(v.completedCount, v.count),
      })),
    unpaidTotal,
    pendingTotal,
    refundedTotal,
    averageTicket: paidCount > 0 ? Math.round(totalRevenue / paidCount) : 0,
    recentPayments: ledger
      .sort((a, b) => (a.date < b.date ? 1 : -1))
      .slice(0, ledgerLimit),
  };
}

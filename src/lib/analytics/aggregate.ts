import type { Database } from "@/lib/supabase/database.types";
import { clinicDateKey } from "@/lib/time/local";

export type AnalyticsRow = {
  source: Database["public"]["Enums"]["appointment_source"];
  status: Database["public"]["Enums"]["appointment_status"];
  cancelled_reason: string | null;
  no_show_reason: string | null;
  start_at: string;
  services: { name: string; price: number } | null;
  doctors: { name: string } | null;
};

export type AppointmentsAggregate = {
  total: number;
  cancelled: number;
  noShows: number;
  completed: number;
  bySource: Array<[string, number]>;
  byStatus: Array<[string, number]>;
  cancelReasons: Array<{ reason: string; count: number }>;
  noShowReasons: Array<{ reason: string; count: number }>;
  revenueTrend: Array<{ date: string; revenue: number }>;
  revenueByWeek: Array<{ key: string; revenue: number }>;
  revenueByMonth: Array<{ key: string; revenue: number }>;
  topServices: Array<{ name: string; count: number; revenue: number }>;
  topDoctors: Array<{ name: string; count: number; revenue: number }>;
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

/**
 * Pure aggregation over appointment rows — the single source of truth for
 * the management analytics endpoint. Revenue counts ONLY completed
 * appointments; cancellation/no-show reasons are grouped by (trimmed)
 * reason; the revenue trend buckets by clinic-local calendar day, ISO week,
 * and calendar month.
 */
export function aggregateAppointments(
  rows: AnalyticsRow[],
  clinicTimezone: string,
  topN = 8,
): AppointmentsAggregate {
  const bySource = new Map<string, number>();
  const byStatus = new Map<string, number>();
  const cancelReasons = new Map<string, number>();
  const noShowReasons = new Map<string, number>();
  const trend = new Map<string, number>();
  const weekTrend = new Map<string, number>();
  const monthTrend = new Map<string, number>();
  const services = new Map<string, { count: number; revenue: number }>();
  const doctors = new Map<string, { count: number; revenue: number }>();
  let cancelled = 0;
  let noShows = 0;
  let completed = 0;
  let total = 0;
  for (const a of rows) {
    total += 1;
    bySource.set(a.source, (bySource.get(a.source) ?? 0) + 1);
    byStatus.set(a.status, (byStatus.get(a.status) ?? 0) + 1);
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

    const price = Number(a.services?.price ?? 0);
    const paid = a.status === "completed";
    if (paid) {
      completed += 1;
      const day = clinicDateKey(clinicTimezone, new Date(a.start_at));
      trend.set(day, (trend.get(day) ?? 0) + price);
      const week = weekKeyFromDayKey(day);
      weekTrend.set(week, (weekTrend.get(week) ?? 0) + price);
      const month = monthKeyFromDayKey(day);
      monthTrend.set(month, (monthTrend.get(month) ?? 0) + price);
    }
    const svcName = a.services?.name ?? "Noma’lum xizmat";
    const svc = services.get(svcName) ?? { count: 0, revenue: 0 };
    svc.count += 1;
    if (paid) svc.revenue += price;
    services.set(svcName, svc);

    const docName = a.doctors?.name ?? "Noma’lum shifokor";
    const doc = doctors.get(docName) ?? { count: 0, revenue: 0 };
    doc.count += 1;
    if (paid) doc.revenue += price;
    doctors.set(docName, doc);
  }

  return {
    total,
    cancelled,
    noShows,
    completed,
    bySource: [...bySource.entries()].sort((a, b) => b[1] - a[1]),
    byStatus: [...byStatus.entries()].sort((a, b) => b[1] - a[1]),
    cancelReasons: [...cancelReasons.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, topN)
      .map(([reason, count]) => ({ reason, count })),
    noShowReasons: [...noShowReasons.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, topN)
      .map(([reason, count]) => ({ reason, count })),
    revenueTrend: [...trend.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([date, revenue]) => ({ date, revenue })),
    revenueByWeek: [...weekTrend.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([key, revenue]) => ({ key, revenue })),
    revenueByMonth: [...monthTrend.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([key, revenue]) => ({ key, revenue })),
    topServices: [...services.entries()]
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, topN)
      .map(([name, v]) => ({ name, count: v.count, revenue: v.revenue })),
    topDoctors: [...doctors.entries()]
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, topN)
      .map(([name, v]) => ({ name, count: v.count, revenue: v.revenue })),
  };
}
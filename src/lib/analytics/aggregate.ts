import type { Database } from "@/lib/supabase/database.types";
import { clinicDateKey } from "@/lib/time/local";

export type AnalyticsRow = {
  source: Database["public"]["Enums"]["appointment_source"];
  status: Database["public"]["Enums"]["appointment_status"];
  cancelled_reason: string | null;
  start_at: string;
  services: { name: string; price: number } | null;
  doctors: { name: string } | null;
};

export type AppointmentsAggregate = {
  total: number;
  cancelled: number;
  bySource: Array<[string, number]>;
  byStatus: Array<[string, number]>;
  cancelReasons: Array<{ reason: string; count: number }>;
  revenueTrend: Array<{ date: string; revenue: number }>;
  topServices: Array<{ name: string; count: number; revenue: number }>;
  topDoctors: Array<{ name: string; count: number; revenue: number }>;
};

/**
 * Pure aggregation over appointment rows — the single source of truth for
 * the management analytics endpoint. Revenue counts ONLY completed
 * appointments; cancellation reasons are grouped by (trimmed) reason; the
 * revenue trend buckets by clinic-local calendar day.
 */
export function aggregateAppointments(
  rows: AnalyticsRow[],
  clinicTimezone: string,
  topN = 8,
): AppointmentsAggregate {
  const bySource = new Map<string, number>();
  const byStatus = new Map<string, number>();
  const cancelReasons = new Map<string, number>();
  const trend = new Map<string, number>();
  const services = new Map<string, { count: number; revenue: number }>();
  const doctors = new Map<string, { count: number; revenue: number }>();
  let cancelled = 0;
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

    const price = Number(a.services?.price ?? 0);
    const paid = a.status === "completed";
    if (paid) {
      const day = clinicDateKey(clinicTimezone, new Date(a.start_at));
      trend.set(day, (trend.get(day) ?? 0) + price);
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
    bySource: [...bySource.entries()].sort((a, b) => b[1] - a[1]),
    byStatus: [...byStatus.entries()].sort((a, b) => b[1] - a[1]),
    cancelReasons: [...cancelReasons.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, topN)
      .map(([reason, count]) => ({ reason, count })),
    revenueTrend: [...trend.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([date, revenue]) => ({ date, revenue })),
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
import type { TodayAppointmentRow } from "@/lib/admin/dashboard-types";

export type DoctorLoad = { name: string; count: number; completed: number; revenue: number };

/**
 * Per-doctor breakdown of today's appointments, derived from rows the page
 * already fetched for the appointments table — no extra query. Revenue
 * recognition mirrors the server rule (completed + paid, see
 * aggregateAppointments in lib/analytics/aggregate.ts); pass
 * includeRevenue=false to omit it entirely rather than show a zero that
 * could be mistaken for a real "no revenue" fact.
 */
export function doctorLoadToday(rows: TodayAppointmentRow[], includeRevenue: boolean): DoctorLoad[] {
  const byDoctor = new Map<string, DoctorLoad>();
  for (const r of rows) {
    const name = r.doctors?.name ?? "Noma’lum shifokor";
    const entry = byDoctor.get(name) ?? { name, count: 0, completed: 0, revenue: 0 };
    entry.count += 1;
    if (r.status === "completed") entry.completed += 1;
    if (includeRevenue && r.status === "completed" && r.payments?.status === "paid") {
      entry.revenue += Number(r.services?.price ?? 0);
    }
    byDoctor.set(name, entry);
  }
  return [...byDoctor.values()].sort((a, b) => b.count - a.count);
}

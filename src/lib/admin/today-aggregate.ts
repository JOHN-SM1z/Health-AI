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

export type DoctorWorkload = {
  name: string;
  count: number;
  completed: number;
  /** Has an appointment "in_progress" right now. */
  busy: boolean;
  nextPatient: { name: string; time: string } | null;
};

/**
 * Per-doctor operational status for the manager's live board: today's load,
 * whether they're mid-consultation right now, and who's next — derived from
 * the same rows already fetched for the appointments table, no new query.
 */
export function doctorWorkloadToday(rows: TodayAppointmentRow[], now: Date): DoctorWorkload[] {
  const byDoctor = new Map<string, { count: number; completed: number; busy: boolean; next: { name: string; time: string } | null }>();
  for (const r of rows) {
    const name = r.doctors?.name ?? "Noma’lum shifokor";
    const entry = byDoctor.get(name) ?? { count: 0, completed: 0, busy: false, next: null };
    entry.count += 1;
    if (r.status === "completed") entry.completed += 1;
    if (r.status === "in_progress") entry.busy = true;
    if (["pending", "confirmed", "checked_in"].includes(r.status) && new Date(r.start_at) >= now) {
      if (!entry.next || r.start_at < entry.next.time) {
        entry.next = { name: r.patients?.full_name?.trim() || "Noma’lum bemor", time: r.start_at };
      }
    }
    byDoctor.set(name, entry);
  }
  return [...byDoctor.entries()]
    .map(([name, v]) => ({ name, count: v.count, completed: v.completed, busy: v.busy, nextPatient: v.next }))
    .sort((a, b) => b.count - a.count);
}

/** Appointments whose scheduled time already passed without starting — a same-day "running late" signal for the manager. */
export function countDelayedToday(rows: TodayAppointmentRow[], now: Date): number {
  return rows.filter((r) => ["pending", "confirmed", "checked_in"].includes(r.status) && new Date(r.start_at) < now).length;
}

import type { TodayAppointmentRow } from "@/lib/admin/dashboard-types";

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

export type DoctorDayCounts = {
  total: number;
  waiting: number;
  checkedIn: number;
  inProgress: number;
  completed: number;
};

/**
 * Per-doctor today-summary for the doctor dashboard's 5-metric top row.
 * Pending and confirmed collapse into one "waiting to arrive" bucket —
 * doctors don't manage the confirmation step (reception does), so the
 * dashboard's brief asks for one "Kutilmoqda" figure, not two.
 */
export function doctorDayCounts(rows: { status: string }[]): DoctorDayCounts {
  const counts: DoctorDayCounts = { total: rows.length, waiting: 0, checkedIn: 0, inProgress: 0, completed: 0 };
  for (const r of rows) {
    if (r.status === "pending" || r.status === "confirmed") counts.waiting += 1;
    else if (r.status === "checked_in") counts.checkedIn += 1;
    else if (r.status === "in_progress") counts.inProgress += 1;
    else if (r.status === "completed") counts.completed += 1;
  }
  return counts;
}

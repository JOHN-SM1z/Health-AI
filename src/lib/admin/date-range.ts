import { clinicDateKey } from "@/lib/time/local";

export type RangePreset = "today" | "yesterday" | "7d" | "30d" | "custom";

export const RANGE_PRESETS: Array<{ value: RangePreset; label: string }> = [
  { value: "today", label: "Bugun" },
  { value: "yesterday", label: "Kecha" },
  { value: "7d", label: "Oxirgi 7 kun" },
  { value: "30d", label: "Oxirgi 30 kun" },
  { value: "custom", label: "Maxsus sana" },
];

export type DateRange = { from: string; to: string; previousFrom: string; previousTo: string };

/** Adds (or subtracts) whole calendar days from a "YYYY-MM-DD" date. */
export function addDays(ymd: string, delta: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  date.setUTCDate(date.getUTCDate() + delta);
  return date.toISOString().slice(0, 10);
}

/** Inclusive number of calendar days between two "YYYY-MM-DD" dates. */
export function daySpan(from: string, to: string): number {
  const [y1, m1, d1] = from.split("-").map(Number);
  const [y2, m2, d2] = to.split("-").map(Number);
  const days = (Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86400000;
  return Math.round(days) + 1;
}

/**
 * Resolves a date-range preset (or an explicit custom from/to) into the
 * clinic-local calendar-date window /api/admin/analytics expects, plus the
 * immediately preceding window of equal length — used for the owner
 * dashboard's period-over-period "% change" comparisons.
 */
export function resolveDateRange(
  preset: RangePreset,
  clinicTimezone: string,
  custom?: { from: string; to: string },
  now = new Date(),
): DateRange {
  const today = clinicDateKey(clinicTimezone, now);
  if (preset === "custom") {
    if (!custom) throw new Error("resolveDateRange: custom preset requires a from/to");
    const span = daySpan(custom.from, custom.to);
    return { from: custom.from, to: custom.to, previousFrom: addDays(custom.from, -span), previousTo: addDays(custom.from, -1) };
  }
  if (preset === "yesterday") {
    const y = addDays(today, -1);
    return { from: y, to: y, previousFrom: addDays(y, -1), previousTo: addDays(y, -1) };
  }
  if (preset === "7d") {
    const from = addDays(today, -6);
    return { from, to: today, previousFrom: addDays(from, -7), previousTo: addDays(from, -1) };
  }
  if (preset === "30d") {
    const from = addDays(today, -29);
    return { from, to: today, previousFrom: addDays(from, -30), previousTo: addDays(from, -1) };
  }
  return { from: today, to: today, previousFrom: addDays(today, -1), previousTo: addDays(today, -1) };
}

/** % change from `previous` to `current`, one decimal; null when not meaningful (no previous to compare against). */
export function percentChange(current: number | null | undefined, previous: number | null | undefined): number | null {
  if (current == null || previous == null || previous === 0) return null;
  return Math.round(((current - previous) / previous) * 1000) / 10;
}

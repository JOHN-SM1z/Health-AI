/**
 * Clinic-timezone helpers: every "today" and every calendar-day grouping in
 * the admin panel must use the clinic's own timezone, never the server's.
 */

export function tzOffsetMinutes(tz: string, at: Date): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
      .formatToParts(at)
      .map((p) => [p.type, p.value]),
  );
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  return Math.round((asUtc - at.getTime()) / 60000);
}

/** "YYYY-MM-DD" of `at` in the clinic's own timezone. */
export function clinicDateKey(tz: string, at: Date): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" })
      .formatToParts(at)
      .map((p) => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/** Clinic-local day window for `tz`, e.g. 00:00–24:00 in Asia/Tashkent. */
export function localDayWindow(tz: string, now = new Date()): { start: string; end: string } {
  const ymd = clinicDateKey(tz, now);
  const nominalStart = Date.parse(`${ymd}T00:00:00Z`);
  const start = new Date(nominalStart - tzOffsetMinutes(tz, new Date(nominalStart)) * 60000);
  return { start: start.toISOString(), end: new Date(start.getTime() + 86400000).toISOString() };
}
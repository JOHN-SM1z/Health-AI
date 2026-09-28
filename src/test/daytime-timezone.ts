/**
 * An IANA timezone in which it is now between 07:00 and 17:00 local time.
 *
 * Fixtures that book or start a consultation "now" (a walk-in starts at the
 * next minute) must stay inside one local day's working hours: the booking
 * engine refuses a slot that runs past local midnight. A clinic created in
 * this timezone makes such tests independent of when CI happens to run.
 * (Every UTC hour falls in the 07:00–17:00 window of at least one of these.)
 */
export function daytimeTimezone(now: Date = new Date()): string {
  for (const tz of ["Asia/Tashkent", "Europe/London", "America/New_York", "Asia/Tokyo"]) {
    const hour = Number(new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", hourCycle: "h23" }).format(now));
    if (hour >= 7 && hour < 17) return tz;
  }
  return "Asia/Tashkent";
}

import { formatInTimeZone, fromZonedTime, toZonedTime } from "date-fns-tz";

/** Converts a local wall-clock time in the clinic timezone to a UTC Date. */
export function fromClinicTime(isoLocal: string, timezone: string): Date {
  return fromZonedTime(isoLocal, timezone);
}

/** Formats a UTC Date into the clinic timezone as a wall-clock string. */
export function formatInClinicTz(date: Date | string, timezone: string, pattern: string): string {
  return formatInZoned(date, timezone, pattern);
}

/** UTC Date -> wall-clock Date (still a Date object, but with local fields of the clinic tz). */
export function toClinicTime(date: Date, timezone: string): Date {
  return toZonedTime(date, timezone);
}

export function formatInZoned(date: Date | string, timezone: string, pattern: string): string {
  return formatInTimeZone(new Date(date), timezone, pattern);
}

export function clinicDayLabel(date: Date, timezone: string): string {
  return formatInZoned(date, timezone, "yyyy-MM-dd");
}

/** ISO weekday (1=Mon..7=Sun) of a UTC date in the clinic timezone. */
export function clinicIsoWeekday(date: Date, timezone: string): number {
  return Number(formatInZoned(date, timezone, "i"));
}

export function clinicTimeOfDay(date: Date, timezone: string): string {
  return formatInZoned(date, timezone, "HH:mm");
}
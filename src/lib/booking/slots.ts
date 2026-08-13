import { addMinutes } from "date-fns";
import {
  clinicIsoWeekday,
  clinicTimeOfDay,
  fromClinicTime,
} from "@/lib/timezone";

export type WorkingHoursRow = {
  weekday: number; // 1=Mon..7=Sun
  start_time: string; // "09:00"
  end_time: string; // "18:00"
};

export type TimeBlock = {
  starts_at: string; // ISO UTC
  ends_at: string;
};

export type ExistingAppointment = {
  start_at: string;
  end_at: string;
  status: string;
};

export type Slot = {
  start: Date; // UTC
  end: Date; // UTC
  startLocal: string; // "10:00" in clinic tz
  dayLocal: string; // "2026-08-20"
};


/** True when [aStart,aEnd) overlaps [bStart,bEnd). */
export function rangesOverlap(
  aStart: Date,
  aEnd: Date,
  bStart: Date,
  bEnd: Date,
): boolean {
  return aStart < bEnd && bStart < aEnd;
}

/**
 * Pure slot generator. Produces discrete slots for one doctor+service on the
 * given UTC day range, respecting:
 *  - working hours (per weekday, clinic timezone)
 *  - service duration
 *  - time blocks (breaks, absences, admin holds)
 *  - existing active appointments
 *  - "past slots" (slots starting before now are skipped)
 *
 * Overlap semantics: a new slot is valid iff its full [start, end) range
 * fits inside working hours and does not intersect any block or appointment.
 */
export function generateSlots(opts: {
  timezone: string;
  workingHours: WorkingHoursRow[];
  timeBlocks: TimeBlock[];
  existingAppointments: ExistingAppointment[];
  serviceDurationMinutes: number;
  dayStart: Date; // UTC midnight of the first local day
  dayCount: number;
  now?: Date;
  slotIntervalMinutes?: number; // default 15
}): Slot[] {
  const {
    timezone,
    workingHours,
    timeBlocks,
    existingAppointments,
    serviceDurationMinutes,
    dayStart,
    dayCount,
    now = new Date(),
    slotIntervalMinutes = 15,
  } = opts;

  const blocks: Array<{ start: Date; end: Date }> = timeBlocks.map((b) => ({
    start: new Date(b.starts_at),
    end: new Date(b.ends_at),
  }));

  const activeAppointments = existingAppointments
    .filter((a) => !["cancelled", "no_show"].includes(a.status))
    .map((a) => ({ start: new Date(a.start_at), end: new Date(a.end_at) }));

  const intersectsAny = (start: Date, end: Date, ranges: Array<{ start: Date; end: Date }>) =>
    ranges.some((r) => rangesOverlap(start, end, r.start, r.end));

  const slots: Slot[] = [];

  for (let d = 0; d < dayCount; d++) {
    const localDay = addMinutes(dayStart, d * 24 * 60);
    const weekday = clinicIsoWeekday(localDay, timezone);
    const wh = workingHours.find((w) => w.weekday === weekday);
    if (!wh) continue;

    const openAt = fromClinicTime(`${formatDayStart(localDay, timezone)}T${wh.start_time}:00`, timezone);
    const closeAt = fromClinicTime(`${formatDayStart(localDay, timezone)}T${wh.end_time}:00`, timezone);

    let cursor = openAt;
    while (cursor.getTime() + serviceDurationMinutes * 60_000 <= closeAt.getTime()) {
      const slotEnd = addMinutes(cursor, serviceDurationMinutes);

      const free =
        !intersectsAny(cursor, slotEnd, blocks) &&
        !intersectsAny(cursor, slotEnd, activeAppointments) &&
        cursor.getTime() > now.getTime();

      if (free) {
        slots.push({
          start: cursor,
          end: slotEnd,
          startLocal: clinicTimeOfDay(cursor, timezone),
          dayLocal: formatDayStart(cursor, timezone),
        });
      }

      cursor = addMinutes(cursor, slotIntervalMinutes);
    }
  }

  return slots;
}

function formatDayStart(date: Date, timezone: string): string {
  // Wall-clock yyyy-MM-dd of `date` in the clinic timezone.
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** Convenience check used by the API: is this range currently bookable? */
export function isRangeBookable(opts: {
  timezone: string;
  workingHours: WorkingHoursRow[];
  timeBlocks: TimeBlock[];
  existingAppointments: ExistingAppointment[];
  start: Date;
  end: Date;
}): boolean {
  const { timezone, workingHours, timeBlocks, existingAppointments, start, end } = opts;
  const weekday = clinicIsoWeekday(start, timezone);
  const wh = workingHours.find((w) => w.weekday === weekday);
  if (!wh) return false;

  const day = formatDayStart(start, timezone);
  const openAt = fromClinicTime(`${day}T${wh.start_time}:00`, timezone);
  const closeAt = fromClinicTime(`${day}T${wh.end_time}:00`, timezone);
  if (start < openAt || end > closeAt) return false;

  const blocks = timeBlocks.map((b) => ({ start: new Date(b.starts_at), end: new Date(b.ends_at) }));
  const appts = existingAppointments
    .filter((a) => !["cancelled", "no_show"].includes(a.status))
    .map((a) => ({ start: new Date(a.start_at), end: new Date(a.end_at) }));

  return (
    !blocks.some((r) => rangesOverlap(start, end, r.start, r.end)) &&
    !appts.some((r) => rangesOverlap(start, end, r.start, r.end))
  );
}
import { describe, it, expect } from "vitest";
import {
  generateSlots,
  isRangeBookable,
  rangesOverlap,
  type WorkingHoursRow,
} from "@/lib/booking/slots";
import { addMinutes } from "date-fns";

const TZ = "Asia/Tashkent"; // UTC+5, no DST

/** 2026-08-17 00:00 UTC — a Monday in Asia/Tashkent. */
const MONDAY_UTC = new Date("2026-08-17T00:00:00Z");

const WEEKDAY_MON_FRI: WorkingHoursRow[] = [
  { weekday: 1, start_time: "09:00", end_time: "18:00" },
  { weekday: 2, start_time: "09:00", end_time: "18:00" },
  { weekday: 3, start_time: "09:00", end_time: "18:00" },
  { weekday: 4, start_time: "09:00", end_time: "18:00" },
  { weekday: 5, start_time: "09:00", end_time: "18:00" },
];

describe("rangesOverlap", () => {
  it("detects partial, full and adjacent-but-not-overlapping ranges", () => {
    const aStart = new Date("2026-08-17T04:00:00Z");
    const aEnd = new Date("2026-08-17T05:00:00Z");
    expect(rangesOverlap(aStart, aEnd, new Date("2026-08-17T04:30:00Z"), new Date("2026-08-17T06:00:00Z"))).toBe(true);
    expect(rangesOverlap(aStart, aEnd, new Date("2026-08-17T03:00:00Z"), new Date("2026-08-17T04:30:00Z"))).toBe(true);
    expect(rangesOverlap(aStart, aEnd, aStart, aEnd)).toBe(true);
    // Touching at the boundary is NOT an overlap (half-open intervals).
    expect(rangesOverlap(aStart, aEnd, aEnd, new Date("2026-08-17T06:00:00Z"))).toBe(false);
    expect(rangesOverlap(aStart, aEnd, new Date("2026-08-17T03:00:00Z"), aStart)).toBe(false);
  });
});

describe("generateSlots", () => {
  it("generates 30-minute slots within working hours for one day", () => {
    const now = new Date("2026-08-17T00:00:00Z"); // 05:00 local Monday
    const slots = generateSlots({
      timezone: TZ,
      workingHours: WEEKDAY_MON_FRI,
      timeBlocks: [],
      existingAppointments: [],
      serviceDurationMinutes: 30,
      dayStart: MONDAY_UTC,
      dayCount: 1,
      now,
      slotIntervalMinutes: 30,
    });

    // 09:00..18:00 local (04:00..13:00 UTC) = 18 slots of 30 min.
    expect(slots).toHaveLength(18);
    expect(slots[0].startLocal).toBe("09:00");
    expect(slots[slots.length - 1].startLocal).toBe("17:30");
    expect(slots[0].dayLocal).toBe("2026-08-17");
    // Slot start is always the UTC instant of the local time.
    expect(slots[0].start.toISOString()).toBe("2026-08-17T04:00:00.000Z");
  });

  it("normalizes Postgres HH:mm:ss working-hour values", () => {
    // Supabase returns time columns as "09:00:00"; the generator must not
    // append ":00" on top of that (would produce an Invalid Date and zero slots).
    const now = new Date("2026-08-17T00:00:00Z");
    const slots = generateSlots({
      timezone: TZ,
      workingHours: [
        { weekday: 1, start_time: "09:00:00", end_time: "18:00:00" },
        { weekday: 2, start_time: "09:00:00", end_time: "18:00:00" },
      ],
      timeBlocks: [],
      existingAppointments: [],
      serviceDurationMinutes: 30,
      dayStart: MONDAY_UTC,
      dayCount: 1,
      now,
      slotIntervalMinutes: 30,
    });
    expect(slots).toHaveLength(18);
    expect(slots[0].startLocal).toBe("09:00");
  });

  it("skips slots already started when `now` is inside the workday", () => {
    const now = new Date("2026-08-17T06:30:00Z"); // 11:30 local
    const slots = generateSlots({
      timezone: TZ,
      workingHours: WEEKDAY_MON_FRI,
      timeBlocks: [],
      existingAppointments: [],
      serviceDurationMinutes: 30,
      dayStart: MONDAY_UTC,
      dayCount: 1,
      now,
      slotIntervalMinutes: 30,
    });
    expect(slots[0].startLocal).toBe("12:00");
  });

  it("excludes slots that intersect a time block", () => {
    const now = new Date("2026-08-17T00:00:00Z");
    const slots = generateSlots({
      timezone: TZ,
      workingHours: WEEKDAY_MON_FRI,
      timeBlocks: [
        { starts_at: "2026-08-17T08:00:00Z", ends_at: "2026-08-17T09:00:00Z" }, // 13:00-14:00 local
      ],
      existingAppointments: [],
      serviceDurationMinutes: 30,
      dayStart: MONDAY_UTC,
      dayCount: 1,
      now,
      slotIntervalMinutes: 30,
    });
    const times = slots.map((s) => s.startLocal);
    expect(times).not.toContain("13:00");
    expect(times).not.toContain("13:30");
    expect(times).toContain("12:30");
    expect(times).toContain("14:00");
  });

  it("excludes slots overlapping existing active appointments but not cancelled ones", () => {
    const now = new Date("2026-08-17T00:00:00Z");
    const slots = generateSlots({
      timezone: TZ,
      workingHours: WEEKDAY_MON_FRI,
      timeBlocks: [],
      existingAppointments: [
        { start_at: "2026-08-17T05:00:00Z", end_at: "2026-08-17T06:00:00Z", status: "confirmed" }, // 10:00-11:00
        { start_at: "2026-08-17T08:00:00Z", end_at: "2026-08-17T09:00:00Z", status: "cancelled" }, // 13:00-14:00 — must NOT block
      ],
      serviceDurationMinutes: 30,
      dayStart: MONDAY_UTC,
      dayCount: 1,
      now,
      slotIntervalMinutes: 30,
    });
    const times = slots.map((s) => s.startLocal);
    expect(times).not.toContain("10:00");
    expect(times).not.toContain("10:30");
    expect(times).toContain("13:00");
  });

  it("respects the per-weekday schedule across multiple days", () => {
    const now = new Date("2026-08-15T00:00:00Z"); // Saturday, before any slot
    // Saturday + Sunday off: 2 days => 0 slots.
    const weekendSlots = generateSlots({
      timezone: TZ,
      workingHours: WEEKDAY_MON_FRI,
      timeBlocks: [],
      existingAppointments: [],
      serviceDurationMinutes: 60,
      dayStart: new Date("2026-08-15T00:00:00Z"),
      dayCount: 2,
      now,
    });
    expect(weekendSlots).toHaveLength(0);

    // Monday + Tuesday on: 2 days × 33 hourly-slot starts (60-min service
    // on the 15-min grid) = 66 slots.
    const weekSlots = generateSlots({
      timezone: TZ,
      workingHours: WEEKDAY_MON_FRI,
      timeBlocks: [],
      existingAppointments: [],
      serviceDurationMinutes: 60,
      dayStart: MONDAY_UTC,
      dayCount: 2,
      now,
    });
    expect(weekSlots).toHaveLength(66);
    expect(weekSlots[0].dayLocal).toBe("2026-08-17");
    expect(weekSlots[33].dayLocal).toBe("2026-08-18");
  });
});

describe("isRangeBookable", () => {
  it("returns false outside working hours", () => {
    const start = new Date("2026-08-17T13:30:00Z"); // 18:30 local
    expect(
      isRangeBookable({
        timezone: TZ,
        workingHours: WEEKDAY_MON_FRI,
        timeBlocks: [],
        existingAppointments: [],
        start,
        end: addMinutes(start, 30),
      }),
    ).toBe(false);
  });

  it("returns false when a block or appointment overlaps", () => {
    const start = new Date("2026-08-17T05:00:00Z"); // 10:00 local
    expect(
      isRangeBookable({
        timezone: TZ,
        workingHours: WEEKDAY_MON_FRI,
        timeBlocks: [{ starts_at: "2026-08-17T05:00:00Z", ends_at: "2026-08-17T06:00:00Z" }],
        existingAppointments: [],
        start,
        end: addMinutes(start, 30),
      }),
    ).toBe(false);
    expect(
      isRangeBookable({
        timezone: TZ,
        workingHours: WEEKDAY_MON_FRI,
        timeBlocks: [],
        existingAppointments: [{ start_at: "2026-08-17T04:00:00Z", end_at: "2026-08-17T06:00:00Z", status: "pending" }],
        start,
        end: addMinutes(start, 30),
      }),
    ).toBe(false);
  });

  it("is not blocked by cancelled appointments", () => {
    const start = new Date("2026-08-17T05:00:00Z");
    expect(
      isRangeBookable({
        timezone: TZ,
        workingHours: WEEKDAY_MON_FRI,
        timeBlocks: [],
        existingAppointments: [{ start_at: "2026-08-17T04:00:00Z", end_at: "2026-08-17T06:00:00Z", status: "cancelled" }],
        start,
        end: addMinutes(start, 30),
      }),
    ).toBe(true);
  });
});
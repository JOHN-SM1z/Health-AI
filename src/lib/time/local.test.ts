import { describe, it, expect } from "vitest";
import { clinicDateKey, localDayWindow, tzOffsetMinutes } from "@/lib/time/local";

describe("tzOffsetMinutes", () => {
  it("returns +300 for Asia/Tashkent (UTC+5, no DST)", () => {
    expect(tzOffsetMinutes("Asia/Tashkent", new Date("2026-09-11T00:00:00Z"))).toBe(300);
  });

  it("returns 0 for UTC", () => {
    expect(tzOffsetMinutes("UTC", new Date("2026-09-11T00:00:00Z"))).toBe(0);
  });
});

describe("clinicDateKey", () => {
  it("rolls over to the next clinic-local day before UTC midnight", () => {
    // 2026-09-10T20:00:00Z is already 2026-09-11T01:00 in Asia/Tashkent
    // (UTC+5) — the clinic's calendar date, not the UTC one.
    expect(clinicDateKey("Asia/Tashkent", new Date("2026-09-10T20:00:00Z"))).toBe("2026-09-11");
    expect(clinicDateKey("UTC", new Date("2026-09-10T20:00:00Z"))).toBe("2026-09-10");
  });
});

describe("localDayWindow", () => {
  it("computes the clinic-local midnight-to-midnight window in UTC for Asia/Tashkent", () => {
    const { start, end } = localDayWindow("Asia/Tashkent", new Date("2026-09-10T20:00:00Z"));
    expect(start).toBe("2026-09-10T19:00:00.000Z");
    expect(end).toBe("2026-09-11T19:00:00.000Z");
  });

  it("disagrees with a naive UTC-midnight window near the day boundary — this is exactly the bug class this helper exists to prevent (see admin/page.tsx and doctor/page.tsx, which both used to compute 'today' via new Date().setHours(0,0,0,0) in the browser's own timezone)", () => {
    const now = new Date("2026-09-10T20:00:00Z");
    const { start, end } = localDayWindow("Asia/Tashkent", now);

    const naiveUtcStart = new Date(Date.UTC(2026, 8, 10, 0, 0, 0)).toISOString();
    const naiveUtcEnd = new Date(Date.UTC(2026, 8, 11, 0, 0, 0)).toISOString();
    expect(start).not.toBe(naiveUtcStart);
    expect(end).not.toBe(naiveUtcEnd);

    // An appointment at 2026-09-11T10:00Z is 15:00 on Sept 11 in Tashkent —
    // squarely "today" from the clinic's point of view at this moment — but
    // a naive UTC window would already have rolled past its own midnight
    // and miss it entirely.
    const appointment = new Date("2026-09-11T10:00:00Z").toISOString();
    expect(appointment >= start && appointment < end).toBe(true);
    expect(appointment >= naiveUtcStart && appointment < naiveUtcEnd).toBe(false);
  });

  it("produces an exactly-24-hour window", () => {
    const { start, end } = localDayWindow("Asia/Tashkent", new Date("2026-09-10T20:00:00Z"));
    expect(new Date(end).getTime() - new Date(start).getTime()).toBe(86400000);
  });
});

import { describe, it, expect } from "vitest";
import { resolveDateRange, percentChange } from "@/lib/admin/date-range";

const TZ = "Asia/Tashkent";
// 2026-09-13T12:00:00Z is 2026-09-13T17:00 local (UTC+5) — same clinic-local day either way.
const NOW = new Date("2026-09-13T12:00:00Z");

describe("resolveDateRange", () => {
  it("today: from=to=today, previous is yesterday", () => {
    expect(resolveDateRange("today", TZ, undefined, NOW)).toEqual({
      from: "2026-09-13",
      to: "2026-09-13",
      previousFrom: "2026-09-12",
      previousTo: "2026-09-12",
    });
  });

  it("yesterday: from=to=yesterday, previous is the day before that", () => {
    expect(resolveDateRange("yesterday", TZ, undefined, NOW)).toEqual({
      from: "2026-09-12",
      to: "2026-09-12",
      previousFrom: "2026-09-11",
      previousTo: "2026-09-11",
    });
  });

  it("7d: a 7-day trailing window, previous is the preceding 7 days with no gap or overlap", () => {
    const r = resolveDateRange("7d", TZ, undefined, NOW);
    expect(r).toEqual({
      from: "2026-09-07",
      to: "2026-09-13",
      previousFrom: "2026-08-31",
      previousTo: "2026-09-06",
    });
  });

  it("30d: a 30-day trailing window, previous is the preceding 30 days with no gap or overlap", () => {
    const r = resolveDateRange("30d", TZ, undefined, NOW);
    expect(r).toEqual({
      from: "2026-08-15",
      to: "2026-09-13",
      previousFrom: "2026-07-16",
      previousTo: "2026-08-14",
    });
  });

  it("custom: previous window has the same length and ends the day before it starts", () => {
    const r = resolveDateRange("custom", TZ, { from: "2026-08-01", to: "2026-08-10" }, NOW);
    expect(r).toEqual({
      from: "2026-08-01",
      to: "2026-08-10",
      previousFrom: "2026-07-22",
      previousTo: "2026-07-31",
    });
  });

  it("custom single-day range: previous is exactly the one day before", () => {
    const r = resolveDateRange("custom", TZ, { from: "2026-08-01", to: "2026-08-01" }, NOW);
    expect(r).toEqual({
      from: "2026-08-01",
      to: "2026-08-01",
      previousFrom: "2026-07-31",
      previousTo: "2026-07-31",
    });
  });

  it("throws for custom without a from/to (programmer error, not a user-facing case)", () => {
    expect(() => resolveDateRange("custom", TZ, undefined, NOW)).toThrow();
  });
});

describe("percentChange", () => {
  it("computes a positive change", () => {
    expect(percentChange(124, 110)).toBe(12.7);
  });

  it("computes a negative change", () => {
    expect(percentChange(80, 100)).toBe(-20);
  });

  it("is null when previous is zero (division by zero is never a real percentage)", () => {
    expect(percentChange(100, 0)).toBeNull();
  });

  it("is null when either value is missing", () => {
    expect(percentChange(null, 100)).toBeNull();
    expect(percentChange(100, undefined)).toBeNull();
  });

  it("is 0 when nothing changed", () => {
    expect(percentChange(100, 100)).toBe(0);
  });
});

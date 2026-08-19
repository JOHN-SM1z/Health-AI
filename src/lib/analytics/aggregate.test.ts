import { describe, it, expect } from "vitest";
import { aggregateAppointments, weekKeyFromDayKey, monthKeyFromDayKey, type AnalyticsRow } from "./aggregate";

/**
 * Analytics remediation (audit finding, Phase 9): regression coverage for
 * the aggregation additions — no-show reasons, completion counts, and
 * weekly/monthly revenue buckets — plus the week/month key helpers.
 */

const TZ = "Asia/Tashkent";

function row(over: Partial<AnalyticsRow> & { start_at: string }): AnalyticsRow {
  return {
    source: "telegram_mini_app",
    status: "pending",
    cancelled_reason: null,
    no_show_reason: null,
    services: { name: "Konsultatsiya", price: 100000 },
    doctors: { name: "Dr A" },
    ...over,
  };
}

describe("aggregateAppointments — audit additions", () => {
  it("groups no-show reasons and counts no_shows/completed", () => {
    const agg = aggregateAppointments(
      [
        row({ status: "no_show", no_show_reason: "  Bemor kelolmadi  ", start_at: "2026-08-10T05:00:00Z" }),
        row({ status: "no_show", no_show_reason: "Bemor kelolmadi", start_at: "2026-08-11T05:00:00Z" }),
        row({ status: "no_show", no_show_reason: null, start_at: "2026-08-12T05:00:00Z" }),
        row({ status: "completed", start_at: "2026-08-13T05:00:00Z" }),
        row({ status: "cancelled", cancelled_reason: "Bemor bekor qildi", start_at: "2026-08-14T05:00:00Z" }),
      ],
      TZ,
    );
    expect(agg.noShows).toBe(3);
    expect(agg.completed).toBe(1);
    expect(agg.cancelled).toBe(1);
    expect(agg.noShowReasons).toContainEqual({ reason: "Bemor kelolmadi", count: 2 });
    expect(agg.noShowReasons).toContainEqual({ reason: "Sabab ko‘rsatilmagan", count: 1 });
    // Cancellation grouping is untouched by the no-show work.
    expect(agg.cancelReasons).toEqual([{ reason: "Bemor bekor qildi", count: 1 }]);
  });

  it("buckets revenue daily, weekly and monthly", () => {
    const agg = aggregateAppointments(
      [
        // Two completed appointments on 2026-08-10 and one on 2026-08-17.
        row({ status: "completed", start_at: "2026-08-10T05:00:00Z" }),
        row({ status: "completed", start_at: "2026-08-10T09:00:00Z" }),
        row({ status: "completed", start_at: "2026-08-17T05:00:00Z" }),
      ],
      TZ,
      8,
    );
    expect(agg.revenueTrend).toEqual([
      { date: "2026-08-10", revenue: 200000 },
      { date: "2026-08-17", revenue: 100000 },
    ]);
    expect(agg.revenueByWeek).toEqual([
      { key: "2026-W33", revenue: 200000 },
      { key: "2026-W34", revenue: 100000 },
    ]);
    expect(agg.revenueByMonth).toEqual([{ key: "2026-08", revenue: 300000 }]);
  });

  it("treats only completed appointments as revenue", () => {
    const agg = aggregateAppointments(
      [
        row({ status: "completed", start_at: "2026-08-10T05:00:00Z" }),
        row({ status: "no_show", start_at: "2026-08-10T06:00:00Z" }),
        row({ status: "cancelled", start_at: "2026-08-10T07:00:00Z" }),
        row({ status: "pending", start_at: "2026-08-10T08:00:00Z" }),
      ],
      TZ,
    );
    expect(agg.revenueTrend).toEqual([{ date: "2026-08-10", revenue: 100000 }]);
  });

  it("keeps byStatus exact", () => {
    const agg = aggregateAppointments(
      [
        row({ status: "completed", start_at: "2026-08-10T05:00:00Z" }),
        row({ status: "no_show", start_at: "2026-08-11T05:00:00Z" }),
        row({ status: "no_show", start_at: "2026-08-12T05:00:00Z" }),
      ],
      TZ,
    );
    expect(agg.byStatus).toEqual([
      ["no_show", 2],
      ["completed", 1],
    ]);
  });
});

describe("weekKeyFromDayKey / monthKeyFromDayKey", () => {
  it("maps clinic-local day keys to ISO weeks", () => {
    expect(weekKeyFromDayKey("2026-08-10")).toBe("2026-W33");
    expect(weekKeyFromDayKey("2026-08-16")).toBe("2026-W33");
    expect(weekKeyFromDayKey("2026-08-17")).toBe("2026-W34");
    expect(weekKeyFromDayKey("2027-01-01")).toBe("2026-W53");
    expect(weekKeyFromDayKey("2027-01-04")).toBe("2027-W01");
  });

  it("maps day keys to months", () => {
    expect(monthKeyFromDayKey("2026-08-31")).toBe("2026-08");
    expect(monthKeyFromDayKey("2026-12-01")).toBe("2026-12");
  });
});
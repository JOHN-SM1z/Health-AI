import { describe, it, expect } from "vitest";
import { aggregateAppointments, weekKeyFromDayKey, monthKeyFromDayKey, type AnalyticsRow } from "./aggregate";

/**
 * Analytics remediation (audit finding, Phase 9): regression coverage for
 * the aggregation additions — no-show reasons, completion counts, and
 * weekly/monthly revenue buckets — plus the week/month key helpers.
 *
 * Data-and-analytics-engineer phase: revenue must be an authoritative
 * financial fact (payments.status === "paid"), never a proxy derived from
 * appointment.status alone, and must use the amount actually charged
 * (payments.amount, which already reflects any doctor_services
 * price_override) rather than a service's catalog list price. Default
 * fixture rows are "completed" + "paid" at the service's own price so
 * existing revenue-bucketing tests keep their original, readable numbers;
 * tests below exercise every case where that would go wrong.
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
    payments: { status: "paid", amount: 100000 },
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
        // Two completed+paid appointments on 2026-08-10 and one on 2026-08-17.
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
    expect(agg.totalRevenue).toBe(300000);
  });

  it("treats only completed AND paid appointments as revenue — appointment status alone is never a financial fact", () => {
    const agg = aggregateAppointments(
      [
        row({ status: "completed", start_at: "2026-08-10T05:00:00Z" }), // paid (default) -> counts
        row({ status: "no_show", start_at: "2026-08-10T06:00:00Z" }),
        row({ status: "cancelled", start_at: "2026-08-10T07:00:00Z" }),
        row({ status: "pending", start_at: "2026-08-10T08:00:00Z" }),
        // The visit happened, but nothing was ever actually collected —
        // this must NEVER be counted as revenue just because the
        // appointment itself reached "completed".
        row({ status: "completed", payments: { status: "unpaid", amount: 100000 }, start_at: "2026-08-10T09:00:00Z" }),
        // A completed, once-paid visit that was later refunded must drop
        // back OUT of revenue, not keep counting the original charge.
        row({ status: "completed", payments: { status: "refunded", amount: 100000 }, start_at: "2026-08-10T10:00:00Z" }),
        // Paid in advance for a future appointment that has not happened
        // yet: no service delivered yet, so no revenue yet either.
        row({ status: "confirmed", payments: { status: "paid", amount: 100000 }, start_at: "2026-08-10T11:00:00Z" }),
      ],
      TZ,
    );
    expect(agg.revenueTrend).toEqual([{ date: "2026-08-10", revenue: 100000 }]);
    expect(agg.totalRevenue).toBe(100000);
  });

  it("uses the actual charged amount (payments.amount), never the service's catalog list price", () => {
    // A doctor_services.price_override at booking time means the real
    // charge can differ from services.price — payments.amount already
    // reflects that (see book_appointment()); the service's own listed
    // price must never be substituted for it.
    const agg = aggregateAppointments(
      [
        row({
          status: "completed",
          services: { name: "Konsultatsiya", price: 100000 },
          payments: { status: "paid", amount: 150000 },
          start_at: "2026-08-10T05:00:00Z",
        }),
      ],
      TZ,
    );
    expect(agg.totalRevenue).toBe(150000);
    expect(agg.revenueTrend).toEqual([{ date: "2026-08-10", revenue: 150000 }]);
    expect(agg.topServices[0]).toMatchObject({ name: "Konsultatsiya", revenue: 150000 });
  });

  it("handles a missing payment row without crashing and without counting revenue", () => {
    const agg = aggregateAppointments(
      [row({ status: "completed", payments: null, start_at: "2026-08-10T05:00:00Z" })],
      TZ,
    );
    expect(agg.totalRevenue).toBe(0);
    expect(agg.revenueTrend).toEqual([]);
    expect(agg.byPaymentStatus).toEqual([]);
  });

  it("groups by payment status across all appointments, regardless of appointment status", () => {
    const agg = aggregateAppointments(
      [
        row({ status: "completed", payments: { status: "paid", amount: 100000 }, start_at: "2026-08-10T05:00:00Z" }),
        row({ status: "confirmed", payments: { status: "unpaid", amount: 100000 }, start_at: "2026-08-10T06:00:00Z" }),
        row({ status: "confirmed", payments: { status: "unpaid", amount: 100000 }, start_at: "2026-08-10T07:00:00Z" }),
        row({ status: "completed", payments: { status: "refunded", amount: 100000 }, start_at: "2026-08-10T08:00:00Z" }),
      ],
      TZ,
    );
    expect(agg.byPaymentStatus).toEqual([
      ["unpaid", 2],
      ["paid", 1],
      ["refunded", 1],
    ]);
  });

  it("computes cancellation and no-show rates as percentages of the total", () => {
    const agg = aggregateAppointments(
      [
        row({ status: "completed", start_at: "2026-08-10T05:00:00Z" }),
        row({ status: "completed", start_at: "2026-08-10T06:00:00Z" }),
        row({ status: "cancelled", start_at: "2026-08-10T07:00:00Z" }),
        row({ status: "no_show", start_at: "2026-08-10T08:00:00Z" }),
      ],
      TZ,
    );
    expect(agg.cancellationRate).toBe(25);
    expect(agg.noShowRate).toBe(25);
  });

  it("returns 0% rates (never NaN/Infinity) for an empty range", () => {
    const agg = aggregateAppointments([], TZ);
    expect(agg.cancellationRate).toBe(0);
    expect(agg.noShowRate).toBe(0);
    expect(agg.total).toBe(0);
    expect(agg.totalRevenue).toBe(0);
  });

  it("tracks per-service and per-doctor booking count separately from completed count", () => {
    const agg = aggregateAppointments(
      [
        row({ status: "completed", start_at: "2026-08-10T05:00:00Z" }),
        row({ status: "cancelled", start_at: "2026-08-10T06:00:00Z" }),
        row({ status: "no_show", start_at: "2026-08-10T07:00:00Z" }),
      ],
      TZ,
    );
    expect(agg.topServices[0]).toMatchObject({ name: "Konsultatsiya", count: 3, completedCount: 1 });
    expect(agg.topDoctors[0]).toMatchObject({ name: "Dr A", count: 3, completedCount: 1, completionRate: 33.3 });
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

import { describe, expect, it } from "vitest";
import { aggregateLabOrders, allocatePayment, durationStats, type LabAnalyticsItem, type LabAnalyticsOrder } from "./lab";

const TZ = "Asia/Tashkent";
const H = 3_600_000;
const t0 = Date.parse("2026-09-01T05:00:00Z");
const at = (hours: number) => new Date(t0 + hours * H).toISOString();

function item(over: Partial<LabAnalyticsItem> = {}): LabAnalyticsItem {
  return {
    testId: "t-cbc",
    testName: "Umumiy qon tahlili",
    category: "Gematologiya",
    price: 50_000,
    status: "verified",
    statusChangedAt: at(10),
    collectedAt: at(1),
    targetHours: 24,
    ...over,
  };
}

function order(over: Partial<LabAnalyticsOrder> = {}): LabAnalyticsOrder {
  return {
    createdAt: at(0),
    status: "completed",
    source: "consultation",
    cancelReason: null,
    patientKey: "p1",
    payment: { status: "paid", amount: 50_000, paidAt: at(0.5) },
    items: [item()],
    ...over,
  };
}

describe("lab analytics: revenue from payment records", () => {
  it("recognizes a paid, verified test at the paid amount — never the catalog price", () => {
    // The stored price was 50 000; the patient actually paid 45 000 (e.g. an
    // allocated panel share recorded as the order's bill). Revenue follows the payment.
    const agg = aggregateLabOrders([order({ payment: { status: "paid", amount: 45_000, paidAt: at(0.5) } })], [], TZ);
    expect(agg.finance.recognized).toBe(45_000);
    expect(agg.finance.paidTotal).toBe(45_000);
    expect(agg.finance.revenueByTest).toEqual([{ name: "Umumiy qon tahlili", revenue: 45_000, count: 1 }]);
    expect(agg.finance.revenueByCategory).toEqual([{ name: "Gematologiya", revenue: 45_000 }]);
  });

  it("splits paid money into delivered, in progress and to refund — always adding up to the paid total", () => {
    const agg = aggregateLabOrders(
      [
        order({
          payment: { status: "paid", amount: 100_000, paidAt: at(0.5) },
          items: [
            item({ testId: "a", testName: "A", price: 40_000 }),
            item({ testId: "b", testName: "B", price: 35_000, status: "processing" }),
            item({ testId: "c", testName: "C", price: 25_000, status: "cancelled", statusChangedAt: at(3) }),
          ],
        }),
      ],
      [],
      TZ,
    );
    expect(agg.finance.recognized).toBe(40_000);
    expect(agg.finance.prepaidInProgress).toBe(35_000);
    expect(agg.finance.toRefund).toBe(25_000);
    expect(agg.finance.recognized + agg.finance.prepaidInProgress + agg.finance.toRefund).toBe(agg.finance.paidTotal);
  });

  it("a test cancelled before payment was never billed, so it takes no share", () => {
    const shares = allocatePayment(60_000, at(5), [
      item({ testId: "a", price: 60_000 }),
      item({ testId: "b", price: 30_000, status: "cancelled", statusChangedAt: at(2) }),
    ]);
    expect(shares.map((s) => [s.item.testId, s.share])).toEqual([["a", 60_000]]);
  });

  it("scales shares so they always add up to the money received", () => {
    const shares = allocatePayment(90_000, at(1), [item({ testId: "a", price: 50_000 }), item({ testId: "b", price: 50_000 })]);
    expect(shares.map((s) => s.share)).toEqual([45_000, 45_000]);
  });

  it("unpaid, pending, failed and refunded payments are never revenue", () => {
    const agg = aggregateLabOrders(
      [
        order({ payment: { status: "unpaid", amount: 10_000, paidAt: null } }),
        order({ payment: { status: "pending", amount: 20_000, paidAt: null } }),
        order({ payment: { status: "manual_review", amount: 5_000, paidAt: null } }),
        order({ payment: { status: "failed", amount: 7_000, paidAt: null } }),
        order({ payment: { status: "refunded", amount: 30_000, paidAt: at(1) } }),
        order({ payment: null }),
      ],
      [],
      TZ,
    );
    expect(agg.finance).toMatchObject({ recognized: 0, paidTotal: 0, unpaid: 10_000, pending: 25_000, refunded: 30_000, paidOrders: 0, averagePaidOrder: 0 });
    expect(agg.finance.revenueByTest).toEqual([]);
  });

  it("buckets revenue by the order's clinic-local day, week and month", () => {
    const agg = aggregateLabOrders([order({ createdAt: "2026-08-31T20:00:00Z" })], [], TZ); // 01:00 on 1 Sep in Tashkent
    expect(agg.finance.revenueTrend).toEqual([{ date: "2026-09-01", revenue: 50_000 }]);
    expect(agg.finance.revenueByMonth).toEqual([{ key: "2026-09", revenue: 50_000 }]);
    expect(agg.finance.revenueByWeek[0].key).toBe("2026-W36");
  });
});

describe("lab analytics: volume, cancellations, turnaround, repeats", () => {
  it("counts volume by test, category and source, and cancellations with reasons", () => {
    const agg = aggregateLabOrders(
      [
        order(),
        order({ source: "walk_in", items: [item({ testId: "g", testName: "Glyukoza", category: null })] }),
        order({ status: "cancelled", cancelReason: "  Bemor kelmadi ", items: [item({ status: "cancelled" })] }),
      ],
      [],
      TZ,
    );
    expect(agg.orders).toBe(3);
    expect(agg.tests).toBe(3);
    expect(agg.cancelledOrders).toBe(1);
    expect(agg.cancelledTests).toBe(1);
    expect(agg.cancellationRate).toBe(33.3);
    expect(agg.cancelReasons).toEqual([{ reason: "Bemor kelmadi", count: 1 }]);
    expect(agg.byCategory).toEqual(expect.arrayContaining([{ name: "Gematologiya", count: 1 }, { name: "Bo‘limsiz", count: 1 }]));
    expect(agg.bySource).toEqual(expect.arrayContaining([["consultation", 2], ["walk_in", 1]]));
  });

  it("turnaround from order and from collection, with median, p90 and the test's target", () => {
    const agg = aggregateLabOrders(
      [
        order({ items: [item({ collectedAt: at(1), statusChangedAt: at(5) })] }), // 5 h / 4 h
        order({ items: [item({ collectedAt: at(1), statusChangedAt: at(11) })] }), // 11 h / 10 h
        order({ items: [item({ collectedAt: at(1), statusChangedAt: at(31) })] }), // 31 h / 30 h → late (target 24)
        order({ items: [item({ status: "processing", collectedAt: at(1) })] }), // not verified: not counted
      ],
      [],
      TZ,
    );
    expect(agg.turnaround.orderToVerified).toEqual({ count: 3, medianHours: 11, p90Hours: 31 });
    expect(agg.turnaround.collectedToVerified).toEqual({ count: 3, medianHours: 10, p90Hours: 30 });
    expect([agg.turnaround.onTime, agg.turnaround.late]).toEqual([2, 1]);
    expect(durationStats([])).toEqual({ count: 0, medianHours: null, p90Hours: null });
  });

  it("repeats: the same person and test within the window, including one ordered just before the period", () => {
    const agg = aggregateLabOrders(
      [
        order({ createdAt: at(24 * 3), patientKey: "p1" }), // repeat of the history order (5 days earlier)
        order({ createdAt: at(24 * 10), patientKey: "p1" }), // repeat of the one above (7 days)
        order({ createdAt: at(24 * 50), patientKey: "p1" }), // 40 days later: not a repeat
        order({ createdAt: at(24 * 10), patientKey: "p2" }), // another person: not a repeat
        order({ createdAt: at(24 * 11), patientKey: "p2", items: [item({ testId: "other", testName: "Boshqa" })] }), // other test
      ],
      [{ patientKey: "p1", testId: "t-cbc", createdAt: at(-24 * 2) }],
      TZ,
      { repeatWindowDays: 30 },
    );
    expect(agg.repeats.repeatedTests).toBe(2);
    expect(agg.repeats.byTest).toEqual([{ name: "Umumiy qon tahlili", count: 2 }]);
    expect(agg.repeats.rate).toBe(40);
  });

  it("returns no patient key or identifier anywhere in the result", () => {
    const agg = aggregateLabOrders([order({ patientKey: "secret-patient-key" })], [{ patientKey: "secret-patient-key", testId: "t-cbc", createdAt: at(-1) }], TZ);
    expect(JSON.stringify(agg)).not.toContain("secret-patient-key");
  });
});

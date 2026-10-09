import { describe, expect, it } from "vitest";
import { queueOrder, turnTime, type VisitSummary } from "@/lib/operations/outpatient";

/**
 * The doctor's queue (owner decision 2026-10-08): patients who booked online take their turn at their booked time,
 * walk-ins when they paid — fitted between them; a booked patient more than 10 minutes late goes behind those waiting.
 */
const visit = (id: string, v: Partial<VisitSummary>): VisitSummary =>
  ({
    id,
    kind: "doctor",
    labOrderId: null,
    status: "waiting",
    queueDate: "2026-10-09",
    queueNumber: 1,
    arrivedAt: "2026-10-09T04:00:00Z",
    queuedAt: "2026-10-09T04:00:00Z",
    calledAt: null,
    source: "desk",
    slotAt: null,
    patient: { id, patientNumber: 1, fullName: id },
    doctor: { id: "d", name: "Dr" },
    balance: { charged: 0, collected: 0, refunded: 0, outstanding: 0, cashNet: 0, terminalNet: 0, onlineNet: 0 },
    charges: [],
    ...v,
  }) as VisitSummary;

describe("queue order", () => {
  it("orders booked patients by their time and fits walk-ins between them by when they paid", () => {
    const booked10 = visit("booked-10:00", { source: "online", slotAt: "2026-10-09T05:00:00Z", queueNumber: 1, arrivedAt: "2026-10-09T04:50:00Z" });
    const booked11 = visit("booked-11:00", { source: "online", slotAt: "2026-10-09T06:00:00Z", queueNumber: 2, arrivedAt: "2026-10-09T05:55:00Z" });
    const walkIn1030 = visit("walk-in-10:30", { queuedAt: "2026-10-09T05:30:00Z", queueNumber: 3 });
    const walkIn0900 = visit("walk-in-09:00", { queuedAt: "2026-10-09T04:00:00Z", queueNumber: 4 });
    const order = [booked11, walkIn1030, booked10, walkIn0900].sort(queueOrder).map((v) => v.id);
    expect(order).toEqual(["walk-in-09:00", "booked-10:00", "walk-in-10:30", "booked-11:00"]);
  });

  it("a booked patient more than 10 minutes late takes their turn from arrival", () => {
    const late = visit("late", { source: "online", slotAt: "2026-10-09T05:00:00Z", arrivedAt: "2026-10-09T05:25:00Z" });
    expect(turnTime(late)).toBe("2026-10-09T05:25:00.000Z");
    const onTime = visit("on-time", { source: "online", slotAt: "2026-10-09T05:00:00Z", arrivedAt: "2026-10-09T05:08:00Z" });
    expect(turnTime(onTime)).toBe("2026-10-09T05:00:00.000Z");
    const walkIn = visit("walk-in", { queuedAt: "2026-10-09T05:10:00Z", queueNumber: 9 });
    expect([late, walkIn].sort(queueOrder).map((v) => v.id)).toEqual(["walk-in", "late"]);
  });

  it("an earlier clinic day always comes first; unpaid visits after the numbered ones", () => {
    const yesterday = visit("yesterday", { queueDate: "2026-10-08", queuedAt: "2026-10-08T12:00:00Z" });
    const today = visit("today", { queuedAt: "2026-10-09T03:00:00Z" });
    const unpaid = visit("unpaid", { queueNumber: null, queuedAt: null, status: "awaiting_payment" });
    expect([unpaid, today, yesterday].sort(queueOrder).map((v) => v.id)).toEqual(["yesterday", "today", "unpaid"]);
  });
});

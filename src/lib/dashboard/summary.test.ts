import { describe, expect, it } from "vitest";
import { outstandingOf, summarizeMoney, summarizeQueue, type QueueVisit } from "./summary";

const now = new Date("2026-10-12T08:00:00Z");
const minutesAgo = (m: number) => new Date(now.getTime() - m * 60_000).toISOString();
const drA = { id: "a", name: "Dr Aliyev" };
const drB = { id: "b", name: "Dr Botirova" };
const visit = (v: Partial<QueueVisit> & Pick<QueueVisit, "status">): QueueVisit => ({
  kind: "doctor",
  queuedAt: null,
  doctor: drA,
  balance: { outstanding: 0 },
  ...v,
});

describe("summarizeQueue — the live walk-in queue on the dashboard", () => {
  it("counts every open visit by status; the kassa line is not a doctor's queue", () => {
    const s = summarizeQueue(
      [
        visit({ status: "awaiting_payment" }),
        visit({ status: "awaiting_payment", doctor: drB }),
        visit({ status: "waiting", queuedAt: minutesAgo(5) }),
        visit({ status: "called" }),
        visit({ status: "in_progress", doctor: drB }),
        visit({ status: "completed" }),
        visit({ status: "cancelled" }),
      ],
      now,
    );
    expect(s).toMatchObject({ awaitingPayment: 2, waiting: 1, called: 1, inProgress: 1, longestWaitMinutes: 5 });
    expect(s.byQueue.map((q) => [q.name, q.waiting, q.called, q.inProgress])).toEqual([
      ["Dr Aliyev", 1, 1, 0],
      ["Dr Botirova", 0, 0, 1],
    ]);
  });

  it("puts the laboratory in its own line and orders the busiest, longest-waiting queue first", () => {
    const s = summarizeQueue(
      [
        visit({ status: "waiting", queuedAt: minutesAgo(3) }),
        visit({ status: "waiting", kind: "lab", doctor: null, queuedAt: minutesAgo(40) }),
        visit({ status: "waiting", kind: "lab", doctor: null, queuedAt: minutesAgo(10) }),
        visit({ status: "waiting", doctor: drB, queuedAt: minutesAgo(90) }),
      ],
      now,
    );
    expect(s.byQueue.map((q) => [q.key, q.waiting, q.longestWaitMinutes])).toEqual([
      ["lab", 2, 40],
      ["b", 1, 90],
      ["a", 1, 3],
    ]);
    expect(s.byQueue[0].name).toBe("Laboratoriya");
    expect(s.longestWaitMinutes).toBe(90);
  });

  it("an empty clinic has no lines and no wait", () => {
    expect(summarizeQueue([], now)).toEqual({ awaitingPayment: 0, waiting: 0, called: 0, inProgress: 0, longestWaitMinutes: null, byQueue: [] });
  });
});

describe("outstandingOf — what open visits still owe", () => {
  it("adds what is owed; money due back to a patient is not debt", () => {
    expect(
      outstandingOf([
        visit({ status: "awaiting_payment", balance: { outstanding: 150000 } }),
        visit({ status: "waiting", balance: { outstanding: 25000.5 } }),
        visit({ status: "in_progress", balance: { outstanding: -40000 } }),
      ]),
    ).toBe(175000.5);
  });
});

describe("summarizeMoney — money actually received today", () => {
  it("nets each kassa method, keeps refunds visible and adds the laboratory and appointment channels once", () => {
    const m = summarizeMoney(
      [
        { kind: "collection", method: "cash", amount: "100000" },
        { kind: "collection", method: "terminal", amount: 50000 },
        { kind: "collection", method: "online", amount: 80000 },
        { kind: "refund", method: "cash", amount: 20000 },
        { kind: "collection", method: "cheque", amount: 999 },
      ],
      [30000, 15000],
      [60000],
    );
    expect(m.kassa).toEqual({ cash: 80000, terminal: 50000, online: 80000, refunded: 20000, net: 210000 });
    expect(m.lab).toBe(45000);
    expect(m.appointments).toBe(60000);
    expect(m.total).toBe(315000);
  });

  it("a day without money is zero, not missing", () => {
    expect(summarizeMoney([], [], [])).toEqual({
      total: 0,
      kassa: { cash: 0, terminal: 0, online: 0, refunded: 0, net: 0 },
      lab: 0,
      appointments: 0,
    });
  });
});

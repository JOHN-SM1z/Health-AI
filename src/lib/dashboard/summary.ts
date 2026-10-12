/**
 * Pure aggregation for the staff "Bugun" dashboard (src/lib/dashboard/today.ts).
 * No database access here, so every rule is unit-tested on its own.
 */

export type QueueVisit = {
  kind: "doctor" | "lab";
  status: "booked" | "awaiting_payment" | "waiting" | "called" | "in_progress" | "completed" | "cancelled";
  queuedAt: string | null;
  doctor: { id: string; name: string } | null;
  balance: { outstanding: number };
};

export type QueueLine = {
  key: string;
  name: string;
  kind: "doctor" | "lab";
  waiting: number;
  called: number;
  inProgress: number;
  /** Minutes the longest-waiting patient of this queue has waited since joining it. */
  longestWaitMinutes: number | null;
};

export type QueueSummary = {
  awaitingPayment: number;
  waiting: number;
  called: number;
  inProgress: number;
  longestWaitMinutes: number | null;
  /** One line per doctor (and the laboratory) with anyone in their queue; busiest first. */
  byQueue: QueueLine[];
};

const minutesSince = (iso: string, now: Date) => Math.max(0, Math.floor((now.getTime() - Date.parse(iso)) / 60_000));

/** The open walk-in visits (awaiting payment, waiting, called, in progress) as counts and per-queue lines. */
export function summarizeQueue(visits: readonly QueueVisit[], now = new Date()): QueueSummary {
  const summary: QueueSummary = { awaitingPayment: 0, waiting: 0, called: 0, inProgress: 0, longestWaitMinutes: null, byQueue: [] };
  const lines = new Map<string, QueueLine>();
  for (const v of visits) {
    if (v.status === "awaiting_payment") summary.awaitingPayment += 1;
    else if (v.status === "waiting") summary.waiting += 1;
    else if (v.status === "called") summary.called += 1;
    else if (v.status === "in_progress") summary.inProgress += 1;
    else continue;
    // Awaiting payment is the kassa's line, not yet a doctor's or the laboratory's queue.
    if (v.status === "awaiting_payment") continue;

    const key = v.kind === "lab" ? "lab" : (v.doctor?.id ?? "unassigned");
    const line = lines.get(key) ?? {
      key,
      name: v.kind === "lab" ? "Laboratoriya" : (v.doctor?.name ?? "Shifokor"),
      kind: v.kind,
      waiting: 0,
      called: 0,
      inProgress: 0,
      longestWaitMinutes: null,
    };
    if (v.status === "waiting") {
      line.waiting += 1;
      if (v.queuedAt) {
        const waited = minutesSince(v.queuedAt, now);
        line.longestWaitMinutes = Math.max(line.longestWaitMinutes ?? 0, waited);
        summary.longestWaitMinutes = Math.max(summary.longestWaitMinutes ?? 0, waited);
      }
    } else if (v.status === "called") line.called += 1;
    else line.inProgress += 1;
    lines.set(key, line);
  }
  summary.byQueue = [...lines.values()].sort(
    (a, b) => b.waiting + b.called - (a.waiting + a.called) || (b.longestWaitMinutes ?? 0) - (a.longestWaitMinutes ?? 0) || a.name.localeCompare(b.name),
  );
  return summary;
}

/** Sum of what open visits still owe (charges not yet paid). Never negative per visit: money due back is not debt. */
export function outstandingOf(visits: readonly QueueVisit[]): number {
  return round2(visits.reduce((sum, v) => sum + Math.max(0, Number(v.balance.outstanding) || 0), 0));
}

export type KassaRow = { kind: "collection" | "refund" | string; method: "cash" | "terminal" | "online" | string; amount: number | string };

export type MoneyToday = {
  /** Net money received today across every channel below. */
  total: number;
  /** The kassa ledger (walk-in and online-paid visits): net per method, and what was paid back. */
  kassa: { cash: number; terminal: number; online: number; refunded: number; net: number };
  /** Laboratory orders paid at the laboratory kassa (not on a visit bill). */
  lab: number;
  /** Booked appointments marked paid outside the kassa (no visit). */
  appointments: number;
};

/**
 * Money actually received today. Each payment is counted once:
 *  - visit money lives only in the kassa ledger (an online-paid booking's payment row is excluded by the caller,
 *    because its visit already carries the same amount as an online collection);
 *  - a lab order billed to a visit never gets its own payment row (20261008000001).
 */
export function summarizeMoney(kassa: readonly KassaRow[], labPaid: readonly number[], appointmentPaid: readonly number[]): MoneyToday {
  const net = { cash: 0, terminal: 0, online: 0 };
  let refunded = 0;
  for (const t of kassa) {
    const amount = Number(t.amount) || 0;
    const method = t.method === "cash" || t.method === "terminal" || t.method === "online" ? t.method : null;
    if (!method) continue;
    if (t.kind === "collection") net[method] += amount;
    else if (t.kind === "refund") {
      net[method] -= amount;
      refunded += amount;
    }
  }
  const kassaNet = net.cash + net.terminal + net.online;
  const lab = labPaid.reduce((s, a) => s + (Number(a) || 0), 0);
  const appointments = appointmentPaid.reduce((s, a) => s + (Number(a) || 0), 0);
  return {
    total: round2(kassaNet + lab + appointments),
    kassa: { cash: round2(net.cash), terminal: round2(net.terminal), online: round2(net.online), refunded: round2(refunded), net: round2(kassaNet) },
    lab: round2(lab),
    appointments: round2(appointments),
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * The recent-similar-test warning (Phase 5): for each test about to be
 * ordered, the patient's most recent earlier order of the same test within
 * `windowDays`, ignoring cancelled ones. Information only — it never blocks
 * an order and never judges whether a test is necessary.
 */

export type PreviousOrder = { createdAt: string; items: Array<{ id: string; testId: string; status: string }> };

export type RecentMatch = { testId: string; itemId: string; status: string; createdAt: string; daysAgo: number };

const DAY = 86_400_000;

export function findRecentSimilar(testIds: readonly string[], previous: readonly PreviousOrder[], windowDays: number, now: number): RecentMatch[] {
  const cutoff = now - windowDays * DAY;
  const matches: RecentMatch[] = [];
  for (const testId of new Set(testIds)) {
    let best: RecentMatch | null = null;
    for (const order of previous) {
      const at = new Date(order.createdAt).getTime();
      if (Number.isNaN(at) || at < cutoff || at > now) continue;
      for (const item of order.items) {
        if (item.testId !== testId || item.status === "cancelled") continue;
        if (!best || at > new Date(best.createdAt).getTime()) {
          best = { testId, itemId: item.id, status: item.status, createdAt: order.createdAt, daysAgo: Math.floor((now - at) / DAY) };
        }
      }
    }
    if (best) matches.push(best);
  }
  return matches;
}

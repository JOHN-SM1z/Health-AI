import { describe, expect, it } from "vitest";
import { findRecentSimilar, type PreviousOrder } from "@/lib/labs/recent";

const NOW = Date.UTC(2026, 9, 5, 12, 0);
const ago = (days: number) => new Date(NOW - days * 86_400_000).toISOString();

describe("recent similar test warning", () => {
  const previous: PreviousOrder[] = [
    { createdAt: ago(18), items: [{ id: "i-cbc-18", testId: "cbc", status: "verified" }, { id: "i-glu", testId: "glucose", status: "processing" }] },
    { createdAt: ago(5), items: [{ id: "i-cbc-5", testId: "cbc", status: "cancelled" }] },
    { createdAt: ago(45), items: [{ id: "i-alt-45", testId: "alt", status: "verified" }] },
  ];

  it("finds the latest non-cancelled order of the same test inside the window (CBC — 18 days ago)", () => {
    expect(findRecentSimilar(["cbc"], previous, 30, NOW)).toEqual([
      { testId: "cbc", itemId: "i-cbc-18", status: "verified", createdAt: ago(18), daysAgo: 18 },
    ]);
  });

  it("ignores cancelled orders, orders outside the window and other tests", () => {
    expect(findRecentSimilar(["alt", "ast"], previous, 30, NOW)).toEqual([]);
    expect(findRecentSimilar(["alt"], previous, 60, NOW)).toHaveLength(1);
  });

  it("reports pending (unverified) earlier orders too, once per test", () => {
    expect(findRecentSimilar(["glucose", "glucose"], previous, 30, NOW)).toEqual([
      { testId: "glucose", itemId: "i-glu", status: "processing", createdAt: ago(18), daysAgo: 18 },
    ]);
  });

  it("finds nothing for a patient without earlier orders", () => {
    expect(findRecentSimilar(["cbc"], [], 30, NOW)).toEqual([]);
  });
});

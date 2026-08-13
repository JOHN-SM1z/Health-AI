import { describe, it, expect } from "vitest";
import { canTransition } from "@/lib/payments/status";
import { rateLimit, keyFromIp, RateLimitExceededError } from "@/lib/rate-limit";

describe("canTransition (payment status machine)", () => {
  it("allows the documented legal transitions", () => {
    expect(canTransition("unpaid", "paid")).toBe(true);
    expect(canTransition("unpaid", "pending")).toBe(true);
    expect(canTransition("pending", "paid")).toBe(true);
    expect(canTransition("pending", "failed")).toBe(true);
    expect(canTransition("manual_review", "paid")).toBe(true);
    expect(canTransition("paid", "refunded")).toBe(true);
    expect(canTransition("paid", "manual_review")).toBe(true);
    expect(canTransition("failed", "pending")).toBe(true);
  });

  it("blocks illegal and terminal transitions", () => {
    expect(canTransition("paid", "unpaid")).toBe(false);
    expect(canTransition("paid", "paid")).toBe(false);
    expect(canTransition("refunded", "paid")).toBe(false);
    expect(canTransition("refunded", "pending")).toBe(false);
    expect(canTransition("pending", "pending")).toBe(false);
    expect(canTransition("failed", "paid")).toBe(false);
  });
});

describe("rateLimit", () => {
  it("allows up to the limit and rejects beyond it", () => {
    const key = "test-key-1";
    expect(rateLimit({ key, limit: 3, windowMs: 60_000 }).ok).toBe(true);
    expect(rateLimit({ key, limit: 3, windowMs: 60_000 }).ok).toBe(true);
    expect(rateLimit({ key, limit: 3, windowMs: 60_000 }).ok).toBe(true);
    const rejected = rateLimit({ key, limit: 3, windowMs: 60_000 });
    expect(rejected.ok).toBe(false);
    expect(rejected.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("resets after the window expires", () => {
    const key = "test-key-2";
    expect(rateLimit({ key, limit: 1, windowMs: 10 }).ok).toBe(true);
    expect(rateLimit({ key, limit: 1, windowMs: 10 }).ok).toBe(false);
  });

  it("keeps independent buckets per key", () => {
    expect(rateLimit({ key: "a", limit: 1, windowMs: 60_000 }).ok).toBe(true);
    expect(rateLimit({ key: "a", limit: 1, windowMs: 60_000 }).ok).toBe(false);
    expect(rateLimit({ key: "b", limit: 1, windowMs: 60_000 }).ok).toBe(true);
  });
});

describe("keyFromIp", () => {
  it("prefixes and defaults unknown IPs", () => {
    expect(keyFromIp("1.2.3.4", "webhook")).toBe("1.2.3.4:webhook");
    expect(keyFromIp(null, "webhook")).toBe("unknown:webhook");
  });
});

describe("RateLimitExceededError", () => {
  it("is an Error", () => {
    const e = new RateLimitExceededError();
    expect(e).toBeInstanceOf(Error);
    expect(e.message).toBe("rate limit exceeded");
  });
});
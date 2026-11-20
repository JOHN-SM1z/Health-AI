import { describe, expect, it } from "vitest";
import { newIdempotencyKey } from "./idempotency-key";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("newIdempotencyKey", () => {
  it("returns distinct v4 UUIDs", () => {
    const keys = new Set(Array.from({ length: 50 }, newIdempotencyKey));
    expect(keys.size).toBe(50);
    for (const key of keys) expect(key).toMatch(UUID_V4);
  });

  it("still returns a v4 UUID where crypto.randomUUID is unavailable", () => {
    const original = Object.getOwnPropertyDescriptor(crypto, "randomUUID") ?? Object.getOwnPropertyDescriptor(Object.getPrototypeOf(crypto), "randomUUID");
    Object.defineProperty(crypto, "randomUUID", { value: undefined, configurable: true });
    try {
      expect(newIdempotencyKey()).toMatch(UUID_V4);
    } finally {
      if (original && Object.prototype.hasOwnProperty.call(crypto, "randomUUID")) delete (crypto as { randomUUID?: unknown }).randomUUID;
      if (original && typeof crypto.randomUUID !== "function") Object.defineProperty(crypto, "randomUUID", original);
    }
    expect(typeof crypto.randomUUID).toBe("function");
  });
});

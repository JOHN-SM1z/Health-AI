import { beforeEach, describe, expect, it, vi } from "vitest";

const rpc = vi.hoisted(() => ({ impl: (async () => ({ data: null, error: null })) as (...args: unknown[]) => Promise<unknown> }));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ rpc: (...args: unknown[]) => rpc.impl(...args) }),
}));

import { sharedRateLimit } from "./rate-limit-shared";

describe("sharedRateLimit", () => {
  beforeEach(() => {
    rpc.impl = async () => ({ data: null, error: null });
  });

  it("asks the database, with the window in seconds, and returns its verdict", async () => {
    const calls: unknown[][] = [];
    rpc.impl = async (...args) => {
      calls.push(args);
      return { data: { allowed: false, retry_after_seconds: 17 }, error: null };
    };
    expect(await sharedRateLimit({ key: "k1", limit: 60, windowMs: 60_000 })).toEqual({ ok: false, retryAfterSeconds: 17 });
    expect(calls).toEqual([["consume_rate_limit", { p_key: "k1", p_limit: 60, p_window_seconds: 60 }]]);
  });

  it("falls back to this instance's limit when the database cannot answer — never unlimited", async () => {
    rpc.impl = async () => ({ data: null, error: { code: "PGRST202" } });
    const key = `fallback-${Date.now()}`;
    expect((await sharedRateLimit({ key, limit: 2, windowMs: 60_000 })).ok).toBe(true);
    expect((await sharedRateLimit({ key, limit: 2, windowMs: 60_000 })).ok).toBe(true);
    expect((await sharedRateLimit({ key, limit: 2, windowMs: 60_000 })).ok).toBe(false);

    rpc.impl = async () => {
      throw new Error("network down");
    };
    expect((await sharedRateLimit({ key, limit: 2, windowMs: 60_000 })).ok).toBe(false);
  });
});

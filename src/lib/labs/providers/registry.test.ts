import { afterEach, describe, expect, it, vi } from "vitest";

/** Adapters fail closed: unknown names and test-only adapters in production are refused (Phase 15). */
describe("lab provider registry", () => {
  afterEach(() => {
    vi.resetModules();
    vi.doUnmock("@/lib/env");
  });

  it("offers the mock adapter outside production only", async () => {
    const saved = process.env.ALLOW_MOCK_LAB_PROVIDER;
    process.env.ALLOW_MOCK_LAB_PROVIDER = "false";
    vi.doMock("@/lib/env", () => ({ isProduction: false }));
    const dev = await import("./registry");
    expect(dev.getLabAdapter("mock")?.kind).toBe("mock");
    expect(dev.availableAdapters()).toEqual(["mock"]);
    expect(dev.getLabAdapter("medplus")).toBeNull();

    vi.resetModules();
    vi.doMock("@/lib/env", () => ({ isProduction: true }));
    const prod = await import("./registry");
    expect(prod.getLabAdapter("mock")).toBeNull();
    expect(prod.availableAdapters()).toEqual([]);
    process.env.ALLOW_MOCK_LAB_PROVIDER = saved;
  });

  it("allows the mock in a production build only when explicitly allowed against a local database", async () => {
    const saved = { flag: process.env.ALLOW_MOCK_LAB_PROVIDER, url: process.env.NEXT_PUBLIC_SUPABASE_URL };
    try {
      vi.doMock("@/lib/env", () => ({ isProduction: true }));
      process.env.ALLOW_MOCK_LAB_PROVIDER = "true";
      process.env.NEXT_PUBLIC_SUPABASE_URL = "http://127.0.0.1:54321";
      expect((await import("./registry")).getLabAdapter("mock")?.kind).toBe("mock");
      vi.resetModules();
      process.env.NEXT_PUBLIC_SUPABASE_URL = "https://abc.supabase.co";
      expect((await import("./registry")).getLabAdapter("mock")).toBeNull();
      vi.resetModules();
      process.env.NEXT_PUBLIC_SUPABASE_URL = "http://localhost.evil.example";
      expect((await import("./registry")).getLabAdapter("mock")).toBeNull();
      vi.resetModules();
      process.env.ALLOW_MOCK_LAB_PROVIDER = "false";
      process.env.NEXT_PUBLIC_SUPABASE_URL = "http://127.0.0.1:54321";
      expect((await import("./registry")).getLabAdapter("mock")).toBeNull();
    } finally {
      process.env.ALLOW_MOCK_LAB_PROVIDER = saved.flag;
      process.env.NEXT_PUBLIC_SUPABASE_URL = saved.url;
    }
  });
});

describe("mock provider webhook authentication", () => {
  it("reads nothing without a valid signature", async () => {
    const { mockLabProvider, mockSignature } = await import("./mock");
    const ctx = { providerId: "p", clinicId: "c", config: {}, credential: "secret" };
    const raw = JSON.stringify({ events: [{ type: "status", externalOrderId: "MOCK-1", status: "in_progress" }] });
    const headers = (sig: string) => new Headers({ "x-mock-signature": sig });
    expect(await mockLabProvider.parseWebhook(ctx, { headers: headers(mockSignature("secret", raw)), rawBody: raw })).toEqual({
      ok: true,
      events: [{ type: "status", externalOrderId: "MOCK-1", status: "in_progress" }],
    });
    expect(await mockLabProvider.parseWebhook(ctx, { headers: headers(mockSignature("other", raw)), rawBody: raw })).toEqual({ ok: false, kind: "unauthenticated" });
    expect(await mockLabProvider.parseWebhook({ ...ctx, credential: null }, { headers: headers(mockSignature("secret", raw)), rawBody: raw })).toEqual({ ok: false, kind: "unauthenticated" });
    const bad = JSON.stringify({ events: [{ type: "status", externalOrderId: "MOCK-1", status: "done" }] });
    expect(await mockLabProvider.parseWebhook(ctx, { headers: headers(mockSignature("secret", bad)), rawBody: bad })).toEqual({ ok: false, kind: "invalid" });
  });
});

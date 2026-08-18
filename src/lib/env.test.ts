import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Production fail-closed behavior for environment configuration.
 * The real `@/lib/env` module is re-imported with a stubbed environment.
 */
describe("env fail-closed guards", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_PHASE", "");
    vi.stubEnv("CRON_SECRET", undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("rejects the known-insecure default CRON_SECRET in production", async () => {
    vi.stubEnv("CRON_SECRET", "change-me-in-production");
    await expect(import("@/lib/env")).rejects.toThrow(/CRON_SECRET/);
  });

  it("fails closed when CRON_SECRET is missing in production", async () => {
    await expect(import("@/lib/env")).rejects.toThrow(/CRON_SECRET/);
  });

  it("loads when CRON_SECRET is set explicitly", async () => {
    vi.stubEnv("CRON_SECRET", "0123456789abcdef0123456789abcdef");
    const mod = await import("@/lib/env");
    expect(mod.env.CRON_SECRET).toBe("0123456789abcdef0123456789abcdef");
  });

  it("allows the default CRON_SECRET outside production (dev ergonomics)", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const mod = await import("@/lib/env");
    expect(mod.env.CRON_SECRET).toBe("change-me-in-production");
  });
});

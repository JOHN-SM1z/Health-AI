import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { register } from "@/instrumentation";

/**
 * Production fail-closed startup checks. register() reads process.env
 * directly (not the cached @/lib/env singleton), so no module reset is
 * needed — just stub env vars per test.
 */
describe("instrumentation register() — production fail-closed checks", () => {
  beforeEach(() => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_PHASE", "");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
    vi.stubEnv("SUPABASE_URL", undefined);
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon-key");
    vi.stubEnv("SUPABASE_ANON_KEY", undefined);
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-role-key");
    vi.stubEnv("CRON_SECRET", "0123456789abcdef0123456789abcdef");
    vi.stubEnv("TELEGRAM_BOT_TOKEN", undefined);
    vi.stubEnv("TELEGRAM_WEBHOOK_SECRET", "0123456789abcdef0123456789abcdef");
    vi.stubEnv("ENABLE_TELEGRAM_DEV_MODE", undefined);
    vi.stubEnv("PAYMENT_PROVIDER", undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("does not throw when every required secret is present and valid", () => {
    expect(() => register()).not.toThrow();
  });

  it("is a no-op outside production", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("TELEGRAM_WEBHOOK_SECRET", undefined);
    vi.stubEnv("CRON_SECRET", undefined);
    expect(() => register()).not.toThrow();
  });

  it("is a no-op during the production build phase", () => {
    vi.stubEnv("NEXT_PHASE", "phase-production-build");
    vi.stubEnv("TELEGRAM_WEBHOOK_SECRET", undefined);
    expect(() => register()).not.toThrow();
  });

  it("fails closed when TELEGRAM_WEBHOOK_SECRET is missing, even with TELEGRAM_BOT_TOKEN unset", () => {
    // Regression test: the legacy, optional admin-notification bot token
    // must never gate this check. Per-clinic bots (activated from the
    // clinic dashboard, independent of TELEGRAM_BOT_TOKEN) need
    // TELEGRAM_WEBHOOK_SECRET to validate their webhooks from the moment
    // any clinic could plausibly activate one — i.e. always in production.
    vi.stubEnv("TELEGRAM_WEBHOOK_SECRET", undefined);
    expect(() => register()).toThrow(/TELEGRAM_WEBHOOK_SECRET/);
  });

  it("fails closed when TELEGRAM_WEBHOOK_SECRET is missing and TELEGRAM_BOT_TOKEN is set", () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "123456:legacy-admin-bot-token");
    vi.stubEnv("TELEGRAM_WEBHOOK_SECRET", undefined);
    expect(() => register()).toThrow(/TELEGRAM_WEBHOOK_SECRET/);
  });

  it("fails closed when ENABLE_TELEGRAM_DEV_MODE=true", () => {
    vi.stubEnv("ENABLE_TELEGRAM_DEV_MODE", "true");
    expect(() => register()).toThrow(/ENABLE_TELEGRAM_DEV_MODE/);
  });

  it("fails closed when Supabase env vars are missing", () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", undefined);
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", undefined);
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", undefined);
    expect(() => register()).toThrow(/NEXT_PUBLIC_SUPABASE_URL/);
  });

  it("fails closed on the known-default CRON_SECRET", () => {
    vi.stubEnv("CRON_SECRET", "change-me-in-production");
    expect(() => register()).toThrow(/CRON_SECRET/);
  });

  it("fails closed when PAYMENT_PROVIDER is not manual", () => {
    vi.stubEnv("PAYMENT_PROVIDER", "click");
    expect(() => register()).toThrow(/PAYMENT_PROVIDER/);
  });
});

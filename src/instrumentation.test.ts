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
    vi.stubEnv("ONLINE_PAYMENT_PROVIDER", undefined);
    vi.stubEnv("ALLOW_TEST_ONLINE_PAYMENT", undefined);
    vi.stubEnv("TEST_ONLINE_PAYMENT_SECRET", undefined);
    vi.stubEnv("SMS_PROVIDER", undefined);
    vi.stubEnv("ALLOW_TEST_SMS", undefined);
  });

  it("refuses the test SMS outbox in a real deployment, and Eskiz without credentials or a strong callback secret", () => {
    vi.stubEnv("SMS_PROVIDER", "test");
    expect(() => register()).toThrow(/SMS_PROVIDER=test/);
    vi.stubEnv("SMS_PROVIDER", "eskiz");
    expect(() => register()).toThrow(/ESKIZ_EMAIL/);
    vi.stubEnv("ESKIZ_EMAIL", "clinic@example.uz");
    vi.stubEnv("ESKIZ_PASSWORD", "pw");
    vi.stubEnv("ESKIZ_CALLBACK_SECRET", "short");
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://clinic.example.uz");
    expect(() => register()).toThrow(/ESKIZ_CALLBACK_SECRET/);
    vi.stubEnv("ESKIZ_CALLBACK_SECRET", "f3a9c1d27b4e8a6f0c2d9e1b7a5c3f8e2d4b6a9c");
    expect(() => register()).not.toThrow();
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

  it("fails closed on a short, placeholder or single-character CRON_SECRET or TELEGRAM_WEBHOOK_SECRET", () => {
    for (const name of ["CRON_SECRET", "TELEGRAM_WEBHOOK_SECRET"]) {
      for (const weak of ["short-secret", "your-random-secret", "a".repeat(64)]) {
        vi.stubEnv(name, weak);
        expect(() => register(), `${name}=${weak}`).toThrow(new RegExp(name));
        vi.stubEnv(name, "0123456789abcdef0123456789abcdef");
      }
    }
    expect(() => register()).not.toThrow();
  });

  it("fails closed when PAYMENT_PROVIDER is not manual", () => {
    vi.stubEnv("PAYMENT_PROVIDER", "click");
    expect(() => register()).toThrow(/PAYMENT_PROVIDER/);
  });

  it("refuses the test online payment provider in a real deployment, and Rahmat until its adapter exists", () => {
    vi.stubEnv("ONLINE_PAYMENT_PROVIDER", "test_online");
    vi.stubEnv("TEST_ONLINE_PAYMENT_SECRET", "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8");
    expect(() => register()).toThrow(/test_online/); // no explicit flag
    vi.stubEnv("ALLOW_TEST_ONLINE_PAYMENT", "true");
    expect(() => register()).toThrow(/test_online/); // the database is not local
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://127.0.0.1:54321");
    expect(() => register()).not.toThrow(); // an E2E run of a production build against the local stack
    vi.stubEnv("ONLINE_PAYMENT_PROVIDER", "rahmat");
    expect(() => register()).toThrow(/rahmat/);
  });
});

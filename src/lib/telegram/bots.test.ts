import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("server-only", () => ({}));

const supabaseMock = { from: vi.fn() };
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => supabaseMock,
}));

const envMock = vi.hoisted(() => ({
  TELEGRAM_WEBHOOK_SECRET: "deployment-secret",
  NEXT_PUBLIC_APP_URL: "https://health.example.com" as string | undefined,
  TELEGRAM_BOT_TOKEN: "",
}));
vi.mock("@/lib/env", () => ({ env: envMock }));

vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import {
  resolveClinicByBotUsername,
  botWebhookSecret,
  botWebhookUrl,
  timingSafeCheck,
  registerBotWebhook,
} from "@/lib/telegram/bots";

const INTEGRATION_ROW = {
  clinic_id: "clinic-a",
  telegram_bot_token: "111:CLINIC_A_TOKEN",
  telegram_bot_id: 111,
  telegram_username: "clinic_a_bot",
  telegram_bot_name: "Clinic A Bot",
  status: "active",
  enabled: true,
  webhook_status: "active",
  webhook_error: null,
  validated_at: "2026-08-18T00:00:00Z",
};

beforeEach(() => {
  supabaseMock.from.mockReset();
});

function mockLookup(data: unknown, error: unknown = null) {
  supabaseMock.from.mockReturnValue({
    select: vi.fn(() => ({ eq: vi.fn(() => ({ maybeSingle: vi.fn(async () => ({ data, error })) })) })),
  });
}

describe("resolveClinicByBotUsername", () => {
  it("resolves the clinic for a known active bot (username without @)", async () => {
    mockLookup(INTEGRATION_ROW);
    const resolved = await resolveClinicByBotUsername("clinic_a_bot");
    expect(resolved?.clinicId).toBe("clinic-a");
    expect(resolved?.integration.telegram_username).toBe("clinic_a_bot");
    // Lookup is by exact username.
    expect(supabaseMock.from).toHaveBeenCalledWith("clinic_telegram_integrations");
  });

  it("tolerates a leading @ in the username", async () => {
    mockLookup(INTEGRATION_ROW);
    const resolved = await resolveClinicByBotUsername("@clinic_a_bot");
    expect(resolved?.clinicId).toBe("clinic-a");
  });

  it("returns null for an unknown bot", async () => {
    mockLookup(null);
    const resolved = await resolveClinicByBotUsername("unknown_bot");
    expect(resolved).toBeNull();
  });

  it("returns null for a disabled bot (no dispatch to dead tenants)", async () => {
    mockLookup({ ...INTEGRATION_ROW, enabled: false, status: "disabled" });
    const resolved = await resolveClinicByBotUsername("clinic_a_bot");
    expect(resolved).toBeNull();
  });
});

describe("botWebhookSecret", () => {
  it("derives a deterministic per-bot secret from the deployment secret", () => {
    const a = botWebhookSecret("111:TOKEN_A");
    const b = botWebhookSecret("222:TOKEN_B");
    expect(a).not.toBe(b);
    expect(botWebhookSecret("111:TOKEN_A")).toBe(a);
    expect(a.length).toBe(64); // hex sha256
  });
});

describe("timingSafeCheck", () => {
  it("is false when either side is missing", () => {
    expect(timingSafeCheck(null, "x")).toBe(false);
    expect(timingSafeCheck("x", undefined)).toBe(false);
  });
  it("is false on mismatch, true on exact match", () => {
    expect(timingSafeCheck("abc", "abd")).toBe(false);
    expect(timingSafeCheck("abc", "abc")).toBe(true);
  });
});

describe("botWebhookUrl / registerBotWebhook", () => {
  it("builds the per-bot webhook URL", () => {
    expect(botWebhookUrl("clinic_a_bot")).toBe(
      "https://health.example.com/api/telegram/webhook?bot=clinic_a_bot",
    );
  });

  it("registers the webhook with the derived secret token", async () => {
    const setWebhook = vi.fn(async () => ({}));
    const bot = { token: "111:CLINIC_A_TOKEN", api: { setWebhook } };
    const result = await registerBotWebhook(bot as never, "clinic_a_bot");
    expect(result.ok).toBe(true);
    expect(setWebhook).toHaveBeenCalledWith(
      "https://health.example.com/api/telegram/webhook?bot=clinic_a_bot",
      { secret_token: botWebhookSecret("111:CLINIC_A_TOKEN"), drop_pending_updates: false },
    );
  });

  it("returns the error when Telegram rejects the registration", async () => {
    const setWebhook = vi.fn(async () => {
      throw new Error("Bad Request: wrong url");
    });
    const result = await registerBotWebhook(
      { token: "111:X", api: { setWebhook } } as never,
      "clinic_a_bot",
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain("wrong url");
  });
});

describe("botWebhookUrl fallback to the request's own origin", () => {
  // Real production incident: NEXT_PUBLIC_APP_URL was left at the initial
  // http://localhost:3000, so activation stored the bot but could never
  // register its webhook — Telegram only accepts HTTPS. The server plainly
  // knows the HTTPS host it was just reached on, so a stale env var must
  // not be able to lock an operator out of activating their bot.
  const original = envMock.NEXT_PUBLIC_APP_URL;
  afterEach(() => {
    envMock.NEXT_PUBLIC_APP_URL = original;
  });

  it("uses the request origin when NEXT_PUBLIC_APP_URL is still http://localhost", () => {
    envMock.NEXT_PUBLIC_APP_URL = "http://localhost:3000";
    expect(botWebhookUrl("clinic_a_bot", "https://health-ai-w1vc.vercel.app")).toBe(
      "https://health-ai-w1vc.vercel.app/api/telegram/webhook?bot=clinic_a_bot",
    );
  });

  it("uses the request origin when NEXT_PUBLIC_APP_URL is unset", () => {
    envMock.NEXT_PUBLIC_APP_URL = undefined;
    expect(botWebhookUrl("clinic_a_bot", "https://health-ai-w1vc.vercel.app")).toBe(
      "https://health-ai-w1vc.vercel.app/api/telegram/webhook?bot=clinic_a_bot",
    );
  });

  it("still prefers a valid NEXT_PUBLIC_APP_URL over the request origin (custom domains win)", () => {
    expect(botWebhookUrl("clinic_a_bot", "https://some-preview-deploy.vercel.app")).toBe(
      "https://health.example.com/api/telegram/webhook?bot=clinic_a_bot",
    );
  });

  it("returns null when neither source is HTTPS (local dev stays correctly unregisterable)", () => {
    envMock.NEXT_PUBLIC_APP_URL = "http://localhost:3000";
    expect(botWebhookUrl("clinic_a_bot", "http://localhost:3000")).toBeNull();
    expect(botWebhookUrl("clinic_a_bot", null)).toBeNull();
  });
});

describe("botWebhookUrl fallback to Vercel's own platform env vars", () => {
  // Real production incident (2026-09-12): NEXT_PUBLIC_APP_URL was set
  // correctly in the Vercel dashboard, by the operator's own account, and
  // the bot still couldn't register its webhook — because saving the
  // variable in the dashboard is not the same as it being live in the
  // running deployment (wrong target environment, or no new build ran
  // since NEXT_PUBLIC_* values are inlined at build time). Vercel sets
  // these two vars itself, on every deployment, with no dashboard step at
  // all, so they close this failure mode independently of the operator
  // getting a manual step exactly right.
  const original = envMock.NEXT_PUBLIC_APP_URL;
  afterEach(() => {
    envMock.NEXT_PUBLIC_APP_URL = original;
    delete process.env.VERCEL_PROJECT_PRODUCTION_URL;
    delete process.env.VERCEL_URL;
  });

  it("uses VERCEL_PROJECT_PRODUCTION_URL when NEXT_PUBLIC_APP_URL is unset", () => {
    envMock.NEXT_PUBLIC_APP_URL = undefined;
    process.env.VERCEL_PROJECT_PRODUCTION_URL = "health-ai-w1vc.vercel.app";
    expect(botWebhookUrl("clinic_a_bot")).toBe(
      "https://health-ai-w1vc.vercel.app/api/telegram/webhook?bot=clinic_a_bot",
    );
  });

  it("falls back to VERCEL_URL when the production alias isn't set either", () => {
    envMock.NEXT_PUBLIC_APP_URL = undefined;
    process.env.VERCEL_URL = "health-ai-git-preview-abc123.vercel.app";
    expect(botWebhookUrl("clinic_a_bot")).toBe(
      "https://health-ai-git-preview-abc123.vercel.app/api/telegram/webhook?bot=clinic_a_bot",
    );
  });

  it("prefers VERCEL_PROJECT_PRODUCTION_URL over VERCEL_URL when both are set", () => {
    envMock.NEXT_PUBLIC_APP_URL = undefined;
    process.env.VERCEL_PROJECT_PRODUCTION_URL = "health-ai-w1vc.vercel.app";
    process.env.VERCEL_URL = "health-ai-git-preview-abc123.vercel.app";
    expect(botWebhookUrl("clinic_a_bot")).toBe(
      "https://health-ai-w1vc.vercel.app/api/telegram/webhook?bot=clinic_a_bot",
    );
  });

  it("still prefers an explicitly configured NEXT_PUBLIC_APP_URL over both Vercel vars", () => {
    process.env.VERCEL_PROJECT_PRODUCTION_URL = "health-ai-w1vc.vercel.app";
    expect(botWebhookUrl("clinic_a_bot")).toBe(
      "https://health.example.com/api/telegram/webhook?bot=clinic_a_bot",
    );
  });

  it("never resolves a t.me base to a webhook URL, even as a Vercel-style candidate", () => {
    envMock.NEXT_PUBLIC_APP_URL = "https://t.me/health_bot/book";
    expect(botWebhookUrl("clinic_a_bot")).toBeNull();
  });
});

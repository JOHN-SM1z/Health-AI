import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/env", () => ({
  env: { CRON_SECRET: "test-cron-secret-0123456789abcdef" },
  isProduction: false,
}));

vi.mock("@/lib/notifications/processor", () => ({
  processDueNotificationJobs: vi.fn(async () => ({ processed: 0 })),
}));

vi.mock("@/lib/voice/retention", () => ({
  purgeExpiredVoiceMessages: vi.fn(async () => ({ purged: 2, failed: 0 })),
}));

vi.mock("@/lib/sms/processor", () => ({
  processDueSmsJobs: vi.fn(async () => ({ processed: 1, sent: 1, failed: 0, skipped: 0 })),
}));

const quarantineExpiredJobs = vi.hoisted(() => vi.fn(async () => ({ data: 0, error: null })));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ rpc: quarantineExpiredJobs }),
}));

vi.mock("@/lib/logger", () => ({ logger: { error: vi.fn(), warn: vi.fn() } }));

vi.mock("@/lib/rate-limit", () => ({
  rateLimit: vi.fn(() => ({ ok: true, retryAfterSeconds: 0 })),
  keyFromIp: vi.fn(() => "test-ip"),
}));

import { POST } from "./route";
import { processDueNotificationJobs } from "@/lib/notifications/processor";
import { processDueSmsJobs } from "@/lib/sms/processor";
import { purgeExpiredVoiceMessages } from "@/lib/voice/retention";
import { logger } from "@/lib/logger";

const processMock = vi.mocked(processDueNotificationJobs);

function post(auth: string | null): Promise<Response> {
  const headers = new Headers();
  if (auth !== null) headers.set("authorization", auth);
  return POST(
    new NextRequest("http://localhost/api/notifications/process", {
      method: "POST",
      headers,
      body: "{}",
    }),
  );
}

describe("notification cron endpoint (red-team)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("rejects requests without the bearer token", async () => {
    const res = await post(null);
    expect(res.status).toBe(401);
    expect(processMock).not.toHaveBeenCalled();
  });

  it("rejects a wrong bearer token", async () => {
    const res = await post("Bearer wrong-secret");
    expect(res.status).toBe(401);
    expect(processMock).not.toHaveBeenCalled();
  });

  it("accepts the configured CRON_SECRET and processes due jobs", async () => {
    const res = await post("Bearer test-cron-secret-0123456789abcdef");
    expect(res.status).toBe(200);
    expect(processMock).toHaveBeenCalledTimes(1);
    expect(quarantineExpiredJobs).toHaveBeenCalledExactlyOnceWith("quarantine_expired_job_claims");
    expect(await res.json()).toMatchObject({ ok: true, sms: { sent: 1 }, quarantined: 0 });
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("enforces voice-message retention in the same scheduled run", async () => {
    const res = await post("Bearer test-cron-secret-0123456789abcdef");
    expect(await res.json()).toMatchObject({ ok: true, voicePurged: 2, voicePurgeFailed: 0 });
  });

  it("reports safe diagnostics when independent cron jobs throw and still processes Telegram reminders", async () => {
    const providerError = new Error("synthetic-sensitive-provider-response");
    quarantineExpiredJobs.mockRejectedValueOnce(providerError);
    vi.mocked(processDueSmsJobs).mockRejectedValueOnce(providerError);
    vi.mocked(purgeExpiredVoiceMessages).mockRejectedValueOnce(providerError);

    const res = await post("Bearer test-cron-secret-0123456789abcdef");

    expect(res.status).toBe(200);
    expect(processMock).toHaveBeenCalledTimes(1);
    expect(await res.json()).toMatchObject({
      ok: true, sms: { processed: 0, sent: 0, failed: 0, skipped: 0 }, voicePurged: 0, voicePurgeFailed: 0, quarantined: 0,
    });
    expect(vi.mocked(logger.error).mock.calls).toEqual([
      ["job quarantine threw"], ["sms run threw"], ["voice retention run threw"],
    ]);
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/env", () => ({
  env: { CRON_SECRET: "test-cron-secret-0123456789abcdef" },
}));

vi.mock("@/lib/notifications/processor", () => ({
  processDueNotificationJobs: vi.fn(async () => ({ processed: 0 })),
}));

vi.mock("@/lib/rate-limit", () => ({
  rateLimit: vi.fn(() => ({ ok: true, retryAfterSeconds: 0 })),
  keyFromIp: vi.fn(() => "test-ip"),
}));

import { POST } from "./route";
import { processDueNotificationJobs } from "@/lib/notifications/processor";

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
  beforeEach(() => processMock.mockClear());

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
  });
});

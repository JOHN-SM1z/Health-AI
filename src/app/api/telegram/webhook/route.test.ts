import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/env", () => ({
  env: {
    TELEGRAM_WEBHOOK_SECRET: "test-webhook-secret",
    TELEGRAM_BOT_TOKEN: "test-bot-token",
  },
}));

vi.mock("@/lib/telegram/idempotency", () => ({
  claimWebhookProcessing: vi.fn(),
  finishWebhookProcessing: vi.fn(async () => undefined),
  releaseWebhookProcessing: vi.fn(async () => undefined),
}));

vi.mock("@/lib/telegram/handlers", () => ({
  handleTelegramMessage: vi.fn(async () => undefined),
  handleTelegramCommand: vi.fn(async () => undefined),
  handleMenuButton: vi.fn(async () => undefined),
  handleVoiceConsent: vi.fn(async () => undefined),
  handleVoiceCorrect: vi.fn(async () => undefined),
  handleVoiceWrong: vi.fn(async () => undefined),
  requestHumanHandoff: vi.fn(async () => undefined),
}));

vi.mock("@/lib/rate-limit", () => ({
  rateLimit: vi.fn(() => ({ ok: true, retryAfterSeconds: 0 })),
  keyFromIp: vi.fn(() => "test-ip"),
}));

import { POST } from "./route";
import {
  claimWebhookProcessing,
  finishWebhookProcessing,
  releaseWebhookProcessing,
} from "@/lib/telegram/idempotency";
import { handleTelegramMessage } from "@/lib/telegram/handlers";

const claimMock = vi.mocked(claimWebhookProcessing);
const finishMock = vi.mocked(finishWebhookProcessing);
const releaseMock = vi.mocked(releaseWebhookProcessing);
const handleMessageMock = vi.mocked(handleTelegramMessage);

function post(body: unknown, secretToken: string | null = "test-webhook-secret"): Promise<Response> {
  const headers = new Headers({ "content-type": "application/json" });
  if (secretToken !== null) headers.set("x-telegram-bot-api-secret-token", secretToken);
  return POST(new NextRequest("http://localhost/api/telegram/webhook", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  }));
}

const textUpdate = (updateId: number) => ({
  update_id: updateId,
  message: {
    message_id: 1,
    text: "Assalomu alaykum",
    chat: { id: 42 },
    from: { id: 42, first_name: "Ali" },
  },
});

const voiceUpdate = (updateId: number) => ({
  update_id: updateId,
  message: {
    message_id: 2,
    chat: { id: 42 },
    from: { id: 42, first_name: "Ali" },
    voice: { file_id: "voice-1", file_unique_id: "vu-1", duration: 5, mime_type: "audio/ogg" },
  },
});

beforeEach(() => {
  claimMock.mockReset().mockResolvedValue(true);
  finishMock.mockClear();
  releaseMock.mockClear();
  handleMessageMock.mockClear();
});

describe("telegram webhook route", () => {
  it("rejects requests without the secret token", async () => {
    const res = await post(textUpdate(1), null);
    expect(res.status).toBe(401);
    expect(handleMessageMock).not.toHaveBeenCalled();
  });

  it("rejects requests with a wrong secret token", async () => {
    const res = await post(textUpdate(1), "wrong-secret");
    expect(res.status).toBe(401);
  });

  it("forwards a voice update to handleTelegramMessage with the voice payload", async () => {
    const res = await post(voiceUpdate(10));
    expect(res.status).toBe(200);
    expect(handleMessageMock).toHaveBeenCalledTimes(1);
    const call = handleMessageMock.mock.calls[0][0];
    expect(call.voice).toEqual(
      expect.objectContaining({ file_id: "voice-1", file_unique_id: "vu-1", duration: 5, mime_type: "audio/ogg" }),
    );
    expect(call.text).toBe("");
    expect(claimMock).toHaveBeenCalledWith("telegram", "10");
    expect(finishMock).toHaveBeenCalledWith("telegram", "10");
  });

  it("forwards a text update without a voice payload", async () => {
    const res = await post(textUpdate(11));
    expect(res.status).toBe(200);
    const call = handleMessageMock.mock.calls[0][0];
    expect(call.text).toBe("Assalomu alaykum");
    expect(call.voice).toBeUndefined();
  });

  it("drops duplicates without dispatching any work", async () => {
    claimMock.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const first = await post(textUpdate(20));
    expect(first.status).toBe(200);
    expect(handleMessageMock).toHaveBeenCalledTimes(1);

    handleMessageMock.mockClear();
    finishMock.mockClear();
    const duplicate = await post(textUpdate(20));
    expect(duplicate.status).toBe(200);
    const body = (await duplicate.json()) as { ok: boolean; duplicate: boolean };
    expect(body.ok).toBe(true);
    expect(body.duplicate).toBe(true);
    expect(handleMessageMock).not.toHaveBeenCalled();
    expect(finishMock).not.toHaveBeenCalledWith("telegram", "20");
  });

  it("releases the claim and returns 500 when the handler fails (Telegram retries safely)", async () => {
    handleMessageMock.mockRejectedValueOnce(new Error("boom"));
    const res = await post(textUpdate(30));
    expect(res.status).toBe(500);
    expect(releaseMock).toHaveBeenCalledWith("telegram", "30");
    expect(finishMock).not.toHaveBeenCalled();
  });

  it("returns 500 (no dispatch) when the claim itself fails", async () => {
    claimMock.mockRejectedValueOnce(new Error("db down"));
    const res = await post(textUpdate(40));
    expect(res.status).toBe(500);
    expect(handleMessageMock).not.toHaveBeenCalled();
  });
});
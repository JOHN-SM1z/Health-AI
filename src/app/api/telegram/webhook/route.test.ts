import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/env", () => ({
  env: {
    TELEGRAM_WEBHOOK_SECRET: "test-webhook-secret",
    TELEGRAM_BOT_TOKEN: "test-bot-token",
  },
}));

const integrationFixture = {
  clinic_id: "clinic-1",
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

vi.mock("@/lib/telegram/bots", () => ({
  resolveClinicByBotUsername: vi.fn(),
  botWebhookSecret: vi.fn(() => "derived-secret"),
  timingSafeCheck: vi.fn(
    (a: string | null | undefined, b: string | null | undefined) => a != null && b != null && a === b,
  ),
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
import { resolveClinicByBotUsername } from "@/lib/telegram/bots";
import {
  claimWebhookProcessing,
  finishWebhookProcessing,
  releaseWebhookProcessing,
} from "@/lib/telegram/idempotency";
import { handleTelegramMessage, handleMenuButton, handleTelegramCommand } from "@/lib/telegram/handlers";

const resolveMock = vi.mocked(resolveClinicByBotUsername);
const claimMock = vi.mocked(claimWebhookProcessing);
const finishMock = vi.mocked(finishWebhookProcessing);
const releaseMock = vi.mocked(releaseWebhookProcessing);
const handleMessageMock = vi.mocked(handleTelegramMessage);
const menuButtonMock = vi.mocked(handleMenuButton);
const handleCommandMock = vi.mocked(handleTelegramCommand);

const BOT = "clinic_a_bot";
const CLAIM_SOURCE = `${BOT}:clinic-1`;

function post(body: unknown, secretToken: string | null = "derived-secret"): Promise<Response> {
  const headers = new Headers({ "content-type": "application/json" });
  if (secretToken !== null) headers.set("x-telegram-bot-api-secret-token", secretToken);
  return POST(
    new NextRequest(`http://localhost/api/telegram/webhook?bot=${BOT}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    }),
  );
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
  resolveMock.mockReset().mockResolvedValue({ clinicId: "clinic-1", integration: integrationFixture });
  claimMock.mockReset().mockResolvedValue(true);
  finishMock.mockClear();
  releaseMock.mockClear();
  handleMessageMock.mockClear();
});

describe("telegram webhook route (per-clinic bots)", () => {
  it("rejects updates for an unknown bot (no routing target)", async () => {
    resolveMock.mockResolvedValueOnce(null);
    const res = await post(textUpdate(1), "whatever");
    expect(res.status).toBe(401);
    expect(handleMessageMock).not.toHaveBeenCalled();
    expect(claimMock).not.toHaveBeenCalled();
  });

  it("rejects requests without the secret token", async () => {
    const res = await post(textUpdate(1), null);
    expect(res.status).toBe(401);
    expect(handleMessageMock).not.toHaveBeenCalled();
  });

  it("rejects requests with a wrong secret token", async () => {
    const res = await post(textUpdate(1), "wrong-secret");
    expect(res.status).toBe(401);
  });

  it("routes a voice update to the clinic's handler with the voice payload", async () => {
    const res = await post(voiceUpdate(10));
    expect(res.status).toBe(200);
    expect(handleMessageMock).toHaveBeenCalledTimes(1);
    const call = handleMessageMock.mock.calls[0][0];
    expect(call.clinicId).toBe("clinic-1");
    expect(call.voice).toEqual(
      expect.objectContaining({ file_id: "voice-1", file_unique_id: "vu-1", duration: 5, mime_type: "audio/ogg" }),
    );
    expect(call.text).toBe("");
    expect(claimMock).toHaveBeenCalledWith(CLAIM_SOURCE, "10");
    expect(finishMock).toHaveBeenCalledWith(CLAIM_SOURCE, "10");
  });

  it("forwards a text update without a voice payload to the right clinic", async () => {
    const res = await post(textUpdate(11));
    expect(res.status).toBe(200);
    const call = handleMessageMock.mock.calls[0][0];
    expect(call.clinicId).toBe("clinic-1");
    expect(call.text).toBe("Assalomu alaykum");
    expect(call.voice).toBeUndefined();
  });

  it("routes emoji-prefixed reply-keyboard taps to handleMenuButton, not the AI", async () => {
    const buttons = [
      "📅 Qabulga yozilish",
      "🤖 Shifokor tanlashda yordam",
      "💰 Narxlar",
      "📍 Manzil",
      "👤 Operator bilan bog‘lanish",
      "🚪 Suhbatni yakunlash",
    ];
    for (let i = 0; i < buttons.length; i++) {
      menuButtonMock.mockClear();
      handleMessageMock.mockClear();
      const res = await post({
        ...textUpdate(100 + i),
        message: { ...textUpdate(100 + i).message, text: buttons[i] },
      });
      expect(res.status).toBe(200);
      expect(menuButtonMock).toHaveBeenCalledTimes(1);
      expect(menuButtonMock).toHaveBeenCalledWith(
        expect.objectContaining({ button: buttons[i], clinicId: "clinic-1" }),
      );
      expect(handleMessageMock).not.toHaveBeenCalled();
    }
  });

  it("forwards commands to handleTelegramCommand with the real command name", async () => {
    handleCommandMock.mockClear();
    const res = await post({
      ...textUpdate(50),
      message: { ...textUpdate(50).message, text: "/chiqish" },
    });
    expect(res.status).toBe(200);
    expect(handleCommandMock).toHaveBeenCalledTimes(1);
    expect(handleCommandMock).toHaveBeenCalledWith(
      expect.objectContaining({ command: "/chiqish", clinicId: "clinic-1" }),
    );
    expect(handleMessageMock).not.toHaveBeenCalled();
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
    expect(finishMock).not.toHaveBeenCalledWith(CLAIM_SOURCE, "20");
  });

  it("releases the claim and returns 500 when the handler fails (Telegram retries safely)", async () => {
    handleMessageMock.mockRejectedValueOnce(new Error("boom"));
    const res = await post(textUpdate(30));
    expect(res.status).toBe(500);
    expect(releaseMock).toHaveBeenCalledWith(CLAIM_SOURCE, "30");
    expect(finishMock).not.toHaveBeenCalled();
  });

  it("returns 500 (no dispatch) when the claim itself fails", async () => {
    claimMock.mockRejectedValueOnce(new Error("db down"));
    const res = await post(textUpdate(40));
    expect(res.status).toBe(500);
    expect(handleMessageMock).not.toHaveBeenCalled();
  });

  it("rejects an oversized payload before any dispatch (413)", async () => {
    const big = JSON.stringify({ update_id: 50, message: { text: "x".repeat(150_000) } });
    const res = await POST(
      new NextRequest(`http://localhost/api/telegram/webhook?bot=${BOT}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": "derived-secret" },
        body: big,
      }),
    );
    expect(res.status).toBe(413);
    expect(claimMock).not.toHaveBeenCalled();
    expect(handleMessageMock).not.toHaveBeenCalled();
  });

  it("routes voice callbacks with the webhook's resolved clinicId (tenant-bound)", async () => {
    claimMock.mockResolvedValueOnce(true);
    const { handleVoiceConsent, handleVoiceCorrect, handleVoiceWrong } = await import("@/lib/telegram/handlers");
    const consentMock = vi.mocked(handleVoiceConsent);
    const correctMock = vi.mocked(handleVoiceCorrect);
    const wrongMock = vi.mocked(handleVoiceWrong);

    await post({ update_id: 60, callback_query: { id: "c1", from: { id: 42 }, data: "voice_consent_yes:vm-1", message: { chat: { id: 42 } } } });
    expect(consentMock).toHaveBeenCalledWith(expect.objectContaining({ clinicId: "clinic-1", voiceMessageId: "vm-1" }));

    await post({ update_id: 61, callback_query: { id: "c2", from: { id: 42 }, data: "voice_correct:vm-2", message: { chat: { id: 42 } } } });
    expect(correctMock).toHaveBeenCalledWith(expect.objectContaining({ clinicId: "clinic-1", voiceMessageId: "vm-2" }));

    await post({ update_id: 62, callback_query: { id: "c3", from: { id: 42 }, data: "voice_wrong:vm-3", message: { chat: { id: 42 } } } });
    expect(wrongMock).toHaveBeenCalledWith(expect.objectContaining({ clinicId: "clinic-1", voiceMessageId: "vm-3" }));
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  from: vi.fn(),
  upload: vi.fn(),
  hold: vi.fn(),
  send: vi.fn(),
  getFile: vi.fn(),
  transcribe: vi.fn(),
  getProvider: vi.fn(),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ from: mocks.from, storage: { from: () => ({ upload: mocks.upload }) } }),
}));
vi.mock("@/lib/telegram/store", () => ({
  conversationIsHeld: mocks.hold,
  appendMessage: vi.fn(),
  getOrCreateConversation: vi.fn(),
  updateConversationState: vi.fn(),
}));
vi.mock("@/lib/telegram/bot", () => ({
  sendTelegramMessage: mocks.send,
  getTelegramFileUrl: mocks.getFile,
}));
vi.mock("@/lib/transcription/provider", () => ({ getHealthTranscriptionProvider: mocks.getProvider }));

import { handleVoiceConsent } from "@/lib/telegram/handlers";

const input = { clinicId: "clinic-1", chatId: 777000, telegramUserId: 777000, voiceMessageId: "vm-1", consent: true };
const availableVoice = {
  id: input.voiceMessageId,
  clinic_id: input.clinicId,
  conversation_id: "conv-1",
  telegram_file_id: "synthetic-file",
  mime_type: "audio/ogg",
  retention_days: 7,
  transcription_status: "none",
  purged_at: null,
  expires_at: null,
  conversations: { patients: { telegram_user_id: input.telegramUserId } },
};
const saved = { data: { id: input.voiceMessageId }, error: null };
const update = vi.fn();
const fetchAudio = vi.fn();

beforeEach(() => {
  vi.resetAllMocks();
  mocks.hold.mockResolvedValue(false);
  mocks.getFile.mockResolvedValue("https://example.invalid/synthetic-file");
  mocks.getProvider.mockReturnValue({ name: "local-test", transcribe: mocks.transcribe });
  mocks.transcribe.mockResolvedValue({ text: "Synthetic transcript", provider: "local-test" });
  mocks.upload.mockResolvedValue({ error: null });
  fetchAudio.mockResolvedValue(new Response("synthetic audio"));
  vi.stubGlobal("fetch", fetchAudio);

  update.mockReturnValue(saved);
  mocks.from.mockImplementation((table) => {
    if (table !== "voice_messages") throw new Error("Unexpected table");
    const read = { eq: vi.fn().mockReturnThis(), maybeSingle: vi.fn(async () => ({ data: availableVoice, error: null })) };
    return {
      select: () => read,
      update: (fields: Record<string, unknown>) => {
        const result = update(fields);
        return {
          eq: vi.fn().mockReturnThis(),
          is: vi.fn().mockReturnThis(),
          or: vi.fn().mockReturnThis(),
          gt: vi.fn().mockReturnThis(),
          select: vi.fn().mockReturnThis(),
          maybeSingle: vi.fn(async () => result),
          then: (resolve: (value: unknown) => void) => resolve(result),
        };
      },
    };
  });
});

afterEach(() => vi.unstubAllGlobals());

describe("Telegram voice consent and storage", () => {
  it("does not download, transcribe or upload when consent is refused", async () => {
    await handleVoiceConsent({ ...input, consent: false });
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ consent_given: false }));
    expect(mocks.getFile).not.toHaveBeenCalled();
    expect(mocks.transcribe).not.toHaveBeenCalled();
    expect(mocks.upload).not.toHaveBeenCalled();
  });

  it("leaves the audio unread when the approved provider is unavailable", async () => {
    mocks.getProvider.mockReturnValue(null);
    await handleVoiceConsent(input);
    expect(update).not.toHaveBeenCalled();
    expect(mocks.getFile).not.toHaveBeenCalled();
    expect(mocks.upload).not.toHaveBeenCalled();
  });

  it.each([
    { data: null, error: { code: "57014" } },
    { data: null, error: null },
  ])("never reads the recording if no consent claim was acquired", async (claim) => {
    update.mockReturnValueOnce(claim);
    await handleVoiceConsent(input);
    expect(mocks.getFile).not.toHaveBeenCalled();
    expect(mocks.transcribe).not.toHaveBeenCalled();
    expect(mocks.upload).not.toHaveBeenCalled();
  });

  it("does not send audio to speech processing if an operator takes over during download", async () => {
    fetchAudio.mockImplementationOnce(async () => {
      mocks.hold.mockResolvedValue(true);
      return new Response("synthetic audio");
    });
    await handleVoiceConsent(input);
    expect(fetchAudio).toHaveBeenCalledTimes(1);
    expect(mocks.transcribe).not.toHaveBeenCalled();
    expect(mocks.upload).not.toHaveBeenCalled();
    expect(mocks.send).toHaveBeenCalledTimes(1);
  });

  it("avoids private storage writes when speech processing fails", async () => {
    mocks.transcribe.mockRejectedValueOnce(new Error("synthetic provider failure"));
    await handleVoiceConsent(input);
    expect(mocks.upload).not.toHaveBeenCalled();
    expect(update).toHaveBeenLastCalledWith(expect.objectContaining({ transcription_status: "failed", transcription_error: "processing_failed" }));
    expect(mocks.send).not.toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining("Siz aytdingiz") }), input.clinicId);
  });

  it("tracks an uploaded object for purge when saving the transcript fails", async () => {
    update.mockReturnValueOnce(saved).mockReturnValueOnce({ data: null, error: { code: "57014" } });
    await handleVoiceConsent(input);
    expect(update).toHaveBeenNthCalledWith(1, expect.objectContaining({
      consent_given: true,
      transcription_status: "pending",
      storage_path: "clinic-1/vm-1.ogg",
      expires_at: expect.any(String),
    }));
    expect(update.mock.invocationCallOrder[0]).toBeLessThan(mocks.getFile.mock.invocationCallOrder[0]);
    expect(mocks.upload).toHaveBeenCalledWith("clinic-1/vm-1.ogg", expect.any(Buffer), expect.objectContaining({ contentType: "audio/ogg" }));
    const failed = update.mock.calls.at(-1)?.[0];
    expect(failed).toMatchObject({ transcription_status: "failed", expires_at: expect.any(String) });
    expect(failed).not.toHaveProperty("storage_path");
    expect(Date.parse(failed.expires_at)).toBeLessThanOrEqual(Date.now());
    expect(mocks.send).not.toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining("Synthetic transcript") }), input.clinicId);
  });

  it("offers transcript confirmation only after its final save", async () => {
    await handleVoiceConsent(input);
    expect(update).toHaveBeenLastCalledWith(expect.objectContaining({ transcription: "Synthetic transcript", transcription_status: "transcribed" }));
    expect(mocks.send).toHaveBeenLastCalledWith(expect.objectContaining({ text: expect.stringContaining("Synthetic transcript") }), input.clinicId);
    expect(update.mock.invocationCallOrder.at(-1)).toBeLessThan(mocks.send.mock.invocationCallOrder.at(-1)!);
  });
});

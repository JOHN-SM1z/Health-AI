import { describe, it, expect, vi, beforeEach } from "vitest";

const supabaseMock = {
  from: vi.fn(),
};

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => supabaseMock,
}));

vi.mock("@/lib/telegram/store", () => ({
  getOrCreateConversation: vi.fn(),
  appendMessage: vi.fn(async () => {}),
  conversationIsHeld: vi.fn(async () => false),
  updateConversationState: vi.fn(),
}));

vi.mock("@/lib/clinics/context", () => ({
  getDefaultClinic: vi.fn(async () => ({ id: "clinic-1", timezone: "Asia/Tashkent" })),
}));

vi.mock("@/lib/ai/receptionist", () => ({
  generateReceptionistReply: vi.fn(async () => ({
    text: "Sizga terapevt yordam berishi mumkin.",
    usedAi: true,
    urgent: false,
    handoff: false,
  })),
}));

vi.mock("@/lib/telegram/bot", () => ({
  sendTelegramMessage: vi.fn(async () => 1),
}));

import { handleVoiceCorrect, mainKeyboard } from "@/lib/telegram/handlers";
import { conversationIsHeld } from "@/lib/telegram/store";
import { generateReceptionistReply } from "@/lib/ai/receptionist";
import { sendTelegramMessage } from "@/lib/telegram/bot";

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(conversationIsHeld).mockResolvedValue(false);

  supabaseMock.from.mockImplementation((table: string) => {
    if (table === "voice_messages") {
      return {
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            maybeSingle: vi.fn(async () => ({
              data: {
                id: "vm-1",
                clinic_id: "clinic-1",
                conversation_id: "conv-1",
                transcription: "Boshim og'riyapti",
                transcription_status: "transcribed",
              },
              error: null,
            })),
          })),
        })),
      };
    }
    if (table === "conversations") {
      return {
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            maybeSingle: vi.fn(async () => ({ data: { patient_id: "p-1" }, error: null })),
          })),
        })),
      };
    }
    return {};
  });
});

describe("mainKeyboard", () => {
  it("never contains web_app buttons so Telegram can never reject the menu", () => {
    const buttons = mainKeyboard.keyboard.flat();
    expect(buttons.length).toBeGreaterThan(0);
    for (const b of buttons) {
      expect(b).not.toHaveProperty("web_app");
    }
  });
});

describe("handleVoiceCorrect", () => {
  it("does not auto-reply when an admin holds the conversation", async () => {
    vi.mocked(conversationIsHeld).mockResolvedValue(true);

    await handleVoiceCorrect({ chatId: 777000, voiceMessageId: "vm-1" });

    // AI automation must stay silent while the conversation is assigned to a
    // human admin — no generation, no send.
    expect(generateReceptionistReply).not.toHaveBeenCalled();
    expect(sendTelegramMessage).not.toHaveBeenCalled();
  });

  it("routes the transcription through the AI when the conversation is free", async () => {
    await handleVoiceCorrect({ chatId: 777000, voiceMessageId: "vm-1" });

    expect(generateReceptionistReply).toHaveBeenCalledWith(
      expect.objectContaining({ userText: "Boshim og'riyapti" }),
    );
    expect(sendTelegramMessage).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: 777000 }),
    );
  });
});

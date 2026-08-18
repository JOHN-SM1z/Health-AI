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
  getClinicById: vi.fn(async () => ({
    id: "clinic-1",
    name: "Test Klinika",
    timezone: "Asia/Tashkent",
    currency: "UZS",
    address: "Toshkent sh.",
    phone: "+998901234567",
  })),
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

import { handleVoiceCorrect, buildMainKeyboard, buildHeldKeyboard, exitOperatorChat } from "@/lib/telegram/handlers";
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

describe("buildMainKeyboard", () => {
  it("keeps a plain text booking button when no app URL is configured", () => {
    delete process.env.NEXT_PUBLIC_APP_URL;
    const buttons = buildMainKeyboard("clinic-1").keyboard.flat();
    expect(buttons.length).toBeGreaterThan(0);
    for (const b of buttons) {
      expect(b).not.toHaveProperty("web_app");
    }
  });

  it("attaches a web_app booking button with the clinic tenant when an HTTPS app URL is configured", () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://health.example.com";
    const buttons = buildMainKeyboard("clinic-1").keyboard.flat();
    expect(buttons[0]).toEqual({
      text: "📅 Qabulga yozilish",
      web_app: { url: "https://health.example.com/book?clinic=clinic-1" },
    });
    // Other buttons stay plain text.
    for (const b of buttons.slice(1)) {
      expect(b).not.toHaveProperty("web_app");
    }
  });

  it("never attaches web_app for a t.me deep-link base", () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://t.me/health_bot/book";
    const buttons = buildMainKeyboard("clinic-1").keyboard.flat();
    expect(buttons[0]).not.toHaveProperty("web_app");
  });
});

describe("buildHeldKeyboard", () => {
  it("offers only the exit-operator-chat button", () => {
    const buttons = buildHeldKeyboard().keyboard.flat();
    expect(buttons).toEqual([{ text: "🚪 Suhbatni yakunlash" }]);
  });
});

describe("exitOperatorChat", () => {
  it("releases a held conversation back to the bot and shows the main menu", async () => {
    let updateValues: Record<string, unknown> | undefined;
    supabaseMock.from.mockImplementation((table: string) => {
      if (table === "conversations") {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              maybeSingle: vi.fn(async () => ({ data: { status: "assigned", ai_enabled: false }, error: null })),
            })),
          })),
          update: (values: Record<string, unknown>) => {
            updateValues = values;
            return { eq: vi.fn(async () => ({ error: null })) };
          },
        };
      }
      return {};
    });

    await exitOperatorChat({
      clinicId: "clinic-1",
      patientId: "p-1",
      conversationId: "conv-1",
      chatId: 777000,
      patientLabel: "@ali",
    });

    expect(updateValues).toEqual({
      status: "open",
      ai_enabled: true,
      taken_over_by: null,
      taken_over_at: null,
      released_at: expect.any(String),
    });
    expect(sendTelegramMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: 777000,
        text: expect.stringContaining("Suhbat yakunlandi"),
        replyMarkup: buildMainKeyboard("clinic-1"),
      }),
      "clinic-1",
    );
  });

  it("just shows the main menu when the conversation is not held", async () => {
    supabaseMock.from.mockImplementation((table: string) => {
      if (table === "conversations") {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              maybeSingle: vi.fn(async () => ({ data: { status: "open", ai_enabled: true }, error: null })),
            })),
          })),
        };
      }
      return {};
    });

    await exitOperatorChat({
      clinicId: "clinic-1",
      patientId: "p-1",
      conversationId: "conv-1",
      chatId: 777000,
      patientLabel: "@ali",
    });

    expect(sendTelegramMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: 777000,
        replyMarkup: buildMainKeyboard("clinic-1"),
      }),
      "clinic-1",
    );
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
      "clinic-1",
    );
  });
});

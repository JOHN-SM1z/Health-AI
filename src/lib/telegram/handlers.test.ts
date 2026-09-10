import { describe, it, expect, vi, beforeEach } from "vitest";

const supabaseMock = {
  from: vi.fn(),
};

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => supabaseMock,
}));

vi.mock("@/lib/telegram/store", () => ({
  getOrCreateConversation: vi.fn(async () => ({ id: "conv-1" })),
  appendMessage: vi.fn(async () => {}),
  conversationIsHeld: vi.fn(async () => false),
  updateConversationState: vi.fn(),
}));

vi.mock("@/lib/patients/identity", () => ({
  getOrCreatePatient: vi.fn(async () => ({ id: "p-1" })),
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

import { handleVoiceCorrect, handleVoiceConsent, handleTelegramMessage, buildMainKeyboard, buildHeldKeyboard, exitOperatorChat, handleMenuButton } from "@/lib/telegram/handlers";
import { conversationIsHeld, appendMessage } from "@/lib/telegram/store";
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

describe("handleMenuButton booking reply (source attribution)", () => {
  it("marks the chat deep-link with startapp=booking (telegram_chat attribution)", async () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://health.example.com";
    await handleMenuButton({
      clinicId: "clinic-1",
      chatId: 111,
      from: { id: 222, first_name: "Ali" },
      button: "📅 Qabulga yozilish",
    });
    const payload = vi.mocked(sendTelegramMessage).mock.calls[0][0] as { replyMarkup?: { inline_keyboard: Array<Array<{ url?: string; web_app?: { url: string } }>> } };
    const button = payload.replyMarkup?.inline_keyboard?.[0]?.[0];
    expect(button?.web_app?.url ?? button?.url).toContain("startapp=booking");
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

    await handleVoiceCorrect({ clinicId: "clinic-1", chatId: 777000, voiceMessageId: "vm-1" });

    // AI automation must stay silent while the conversation is assigned to a
    // human admin — no generation, no send.
    expect(generateReceptionistReply).not.toHaveBeenCalled();
    expect(sendTelegramMessage).not.toHaveBeenCalled();
  });

  it("routes the transcription through the AI when the conversation is free", async () => {
    await handleVoiceCorrect({ clinicId: "clinic-1", chatId: 777000, voiceMessageId: "vm-1" });

    expect(generateReceptionistReply).toHaveBeenCalledWith(
      expect.objectContaining({ userText: "Boshim og'riyapti" }),
    );
    expect(sendTelegramMessage).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: 777000 }),
      "clinic-1",
    );
  });
});

describe("handleVoiceConsent", () => {
  it("sends the not-found reply through the patient's own clinic bot", async () => {
    // Regression test: this reply used to omit clinicId, which falls back
    // to the legacy global admin bot instead of the clinic's own bot —
    // that bot has no chat with this patient and the send would fail (or
    // silently no-op when the legacy bot is unconfigured).
    supabaseMock.from.mockImplementation((table: string) => {
      if (table === "voice_messages") {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              eq: vi.fn(() => ({
                maybeSingle: vi.fn(async () => ({ data: null, error: null })),
              })),
            })),
          })),
        };
      }
      return {};
    });

    await handleVoiceConsent({ clinicId: "clinic-1", chatId: 777000, voiceMessageId: "missing-vm", consent: true });

    expect(sendTelegramMessage).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: 777000, text: expect.stringContaining("topilmadi") }),
      "clinic-1",
    );
  });
});

describe("handleTelegramMessage — takeover race (section 6: AI starts while operator takes over)", () => {
  it("suppresses the AI reply when the conversation becomes held while generateReceptionistReply is in flight", async () => {
    // Not held when the message first arrives (AI is allowed to start
    // generating a reply)...
    // ...but held by the time generation finishes — an operator took over
    // in between. This is the exact re-check handleTelegramMessage performs
    // immediately before sending; it must win the race every time, since
    // sending here would be an automated reply over a live human takeover.
    vi.mocked(conversationIsHeld).mockResolvedValueOnce(false).mockResolvedValueOnce(true);

    await handleTelegramMessage({
      clinicId: "clinic-1",
      chatId: 777000,
      from: { id: 42, first_name: "Ali" },
      text: "Salom, qabulga yozilmoqchiman",
      updateId: 1,
    });

    expect(generateReceptionistReply).toHaveBeenCalledTimes(1);
    expect(sendTelegramMessage).not.toHaveBeenCalled();
    // Only the patient's own inbound message was recorded — no ai/bot reply.
    expect(vi.mocked(appendMessage)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(appendMessage)).toHaveBeenCalledWith(expect.objectContaining({ role: "patient" }));
  });

  it("sends normally when the conversation is never held", async () => {
    await handleTelegramMessage({
      clinicId: "clinic-1",
      chatId: 777000,
      from: { id: 42, first_name: "Ali" },
      text: "Salom, qabulga yozilmoqchiman",
      updateId: 2,
    });

    expect(sendTelegramMessage).toHaveBeenCalledTimes(1);
    expect(vi.mocked(appendMessage)).toHaveBeenCalledTimes(2); // patient message + ai reply
  });
});

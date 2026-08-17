import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

const sendMessageMock = vi.fn();

vi.mock("grammy", () => ({
  Bot: class {
    api = { sendMessage: sendMessageMock };
    constructor() {}
  },
}));

// Configure the bot BEFORE importing — env.ts parses process.env at module load.
process.env.TELEGRAM_BOT_TOKEN = "test-bot-token";
process.env.ENABLE_TELEGRAM_DEV_MODE = "false";

const { sendTelegramMessage } = await import("@/lib/telegram/bot");

beforeEach(() => {
  sendMessageMock.mockReset();
});

describe("sendTelegramMessage", () => {
  it("retries without web_app buttons when Telegram rejects them", async () => {
    sendMessageMock
      .mockRejectedValueOnce(new Error("Bad Request: BUTTON_URL_INVALID: domain not whitelisted"))
      .mockResolvedValueOnce({ message_id: 42 });

    const result = await sendTelegramMessage({
      chatId: 777000,
      text: "Salom",
      replyMarkup: {
        keyboard: [
          [{ text: "📅 Qabulga yozilish", web_app: { url: "https://example.com/book" } }],
          [{ text: "Narxlar" }],
        ],
        resize_keyboard: true,
      },
    });

    expect(result).toBe(42);
    expect(sendMessageMock).toHaveBeenCalledTimes(2);
    const markup = sendMessageMock.mock.calls[1][2].reply_markup;
    // web_app button downgraded to a plain text button, row retained.
    expect(markup.keyboard[0][0]).toEqual({ text: "📅 Qabulga yozilish" });
    expect(markup.keyboard).toHaveLength(2);
  });

  it("drops web_app buttons from inline keyboards", async () => {
    sendMessageMock
      .mockRejectedValueOnce(new Error("Bad Request: BUTTON_URL_INVALID"))
      .mockResolvedValueOnce({ message_id: 7 });

    const result = await sendTelegramMessage({
      chatId: 777000,
      text: "Eslatma",
      replyMarkup: {
        inline_keyboard: [
          [{ text: "📅 Qabulga yozilish", web_app: { url: "https://example.com/book" } }],
          [{ text: "👤 Operator", callback_data: "contact_operator" }],
        ],
      },
    });

    expect(result).toBe(7);
    const markup = sendMessageMock.mock.calls[1][2].reply_markup;
    expect(markup.inline_keyboard).toHaveLength(1);
    expect(markup.inline_keyboard[0][0]).toEqual({
      text: "👤 Operator",
      callback_data: "contact_operator",
    });
  });

  it("does not retry on unrelated errors", async () => {
    sendMessageMock.mockRejectedValueOnce(new Error("chat not found"));

    const result = await sendTelegramMessage({ chatId: 1, text: "hi" });

    expect(result).toBeNull();
    expect(sendMessageMock).toHaveBeenCalledTimes(1);
  });
});

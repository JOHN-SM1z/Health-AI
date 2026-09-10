import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * generateReceptionistReply's safety chain (Phase 3 Telegram audit,
 * section 11: "AI enabled" / "AI disabled"). Proves the AI dependency can
 * never hide or break the underlying reply pipeline: with AI off, AI
 * throwing, or AI producing an unsafe output, a patient always gets SOME
 * answer — never a hang, a crash, or a disallowed medical claim.
 */

const knowledgeFixture = {
  clinicName: "Test Klinika",
  address: null,
  phone: null,
  email: null,
  openingHours: {},
  currency: "UZS",
  faqs: [{ question: "Ish vaqtingiz qachon?", answer: "9:00-18:00" }],
  specialties: [],
  services: [],
  doctors: [],
};

const getAiProviderMock = vi.fn();
vi.mock("@/lib/ai/provider", () => ({
  getAiProvider: () => getAiProviderMock(),
}));

const loadClinicKnowledgeMock = vi.fn(async () => knowledgeFixture);
vi.mock("@/lib/ai/knowledge", () => ({
  loadClinicKnowledge: () => loadClinicKnowledgeMock(),
  buildReceptionistSystemPrompt: () => "SYSTEM PROMPT",
}));

import { generateReceptionistReply } from "@/lib/ai/receptionist";

beforeEach(() => {
  vi.clearAllMocks();
  loadClinicKnowledgeMock.mockResolvedValue(knowledgeFixture);
});

describe("generateReceptionistReply — AI disabled (ENABLE_AI=false / no provider)", () => {
  it("answers from the clinic's own FAQs without ever calling an AI provider", async () => {
    getAiProviderMock.mockReturnValue(null);
    const reply = await generateReceptionistReply({ clinicId: "clinic-1", userText: "Ish vaqtingiz qachon?" });
    expect(reply.usedAi).toBe(false);
    expect(reply.text).toContain("9:00-18:00");
    expect(reply.handoff).toBe(false);
  });

  it("hands off to a human instead of fabricating an answer when no FAQs are configured", async () => {
    getAiProviderMock.mockReturnValue(null);
    loadClinicKnowledgeMock.mockResolvedValueOnce({ ...knowledgeFixture, faqs: [] });
    const reply = await generateReceptionistReply({ clinicId: "clinic-1", userText: "Nima maslahat berasiz?" });
    expect(reply.usedAi).toBe(false);
    expect(reply.handoff).toBe(true);
  });
});

describe("generateReceptionistReply — AI enabled", () => {
  it("uses the provider's grounded reply, built from the clinic's own knowledge", async () => {
    const generateReplyMock = vi.fn(async () => "Bizning klinikamiz 9:00-18:00 ishlaydi.");
    getAiProviderMock.mockReturnValue({ generateReply: generateReplyMock });

    const reply = await generateReceptionistReply({ clinicId: "clinic-1", userText: "Ish vaqtingiz qachon?" });

    expect(reply.usedAi).toBe(true);
    expect(reply.text).toBe("Bizning klinikamiz 9:00-18:00 ishlaydi.");
    expect(generateReplyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        system: "SYSTEM PROMPT",
        messages: [{ role: "user", content: "Ish vaqtingiz qachon?" }],
      }),
    );
  });

  it("falls back to FAQs instead of surfacing an error when the provider throws (timeout, 5xx, network)", async () => {
    getAiProviderMock.mockReturnValue({
      generateReply: vi.fn(async () => {
        throw new Error("upstream timeout");
      }),
    });

    const reply = await generateReceptionistReply({ clinicId: "clinic-1", userText: "Ish vaqtingiz qachon?" });

    expect(reply.usedAi).toBe(false);
    expect(reply.text).toContain("9:00-18:00");
  });

  it("discards an AI reply that fails the safety check (e.g. a diagnosis) and hands off instead of sending it", async () => {
    getAiProviderMock.mockReturnValue({
      generateReply: vi.fn(async () => "Sizning diagnozingiz — shamollash."),
    });

    const reply = await generateReceptionistReply({ clinicId: "clinic-1", userText: "Nima kasalman?" });

    expect(reply.usedAi).toBe(true);
    expect(reply.handoff).toBe(true);
    expect(reply.text).not.toContain("diagnoz");
  });
});

describe("generateReceptionistReply — urgency short-circuit (never depends on AI)", () => {
  it("routes urgent wording to the emergency message before AI is ever consulted, whether AI is enabled or not", async () => {
    const generateReplyMock = vi.fn(async () => "should never be called");
    getAiProviderMock.mockReturnValue({ generateReply: generateReplyMock });

    const reply = await generateReceptionistReply({ clinicId: "clinic-1", userText: "Menda qattiq og'riq bor" });

    expect(reply.urgent).toBe(true);
    expect(reply.usedAi).toBe(false);
    expect(reply.handoff).toBe(true);
    expect(generateReplyMock).not.toHaveBeenCalled();
    expect(loadClinicKnowledgeMock).not.toHaveBeenCalled();
  });
});

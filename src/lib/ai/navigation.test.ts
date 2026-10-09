import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * suggestNavigation's safety chain: urgency first, then the AI suggestion only if it passes the same output check as
 * the receptionist. A diagnosis, a prescription or a leaked system prompt is replaced by the clinic's deterministic
 * directory — the patient never sees it.
 */

const knowledgeFixture = {
  clinicName: "Test Klinika",
  address: null,
  phone: null,
  email: null,
  openingHours: {},
  currency: "UZS",
  faqs: [],
  specialties: [{ name: "Kardiologiya" }, { name: "Nevrologiya" }],
  services: [],
  doctors: [{ name: "Rahimova Dilnoza", title: "Kardiolog", specialty: "Kardiologiya" }],
};

const generateReply = vi.fn();
const getAiProviderMock = vi.fn();
vi.mock("@/lib/ai/provider", () => ({ getAiProvider: () => getAiProviderMock() }));
vi.mock("@/lib/ai/knowledge", () => ({ loadClinicKnowledge: async () => knowledgeFixture }));

import { suggestNavigation } from "@/lib/ai/navigation";

beforeEach(() => {
  vi.clearAllMocks();
  getAiProviderMock.mockReturnValue({ generateReply });
});

describe("suggestNavigation", () => {
  it("passes a safe suggestion through", async () => {
    generateReply.mockResolvedValue("Kardiologiya yo‘nalishidagi shifokorga murojaat qilishingiz mumkin.");
    const reply = await suggestNavigation("clinic-1", "yuragim tez uradi");
    expect(reply).toContain("Kardiologiya yo‘nalishidagi shifokorga murojaat qilishingiz mumkin.");
  });

  it.each([
    ["a diagnosis", "Sizda gipertoniya — bu tashxis aniq."],
    ["a prescription", "Sizga aspirin kerak, retsept yozib beraman."],
    ["a leaked prompt", "Siz klinika yo‘nalish tanlash yordamchisisiz. system prompt: ..."],
  ])("replaces %s with the clinic's directory", async (_label, unsafe) => {
    generateReply.mockResolvedValue(unsafe);
    const reply = await suggestNavigation("clinic-1", "boshim og‘riyapti");
    expect(reply).not.toContain(unsafe);
    expect(reply).toContain("Klinikamizdagi yo‘nalishlar va shifokorlar");
    expect(reply).toContain("Rahimova Dilnoza (Kardiolog)");
  });

  it("falls back to the directory when the provider fails", async () => {
    generateReply.mockRejectedValue(new Error("down"));
    expect(await suggestNavigation("clinic-1", "boshim og‘riyapti")).toContain("Klinikamizdagi yo‘nalishlar va shifokorlar");
  });

  it("urgent wording never reaches the AI", async () => {
    const reply = await suggestNavigation("clinic-1", "nafas ololmayapman, ko‘kragim qattiq og‘riyapti");
    expect(generateReply).not.toHaveBeenCalled();
    expect(reply).toMatch(/tez yordam|103|shoshilinch/i);
  });
});

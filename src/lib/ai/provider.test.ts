import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/env", () => ({
  env: {
    AI_BASE_URL: "https://ai.example.test",
    AI_API_KEY: "synthetic-test-only",
    AI_MODEL: "test-model",
  },
}));
vi.mock("@/lib/logger", () => ({ logger: { error: vi.fn() } }));

import { logger } from "@/lib/logger";
import { OpenAICompatibleProvider } from "@/lib/ai/provider";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

const input = { system: "Synthetic system prompt", messages: [] };

describe("OpenAICompatibleProvider failure privacy", () => {
  it("logs the HTTP status without reading a sensitive error body", async () => {
    const bodySentinel = "SYNTHETIC_SENSITIVE_RESPONSE_BODY";
    const response = new Response(bodySentinel, { status: 400 });
    const text = vi.spyOn(response, "text");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));

    await expect(new OpenAICompatibleProvider().generateReply(input)).rejects.toThrow("AI provider returned 400");
    expect(text).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith("ai provider error", { status: 400 });
    expect(JSON.stringify(vi.mocked(logger.error).mock.calls)).not.toContain(bodySentinel);
  });

  it("does not propagate sensitive fetch or parse errors", async () => {
    const sentinel = "SYNTHETIC_SENSITIVE_PROVIDER_EXCEPTION";
    vi.stubGlobal("fetch", vi.fn()
      .mockRejectedValueOnce(new Error(sentinel))
      .mockResolvedValueOnce(new Response(sentinel)));

    const provider = new OpenAICompatibleProvider();
    await expect(provider.generateReply(input)).rejects.toEqual(new Error("AI provider request failed"));
    await expect(provider.generateReply(input)).rejects.toEqual(new Error("AI provider returned an invalid response"));
  });
});

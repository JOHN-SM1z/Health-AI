import { afterEach, describe, expect, it, vi } from "vitest";
import { logger } from "@/lib/logger";

vi.mock("@/lib/logger", () => ({ logger: { error: vi.fn() } }));

/**
 * A patient's spoken health concern goes only to an explicitly allowed, non-foreign speech service
 * (owner decision 2026-10-08: local voice models). Anything else → null, and the Mini App asks the patient to type.
 */
const envState = vi.hoisted(() => ({
  values: {} as Record<string, string | undefined>,
}));
vi.mock("@/lib/env", () => ({
  get env() {
    return envState.values;
  },
  transcriptionEnabled: () => envState.values.ENABLE_TRANSCRIPTION === "true" && !!envState.values.TRANSCRIPTION_API_KEY,
}));

const load = async (values: Record<string, string | undefined>) => {
  envState.values = { TRANSCRIPTION_MODEL: "whisper-1", ...values };
  vi.resetModules();
  return (await import("@/lib/transcription/provider")).getHealthTranscriptionProvider();
};

afterEach(() => {
  envState.values = {};
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("getHealthTranscriptionProvider", () => {
  const on = { ENABLE_TRANSCRIPTION: "true", TRANSCRIPTION_API_KEY: "k" };

  it("allows a listed local host", async () => {
    expect(await load({ ...on, TRANSCRIPTION_BASE_URL: "https://stt.clinic.uz/v1", HEALTH_AUDIO_ALLOWED_HOSTS: "stt.clinic.uz" })).not.toBeNull();
  });

  it("refuses a host that is not listed", async () => {
    expect(await load({ ...on, TRANSCRIPTION_BASE_URL: "https://stt.other.uz/v1", HEALTH_AUDIO_ALLOWED_HOSTS: "stt.clinic.uz" })).toBeNull();
  });

  it("refuses a known foreign provider even when listed", async () => {
    expect(await load({ ...on, TRANSCRIPTION_BASE_URL: "https://api.openai.com/v1", HEALTH_AUDIO_ALLOWED_HOSTS: "api.openai.com" })).toBeNull();
    expect(await load({ ...on, TRANSCRIPTION_BASE_URL: "https://api.groq.com/openai/v1", HEALTH_AUDIO_ALLOWED_HOSTS: "api.groq.com" })).toBeNull();
    expect(await load({ ...on, TRANSCRIPTION_BASE_URL: "https://api.openai.com./v1", HEALTH_AUDIO_ALLOWED_HOSTS: "api.openai.com." })).toBeNull();
  });

  it.each(["http://stt.clinic.uz/v1", "https://user@stt.clinic.uz/v1", "https://stt.clinic.uz/v1?redirect=other"])(
    "refuses a nonsecure or ambiguous endpoint: %s",
    async (baseUrl) => {
      expect(await load({ ...on, TRANSCRIPTION_BASE_URL: baseUrl, HEALTH_AUDIO_ALLOWED_HOSTS: "stt.clinic.uz" })).toBeNull();
    },
  );

  it("uses the approved endpoint and prevents redirects", async () => {
    const provider = await load({ ...on, TRANSCRIPTION_BASE_URL: "https://stt.clinic.uz/v1/", HEALTH_AUDIO_ALLOWED_HOSTS: "stt.clinic.uz" });
    const fetchMock = vi.fn(async () => new Response(null, { status: 307, headers: { Location: "https://unapproved.invalid" } }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(provider!.transcribe({ file: Buffer.from("synthetic audio"), mimeType: "audio/ogg", fileName: "test.ogg" })).rejects.toThrow("returned 307");
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith("https://stt.clinic.uz/v1/audio/transcriptions", expect.objectContaining({ redirect: "error" }));
  });

  it("is off when transcription is disabled or no host is allowed", async () => {
    expect(await load({ TRANSCRIPTION_BASE_URL: "https://stt.clinic.uz/v1", HEALTH_AUDIO_ALLOWED_HOSTS: "stt.clinic.uz" })).toBeNull();
    expect(await load({ ...on, TRANSCRIPTION_BASE_URL: "https://stt.clinic.uz/v1" })).toBeNull();
  });

  it("never logs an upstream error body containing a transcript or credential", async () => {
    const provider = await load({ ...on, TRANSCRIPTION_BASE_URL: "https://stt.clinic.uz/v1", HEALTH_AUDIO_ALLOWED_HOSTS: "stt.clinic.uz" });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("private-transcript-and-credential-sentinel", { status: 500 })));
    await expect(provider!.transcribe({ file: Buffer.from("synthetic audio"), mimeType: "audio/ogg", fileName: "test.ogg" })).rejects.toThrow("returned 500");
    expect(logger.error).toHaveBeenCalledWith("transcription provider error", { status: 500 });
    expect(JSON.stringify(vi.mocked(logger.error).mock.calls)).not.toContain("private-transcript-and-credential-sentinel");
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";

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
  });

  it("is off when transcription is disabled or no host is allowed", async () => {
    expect(await load({ TRANSCRIPTION_BASE_URL: "https://stt.clinic.uz/v1", HEALTH_AUDIO_ALLOWED_HOSTS: "stt.clinic.uz" })).toBeNull();
    expect(await load({ ...on, TRANSCRIPTION_BASE_URL: "https://stt.clinic.uz/v1" })).toBeNull();
  });
});

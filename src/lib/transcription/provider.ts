import "server-only";
import { env, transcriptionEnabled } from "@/lib/env";
import { logger } from "@/lib/logger";

export type TranscriptionResult = {
  text: string;
  provider: string;
};

/**
 * Provider-based transcription interface. Implementations are real
 * integrations; when transcription is not configured the pipeline tells the
 * patient a human can help — it never claims the audio was understood.
 */
export interface TranscriptionProvider {
  readonly name: string;
  transcribe(opts: { file: Buffer; mimeType: string; fileName: string }): Promise<TranscriptionResult>;
}

/** OpenAI-compatible protocol on an approved speech endpoint. */
class OpenAICompatibleTranscriber implements TranscriptionProvider {
  readonly name = "openai-compatible";

  constructor(
    private readonly endpoint: string,
    private readonly apiKey: string,
    private readonly model: string,
  ) {}

  async transcribe(opts: { file: Buffer; mimeType: string; fileName: string }): Promise<TranscriptionResult> {
    const form = new FormData();
    form.append(
      "file",
      new Blob([new Uint8Array(opts.file)], { type: opts.mimeType }),
      opts.fileName || "voice.ogg",
    );
    form.append("model", this.model);

    const res = await fetch(this.endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiKey}` },
      body: form,
      redirect: "error",
      signal: AbortSignal.timeout(60_000),
    });

    if (!res.ok) {
      // Error bodies may echo audio/transcripts, identifiers or credentials.
      logger.error("transcription provider error", { status: res.status });
      throw new Error(`Transcription provider returned ${res.status}`);
    }

    const data = (await res.json()) as { text?: string };
    const text = data.text?.trim();
    if (!text) throw new Error("Transcription provider returned empty text");
    return { text, provider: this.name };
  }
}

/** Speech services outside Uzbekistan; a patient's spoken health concern is never sent to them. */
const FOREIGN_SPEECH_HOSTS = /(^|\.)(openai\.com|groq\.com|deepgram\.com|assemblyai\.com|googleapis\.com|azure\.com|amazonaws\.com|elevenlabs\.io|speechmatics\.com|rev\.ai)$/i;

/**
 * The provider for a patient's spoken health concern in the Mini App and Telegram
 * (owner decision 2026-10-08). Only an HTTPS endpoint whose host is explicitly
 * allowed in HEALTH_AUDIO_ALLOWED_HOSTS and is not a known foreign service.
 * (Aisha/Voicelab's own API is not wired yet — it needs their documentation and keys.)
 */
export function getHealthTranscriptionProvider(): TranscriptionProvider | null {
  const { TRANSCRIPTION_BASE_URL, TRANSCRIPTION_API_KEY, TRANSCRIPTION_MODEL } = env;
  if (!transcriptionEnabled() || !TRANSCRIPTION_BASE_URL || !TRANSCRIPTION_API_KEY) return null;
  const allowed = (env.HEALTH_AUDIO_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((h) => h.trim().toLowerCase().replace(/\.$/, ""))
    .filter(Boolean);
  let endpoint: URL;
  try {
    endpoint = new URL(TRANSCRIPTION_BASE_URL);
  } catch {
    return null;
  }
  const host = endpoint.hostname.toLowerCase().replace(/\.$/, "");
  if (
    endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.search || endpoint.hash ||
    !allowed.includes(host) || FOREIGN_SPEECH_HOSTS.test(host)
  ) return null;
  endpoint.pathname = `${endpoint.pathname.replace(/\/$/, "")}/audio/transcriptions`;
  return new OpenAICompatibleTranscriber(endpoint.toString(), TRANSCRIPTION_API_KEY, TRANSCRIPTION_MODEL);
}

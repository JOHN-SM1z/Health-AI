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

/** OpenAI-compatible audio transcriptions endpoint (OpenAI, Groq, ...). */
export class OpenAICompatibleTranscriber implements TranscriptionProvider {
  readonly name = "openai-compatible";

  async transcribe(opts: { file: Buffer; mimeType: string; fileName: string }): Promise<TranscriptionResult> {
    const baseUrl = env.TRANSCRIPTION_BASE_URL;
    const apiKey = env.TRANSCRIPTION_API_KEY;
    if (!baseUrl || !apiKey) {
      throw new Error("Transcription provider not configured");
    }

    const form = new FormData();
    form.append(
      "file",
      new Blob([new Uint8Array(opts.file)], { type: opts.mimeType }),
      opts.fileName || "voice.ogg",
    );
    form.append("model", env.TRANSCRIPTION_MODEL);

    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/audio/transcriptions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      signal: AbortSignal.timeout(60_000),
    });

    if (!res.ok) {
      const detail = (await res.text()).slice(0, 300);
      logger.error("transcription provider error", { status: res.status, detail });
      throw new Error(`Transcription provider returned ${res.status}`);
    }

    const data = (await res.json()) as { text?: string };
    const text = data.text?.trim();
    if (!text) throw new Error("Transcription provider returned empty text");
    return { text, provider: this.name };
  }
}

let shared: TranscriptionProvider | null = null;

/** Active transcription provider or null when disabled. */
export function getTranscriptionProvider(): TranscriptionProvider | null {
  if (!transcriptionEnabled()) return null;
  if (!shared) shared = new OpenAICompatibleTranscriber();
  return shared;
}
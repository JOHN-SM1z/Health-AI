import { env, aiEnabled } from "@/lib/env";
import { logger } from "@/lib/logger";

export type AiMessage = { role: "system" | "user" | "assistant"; content: string };

export type AiReply = {
  text: string;
  provider: string;
  usedAi: boolean;
};

/**
 * Provider-based AI interface. Implementations must be safe by default:
 * the caller (receptionist) supplies the grounded system prompt, and the
 * caller re-checks the reply against the safety policy before sending it.
 */
export interface AiProvider {
  readonly name: string;
  /** Generates a single chat reply. Throws on provider failure. */
  generateReply(opts: { system: string; messages: AiMessage[] }): Promise<string>;
}

/**
 * OpenAI-compatible chat completions provider (works with OpenAI, DeepSeek,
 * Groq, Together, Ollama, and any OpenAI-compatible endpoint).
 */
export class OpenAICompatibleProvider implements AiProvider {
  readonly name = "openai-compatible";

  async generateReply(opts: { system: string; messages: AiMessage[] }): Promise<string> {
    const baseUrl = env.AI_BASE_URL;
    const apiKey = env.AI_API_KEY;
    if (!baseUrl || !apiKey) {
      throw new Error("AI provider not configured (AI_BASE_URL / AI_API_KEY)");
    }

    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: env.AI_MODEL,
        temperature: env.AI_TEMPERATURE,
        max_tokens: 600,
        messages: [
          { role: "system", content: opts.system },
          ...opts.messages,
        ],
      }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!res.ok) {
      const detail = (await res.text()).slice(0, 300);
      logger.error("ai provider error", { status: res.status, detail });
      throw new Error(`AI provider returned ${res.status}`);
    }

    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const text = data.choices?.[0]?.message?.content?.trim();
    if (!text) throw new Error("AI provider returned empty content");
    return text;
  }
}

/**
 * Deterministic fallback used when AI is disabled or misconfigured.
 * Safe by construction: it never invents facts and always routes to humans
 * when it does not know the answer. The caller passes pre-approved answers
 * (from FAQs / services / doctors) to choose from.
 */
export class FallbackProvider implements AiProvider {
  readonly name = "fallback";

  constructor(private readonly getApprovedAnswers: () => Promise<string[]>) {}

  async generateReply(): Promise<string> {
    const answers = await this.getApprovedAnswers();
    if (answers.length === 0) {
      return (
        "Afsuski, bu savolga aniq javob bera olmayman. " +
        "Operatorlarimiz sizga yordam berishi mumkin — “Operator bilan bog‘lanish” tugmasini bosing."
      );
    }
    return (
      "Klinikamiz haqida so‘rayotganingiz uchun rahmat. Mana ma‘lumot:\n\n" +
      answers.slice(0, 3).map((a) => `• ${a}`).join("\n") +
      "\n\nAgar qo‘shimcha savolingiz bo‘lsa, operatorlarimizga murojaat qilishingiz mumkin."
    );
  }
}

let sharedAiProvider: AiProvider | null = null;

/** Returns the active AI provider, or null when AI is disabled. */
export function getAiProvider(): AiProvider | null {
  if (!aiEnabled()) return null;
  if (!sharedAiProvider) {
    sharedAiProvider = new OpenAICompatibleProvider();
  }
  return sharedAiProvider;
}
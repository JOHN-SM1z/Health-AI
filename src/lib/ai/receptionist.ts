import "server-only";
import { getAiProvider } from "@/lib/ai/provider";
import { buildReceptionistSystemPrompt, loadClinicKnowledge } from "@/lib/ai/knowledge";
import { detectUrgency, urgentMessage, HANDOFF_MESSAGES_UZ, assertSafeAiOutput } from "@/lib/safety/policy";
import { logger } from "@/lib/logger";

export type ReceptionistReply = {
  text: string;
  usedAi: boolean;
  urgent: boolean;
  handoff: boolean;
};

/**
 * Generates a receptionist reply for a patient message.
 *
 * Safety chain:
 *  1. Urgency detection FIRST — urgent wording short-circuits to the
 *     emergency guidance flow, never the AI.
 *  2. AI (when enabled) is grounded in approved clinic knowledge and its
 *     output is re-checked against the safety policy.
 *  3. Deterministic fallback when AI is off or fails.
 */
export async function generateReceptionistReply(opts: {
  clinicId: string;
  userText: string;
  conversationSummary?: string | null;
}): Promise<ReceptionistReply> {
  const { clinicId, userText } = opts;

  // 1. Urgency first.
  if (detectUrgency(userText) === "urgent") {
    return {
      text: `${urgentMessage(userText)}\n\nOperatorlarimiz ham sizga ulanishi mumkin — “Operator bilan bog‘lanish” tugmasini bosing.`,
      usedAi: false,
      urgent: true,
      handoff: true,
    };
  }

  // 2. Deterministic fallback when AI is disabled.
  const provider = getAiProvider();
  if (!provider) {
    const knowledge = await loadClinicKnowledge(clinicId);
    const answers = knowledge.faqs.map((f) => `${f.question} — ${f.answer}`);
    if (answers.length === 0) {
      return {
        text: HANDOFF_MESSAGES_UZ.unknown,
        usedAi: false,
        urgent: false,
        handoff: true,
      };
    }
    return {
      text:
        "Klinikamiz haqida so‘rayotganingiz uchun rahmat. Mana ma‘lumot:\n\n" +
        answers.slice(0, 3).map((a) => `• ${a}`).join("\n") +
        "\n\nAgar qo‘shimcha savolingiz bo‘lsa, “Operator bilan bog‘lanish” tugmasini bosing.",
      usedAi: false,
      urgent: false,
      handoff: false,
    };
  }

  // 3. Grounded AI generation.
  try {
    const knowledge = await loadClinicKnowledge(clinicId);
    const system = buildReceptionistSystemPrompt(knowledge);
    const history = opts.conversationSummary
      ? [
          {
            role: "user" as const,
            content: `[Suhbat xulosasi: ${opts.conversationSummary}]`,
          },
        ]
      : [];

    const text = await provider.generateReply({
      system,
      messages: [...history, { role: "user", content: userText }],
    });

    if (!assertSafeAiOutput(text)) {
      logger.warn("ai output failed safety check", { clinicId });
      return {
        text: HANDOFF_MESSAGES_UZ.unknown,
        usedAi: true,
        urgent: false,
        handoff: true,
      };
    }
    return { text, usedAi: true, urgent: false, handoff: false };
  } catch (e) {
    logger.error("ai receptionist failed, using fallback", {
      error: e instanceof Error ? e.message : String(e),
    });
    const knowledge = await loadClinicKnowledge(clinicId);
    const answers = knowledge.faqs.map((f) => `${f.question} — ${f.answer}`);
    return {
      text:
        answers.length > 0
          ? answers.slice(0, 3).map((a) => `• ${a}`).join("\n") +
            "\n\nAgar qo‘shimcha savolingiz bo‘lsa, operatorlarimizga murojaat qiling."
          : HANDOFF_MESSAGES_UZ.unknown,
      usedAi: false,
      urgent: false,
      handoff: answers.length === 0,
    };
  }
}
import "server-only";
import { loadClinicKnowledge } from "@/lib/ai/knowledge";
import { detectUrgency, urgentMessage, NOT_DIAGNOSIS_DISCLAIMER } from "@/lib/safety/policy";
import { getAiProvider } from "@/lib/ai/provider";
import { logger } from "@/lib/logger";

export const NAVIGATION_STATE_KEY = "navigation";

export type NavigationState = {
  step: number; // 0 = start, 1 = first answer, 2 = recommendation given
  lastUserInput?: string;
};

const QUESTION_1 =
  `${NOT_DIAGNOSIS_DISCLAIMER}\n\n` +
  `Qaysi yo‘nalish bo‘yicha yordam kerakligini aniqlashga harakat qilamiz. ` +
  `Iltimos, muammoingizni bir-ikki gapda yozing (masalan: “doimiy bosh og‘rig‘i”, “bola yo‘talyapti”). ` +
  `Bu tibbiy tashxis emas — faqat qaysi shifokorga murojaat qilishni tanlashga yordam beradi.`;

/**
 * Step 0 of the navigation flow: starts the conversation, or immediately
 * returns the recommendation when AI can suggest one.
 */
export async function startNavigation(): Promise<string> {
  return QUESTION_1;
}

/**
 * Step 1: the patient described their problem. Produce a safe specialty /
 * general consultation / human suggestion. NEVER a diagnosis.
 */
export async function suggestNavigation(clinicId: string, userInput: string): Promise<string> {
  // Urgency beats everything.
  if (detectUrgency(userInput) === "urgent") {
    return (
      `${urgentMessage(userInput)}\n\n` +
      `Iltimos, “Operator bilan bog‘lanish” tugmasini bosing — operatorlarimiz sizga ulanishadi.`
    );
  }

  const knowledge = await loadClinicKnowledge(clinicId);
  const specialties = knowledge.specialties;

  if (specialties.length === 0) {
    return (
      "Hozircha yo‘nalishlar ro‘yxati to‘ldirilmagan. " +
      "Umumiy konsultatsiyaga yozilishingiz yoki operatorlarimiz bilan bog‘lanishingiz mumkin."
    );
  }

  const provider = getAiProvider();
  if (!provider) {
    // Deterministic fallback: offer general consultation + human.
    return (
      `${NOT_DIAGNOSIS_DISCLAIMER}\n\n` +
      `Klinikamizda quyidagi yo‘nalishlar mavjud:\n` +
      specialties.map((s) => `• ${s.name}`).join("\n") +
      `\n\nQaysi biri sizga mos kelishini bilmasangiz, “Umumiy konsultatsiya”ga yozilishingiz mumkin. ` +
      `Ishonchingiz komil bo‘lmasa, operatorlarimiz yordam beradi — “Operator bilan bog‘lanish” tugmasini bosing.`
    );
  }

  try {
    const system =
      `Siz klinika yo‘nalish tanlash yordamchisisiz. ` +
      `Vazifa: bemorning alomatlari (diagnoz EMAS) asosida quyidagi ro‘yxatdan eng mos YO‘NALISHNI (specialty) tavsiya qilish. ` +
      `Qoidalar: 1) Hech qachon kasallik nomini aytmang, tashxis qo‘ymang, davolash taklif qilmang. ` +
      `2) “Bu X kasallik” deb aytish TAQIQLANADI — faqat “X yo‘nalishidagi shifokorga murojaat qilishingiz mumkin” kabi ifodalarni ishlating. ` +
      `3) Mos yo‘nalish bo‘lmasa, umumiy konsultatsiya yoki operator tavsiya qiling. ` +
      `4) Shoshilinch holatda: “Bu holat shoshilinch yordam talab qilishi mumkin. Iltimos, mahalliy tez yordam xizmatiga murojaat qiling yoki zudlik bilan shifokorga boring.” ` +
      `5) Qisqa, Uzbek lotin tilida javob bering. ` +
      `Mavjud yo‘nalishlar: ${specialties.map((s) => s.name).join(", ")}.`;

    const text = await provider.generateReply({
      system,
      messages: [{ role: "user", content: userInput }],
    });
    return `${NOT_DIAGNOSIS_DISCLAIMER}\n\n${text}`;
  } catch (e) {
    logger.error("navigation ai failed, deterministic fallback", {
      error: e instanceof Error ? e.message : String(e),
    });
    return (
      `${NOT_DIAGNOSIS_DISCLAIMER}\n\n` +
      `Klinikamizda quyidagi yo‘nalishlar mavjud:\n` +
      specialties.map((s) => `• ${s.name}`).join("\n") +
      `\n\nQaysi biri mos kelishini bilmasangiz, “Umumiy konsultatsiya”ga yozilishingiz yoki operatorlarimiz bilan bog‘lanishingiz mumkin.`
    );
  }
}
/**
 * Configurable safety policy for the AI receptionist and patient navigation.
 *
 * The system must NEVER diagnose, prescribe, or present AI output as medical
 * advice. This module encodes:
 *  - allowed behaviors
 *  - disallowed claims
 *  - urgent/escalation keywords
 *  - human handoff logic
 *  - deterministic fallback routing
 */

export const URGENT_MESSAGE_UZ =
  "Bu holat shoshilinch yordam talab qilishi mumkin. Iltimos, mahalliy tez yordam xizmatiga murojaat qiling yoki zudlik bilan shifokorga boring.";

export const URGENT_MESSAGE_RU =
  "Эта ситуация может требовать неотложной помощи. Пожалуйста, обратитесь в местную службу скорой помощи или немедленно идите к врачу.";

export const NOT_DIAGNOSIS_DISCLAIMER =
  "Eslatma: bu bot tibbiy tashxis qo‘ymaydi va davolash bo‘yicha tavsiya bermaydi. U faqat klinika ma‘lumotlari va qabulga yozilishda yordam beradi.";

/** Urgent/escalation keywords — Uzbek, Russian, English. Lowercase match. */
export const URGENT_KEYWORDS: string[] = [
  // uz
  "tez yordam", "shoshilinch", "ongini yo'qotdi", "ongini yoqotdi", "hushidan ketdi",
  "qattiq og'riq", "qattiq ogriq", "ko'krak og'rig'i", "ko‘krak og‘rig‘i", "nafas olish qiyin",
  "qon ketish", "yurak xuruji", "infarkt", "insult", "falaj", "zaharlanish", "o'tkir",
  "og'ir ahvol", "ogir ahvol", "hayot xavfi", "behush", "siyanoz", "tutqanoq", "talvasa",
  // uz (Cyrillic)
  "тез ёрдам", "ҳушидан кет", "қон кетиш", "тутқаноқ", "талваса",
  // ru
  "скорая", "скорую", "срочно", "неотложн", "потерял сознание", "резкая боль", "боль в груди",
  "трудно дышать", "кровотечение", "инфаркт", "инсульт", "отравление", "тяжелое состояние", "судорог",
  // en
  "emergency", "urgent", "unconscious", "chest pain", "cannot breathe", "can't breathe",
  "bleeding heavily", "heart attack", "stroke", "suicide", "self-harm", "convulsion", "seizure",
];

const UZ_CYRILLIC_URGENT_PATTERNS = [
  /к[ўу]кра[кг].{0,20}о[ғг]ри/u,
  /нафас.{0,25}([қк]ийин|ололма|ола олма)/u,
];

/** Phrases whose appearance in a message triggers the urgent flow. */
export const URGENT_PATTERNS: RegExp[] = [
  /(shoshilinch|tez yordam)/i,
  /(ongini (yo'qotdi|yoqotdi)|hushidan ket)/i,
  /ko'?kra[kg].{0,20}(og'?ri|pain)/i,
  /(nafas ol).{0,20}(qiyin|olmay)/i,
  /(qon ket)/i,
  /(yurak xuruji|infarkt|insult|infarct|stroke)/i,
  /(заболе|срочн|скорой|неотложн|кровотеч|инфаркт|инсульт)/i,
  /(emergency|urgent|heart attack|stroke|suicide|self-harm)/i,
  /(tez yordam|ambulance)/i,
  ...UZ_CYRILLIC_URGENT_PATTERNS,
];

export type UrgencyLevel = "none" | "urgent";

/** Detects urgent/escalation wording in a free-text message. */
export function detectUrgency(text: string): UrgencyLevel {
  const normalized = normalizeUrgentText(text);
  const keywordHit = URGENT_KEYWORDS.some((k) => normalized.includes(k));
  const patternHit = URGENT_PATTERNS.some((re) => re.test(normalized));
  return keywordHit || patternHit ? "urgent" : "none";
}

function normalizeUrgentText(text: string): string {
  return text.normalize("NFKC").toLowerCase().replace(/[’‘`ʻʼ]/g, "'").replace(/\s+/g, " ");
}

/** Claims the AI must never make, in any wording. */
export const DISALLOWED_CLAIMS: string[] = [
  "diagnoz",
  "tashxis",
  "kasalligingiz",
  "sizda ... kasallik bor",
  "retsept",
  "dori buyur",
  "davolanish",
  "hech qanday shifokor kerak emas",
  "shifokorga borish shart emas",
  "не нужно к врачу",
  "диагноз",
  "лечение",
  "пропишу",
  "you have",
  "you don't need a doctor",
  "prescribe",
  "diagnose",
];

/**
 * Patterns the AI must never produce, e.g. prescribing-style suggestions
 * where the claim is split across words ("sizga antibiotik kerak").
 */
export const DISALLOWED_PATTERNS: RegExp[] = [
  /sizga\s+[\w’'`-]+\s+kerak/i, // "sizga <dori/amal> kerak"
  /свои\s+[\w-]+\s+(принимай|пей|назнач)/i,
];

/** Checks whether the given text contains a disallowed claim pattern. */
export function containsDisallowedClaim(text: string): boolean {
  const lower = text.toLowerCase();
  if (DISALLOWED_CLAIMS.some((c) => lower.includes(c.toLowerCase()))) return true;
  return DISALLOWED_PATTERNS.some((re) => re.test(text));
}

export type HandoffReason = "unknown" | "urgent" | "patient_request" | "transcription_failed";

export const HANDOFF_MESSAGES_UZ: Record<HandoffReason, string> = {
  unknown:
    "Afsuski, bu savolga aniq javob bera olmayman. Operatorlarimiz sizga yordam berishi mumkin — “Operator bilan bog‘lanish” tugmasini bosing.",
  urgent:
    "Sizning xabaringiz shoshilinch yordam talab qilishi mumkin. Iltimos, mahalliy tez yordam xizmatiga murojaat qiling yoki zudlik bilan shifokorga boring. Operatorlarimiz ham sizga ulanishi mumkin.",
  patient_request:
    "Operatorlarimiz sizga yordam berishga tayyor. Iltimos, biroz kuting yoki “Operator bilan bog‘lanish” tugmasini bosing.",
  transcription_failed:
    "Ovozli xabaringizni eshita olmadim. Iltimos, matn shaklida yozing yoki operatorlarimizga murojaat qiling — ular yordam beradi.",
};

export const GENERIC_FALLBACK_UZ =
  "Kechirasiz, savolingizni to‘liq tushunmadim. Quyidagilardan birini tanlang yoki operatorlarimizga murojaat qiling.";

/** Returns the urgent guidance text appropriate for the message language. */
export function urgentMessage(text: string): string {
  const normalized = normalizeUrgentText(text);
  const isUzbekCyrillic = /[ўқғҳ]|тез ёрдам|талваса/u.test(normalized)
    || UZ_CYRILLIC_URGENT_PATTERNS.some((re) => re.test(normalized));
  if (!isUzbekCyrillic && /[а-яё]/u.test(normalized)) return URGENT_MESSAGE_RU;
  return URGENT_MESSAGE_UZ;
}

/** Deterministic rule: when the AI is off or unavailable, this decides routing. */
export function deterministicRoute(text: string): "urgent" | "human" | "ai" {
  if (detectUrgency(text) === "urgent") return "urgent";
  if (/operator|human|админ|человек/.test(text.toLowerCase())) return "human";
  return "ai";
}

/**
 * Markers that an AI reply is echoing its own system instructions or
 * internal details (prompt-leak / prompt-echo). When detected, the reply is
 * discarded and the conversation is routed to a human.
 */
export const PROMPT_LEAK_PATTERNS: RegExp[] = [
  /QAT'?IY\s+QOIDALAR/i,
  /tizim\s+(ko'?rsatma|instruktsiya|qoida|ko‘rsatma)/i,
  /system\s+prompt/i,
  /siz\s+qabulxona\s+yordamchisisiz/i,
  /"system"\s*:/i,
  /"role"\s*:\s*"system"/i,
  /KLINIKA MA'?LUMOTLARI/i,
];

export function assertSafeAiOutput(text: string): boolean {
  if (containsDisallowedClaim(text)) return false;
  return !PROMPT_LEAK_PATTERNS.some((re) => re.test(text));
}

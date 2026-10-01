import type { Database } from "@/lib/supabase/database.types";

/**
 * How a clinical record reads in a handoff. The record itself never changes
 * (clinical_records is append-only: a correction is a new version by the author); what changes is where it stands for the
 * doctor looking at it:
 *
 *   current     — written in that doctor's consultation under way;
 *   historical  — written in any earlier consultation, by whoever wrote it.
 *
 * So Doctor A's diagnosis is a *historical diagnosis* for Doctor B, and the
 * diagnosis Doctor B records in their own consultation is a *new diagnosis*
 * — a separate record, next to A's, never replacing it.
 */

export type ClinicalRecordType = Database["public"]["Enums"]["clinical_record_type"];

export type RecordStage = "current" | "historical";

export type RecordCategory =
  | "historical_diagnosis"
  | "new_diagnosis"
  | "current_assessment"
  | "previous_assessment"
  | "clinical_note"
  | "prescription"
  | "lab_order"
  | "lab_result"
  | "medical_history"
  | "follow_up";

export function recordCategory(type: ClinicalRecordType, stage: RecordStage): RecordCategory {
  switch (type) {
    case "diagnosis":
      return stage === "current" ? "new_diagnosis" : "historical_diagnosis";
    case "assessment":
      return stage === "current" ? "current_assessment" : "previous_assessment";
    case "consultation_note":
      return "clinical_note";
    default:
      return type;
  }
}

export const RECORD_CATEGORY_LABELS: Record<RecordCategory, string> = {
  historical_diagnosis: "Oldingi tashxis",
  new_diagnosis: "Yangi tashxis",
  current_assessment: "Joriy baho",
  previous_assessment: "Oldingi baho",
  clinical_note: "Klinik qayd",
  prescription: "Retsept",
  lab_order: "Tahlilga yo‘llanma",
  lab_result: "Tahlil natijasi",
  medical_history: "Anamnez",
  follow_up: "Keyingi qadam / yo‘llanma",
};

/** What a doctor writes in their own consultation, in the order offered, with a prompt for each. */
export const WRITABLE_RECORD_TYPES: Array<{ value: ClinicalRecordType; label: string; hint: string }> = [
  { value: "assessment", label: "Joriy baho", hint: "Bugungi ko‘rik bo‘yicha bahoingiz" },
  { value: "diagnosis", label: "Yangi tashxis", hint: "Tashxis" },
  { value: "consultation_note", label: "Klinik qayd", hint: "Ko‘rik haqida qayd" },
  { value: "prescription", label: "Retsept", hint: "Dori, dozasi va qabul qilish tartibi" },
  { value: "lab_order", label: "Tahlilga yo‘llanma", hint: "Buyurilgan tahlil yoki tekshiruv" },
  { value: "lab_result", label: "Tahlil natijasi", hint: "Tahlil nomi va natijasi" },
  { value: "medical_history", label: "Anamnez", hint: "Anamnez: surunkali kasallik, allergiya va h.k." },
  { value: "follow_up", label: "Keyingi qadam / yo‘llanma", hint: "Nazorat qabuli, keyingi qadamlar yoki boshqa mutaxassisga yo‘llash" },
];

export const CLINICAL_RECORD_TYPES = WRITABLE_RECORD_TYPES.map((t) => t.value) as [ClinicalRecordType, ...ClinicalRecordType[]];

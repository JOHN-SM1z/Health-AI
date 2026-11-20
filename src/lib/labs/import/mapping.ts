/**
 * Field mapping for historical lab imports (Phase 13). Pure; shared by the
 * server and the mapping screen.
 *
 * A mapping says which column of the file holds which field. Columns are
 * referred to by position (headers are unique). The server suggests a
 * mapping from well-known column names (Uzbek, Russian, English) — exact
 * names only, never a guess from the data — and the preparer confirms or
 * changes it before anything is analysed.
 */

export const IMPORT_FIELDS = [
  "patient_id",
  "pinfl",
  "document_number",
  "phone",
  "date_of_birth",
  "full_name",
  "last_name",
  "first_name",
  "sex",
  "test_code",
  "parameter_code",
  "value",
  "unit",
  "performed_at",
  "accession",
] as const;

export type ImportField = (typeof IMPORT_FIELDS)[number];
export type ImportMapping = Partial<Record<ImportField, number>>;

export const IMPORT_FIELD_LABELS: Record<ImportField, string> = {
  patient_id: "Bemor ID (Health AI)",
  pinfl: "JShShIR (PINFL)",
  document_number: "Pasport / ID karta raqami",
  phone: "Telefon",
  date_of_birth: "Tug‘ilgan sana",
  full_name: "F.I.Sh.",
  last_name: "Familiya",
  first_name: "Ism",
  sex: "Jinsi",
  test_code: "Tahlil (kod yoki nom)",
  parameter_code: "Ko‘rsatkich (kod yoki nom)",
  value: "Natija qiymati",
  unit: "O‘lchov birligi",
  performed_at: "Tahlil sanasi",
  accession: "Manba raqami (buyurtma / namuna)",
};

export const REQUIRED_FIELDS: readonly ImportField[] = ["test_code", "value", "performed_at"];
export const IDENTITY_FIELDS: readonly ImportField[] = ["patient_id", "pinfl", "document_number", "phone", "date_of_birth"];

const SYNONYMS: Record<ImportField, string[]> = {
  patient_id: ["patient id", "patient_id", "bemor id", "health ai id"],
  pinfl: ["pinfl", "jshshir", "jshshr", "пинфл", "jshshir pinfl"],
  document_number: ["passport", "pasport", "паспорт", "document", "document number", "passport number", "pasport raqami", "hujjat raqami", "id karta"],
  phone: ["phone", "telefon", "телефон", "tel", "phone number", "telefon raqami"],
  date_of_birth: ["dob", "date of birth", "birth date", "birthdate", "tugilgan sana", "tug ilgan sana", "дата рождения"],
  full_name: ["full name", "name", "fio", "фио", "f i sh", "fish", "bemor", "patient", "пациент", "ism familiya", "patient name"],
  last_name: ["last name", "surname", "familiya", "фамилия"],
  first_name: ["first name", "ism", "имя"],
  sex: ["sex", "gender", "jins", "jinsi", "пол"],
  test_code: ["test", "test code", "test name", "tahlil", "tahlil kodi", "tahlil nomi", "analysis", "анализ", "код анализа", "исследование"],
  parameter_code: ["parameter", "parameter code", "parameter name", "korsatkich", "ko rsatkich", "показатель", "param"],
  value: ["value", "result", "natija", "qiymat", "результат", "значение"],
  unit: ["unit", "units", "birlik", "olchov birligi", "o lchov birligi", "единица", "ед изм", "ед"],
  performed_at: ["date", "performed at", "result date", "test date", "sana", "tahlil sanasi", "дата", "дата анализа", "дата исследования"],
  accession: ["accession", "order", "order id", "order number", "sample", "sample id", "barcode", "buyurtma", "namuna", "номер", "номер заказа", "штрихкод"],
};

/** Lower case, apostrophes and punctuation dropped, single spaces. */
export function normalizeHeader(h: string): string {
  return h
    .toLowerCase()
    .replace(/[ʻʼ‘’`'"]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** The mapping suggested by column names; each column at most once. */
export function suggestMapping(headers: string[]): ImportMapping {
  const normalized = headers.map(normalizeHeader);
  const used = new Set<number>();
  const mapping: ImportMapping = {};
  for (const field of IMPORT_FIELDS) {
    const names = SYNONYMS[field].map(normalizeHeader);
    const index = normalized.findIndex((h, i) => !used.has(i) && names.includes(h));
    if (index >= 0) {
      mapping[field] = index;
      used.add(index);
    }
  }
  return mapping;
}

export type MappingProblem = "missing_required" | "no_identity" | "column_reused" | "column_out_of_range";

export const MAPPING_PROBLEM_MESSAGES: Record<MappingProblem, string> = {
  missing_required: "Tahlil, natija qiymati va tahlil sanasi ustunlarini tanlang",
  no_identity: "Bemorni aniqlash uchun kamida bitta ustun tanlang: bemor ID, JShShIR, pasport, telefon yoki tug‘ilgan sana",
  column_reused: "Bitta ustun ikki maydonga tanlangan",
  column_out_of_range: "Faylda bunday ustun yo‘q",
};

export function checkMapping(mapping: ImportMapping, columnCount: number): MappingProblem | null {
  const columns = Object.values(mapping).filter((v): v is number => v !== undefined);
  if (columns.some((c) => !Number.isInteger(c) || c < 0 || c >= columnCount)) return "column_out_of_range";
  if (new Set(columns).size !== columns.length) return "column_reused";
  if (REQUIRED_FIELDS.some((f) => mapping[f] === undefined)) return "missing_required";
  if (!IDENTITY_FIELDS.some((f) => mapping[f] !== undefined)) return "no_identity";
  return null;
}

import type { RowError } from "@/lib/labs/import/analyse";

/** Uzbek wording for import row statuses and reasons (screen and report). */

export const IMPORT_STATUS_LABELS = {
  pending: "Tahlil qilinmagan",
  ready: "Tayyor",
  invalid: "Xato",
  unmatched: "Bemor topilmadi",
  possible_match: "Bemorni tasdiqlang",
  conflict: "Ziddiyat",
  duplicate: "Takror",
  imported: "Import qilindi",
  failed: "Import bo‘lmadi",
  skipped: "O‘tkazib yuborildi",
} as const;

export const IMPORT_BATCH_STATUS_LABELS = {
  uploaded: "Yuklangan",
  analysed: "Tahlil qilingan",
  confirmed: "Tasdiqlangan",
  completed: "Yakunlangan",
  cancelled: "Bekor qilingan",
} as const;

type RunError = "already_imported" | "existing_result" | "value_rejected" | "invalid_date" | "preparer_not_staff" | "reference_missing" | "import_failed";

export const IMPORT_ERROR_LABELS: Record<RowError | RunError, string> = {
  malformed_row: "Qatordagi kataklar soni sarlavhaga mos emas",
  invalid_patient_id: "Bemor ID noto‘g‘ri",
  invalid_pinfl: "JShShIR 14 ta raqam bo‘lishi kerak",
  invalid_document: "Pasport / ID raqami noto‘g‘ri",
  invalid_phone: "Telefon raqami noto‘g‘ri",
  invalid_dob: "Tug‘ilgan sana noto‘g‘ri",
  invalid_sex: "Jinsi noto‘g‘ri",
  no_identifiers: "Bemorni aniqlaydigan ma’lumot yo‘q",
  missing_test: "Tahlil ko‘rsatilmagan",
  unknown_test: "Tahlil katalogda topilmadi",
  missing_parameter: "Ko‘rsatkich ko‘rsatilmagan (tahlilda bir nechta ko‘rsatkich bor)",
  unknown_parameter: "Ko‘rsatkich bu tahlilda topilmadi",
  missing_value: "Natija qiymati yo‘q",
  invalid_value: "Qiymat ko‘rsatkich sozlamalariga mos emas",
  unit_mismatch: "O‘lchov birligi katalogdagidan farq qiladi (aylantirilmaydi)",
  missing_date: "Tahlil sanasi yo‘q",
  invalid_date: "Tahlil sanasi noto‘g‘ri",
  future_date: "Tahlil sanasi kelajakda",
  performed_before_birth: "Tahlil sanasi tug‘ilgan sanadan oldin",
  accession_too_long: "Manba raqami juda uzun",
  insufficient_identifiers: "Bemorni aniqlash uchun ma’lumot yetarli emas (faqat ism bo‘yicha moslanmaydi)",
  no_candidate: "Klinikada bunday bemor yo‘q",
  confirm_patient: "Bemor ehtimoliy topildi — tasdiqlang",
  patient_id_unknown: "Bunday bemor ID klinikada yo‘q",
  identifiers_disagree: "Identifikatorlar turli bemorlarga tegishli",
  pinfl_differs: "JShShIR bemor kartasidagidan farq qiladi",
  document_differs: "Pasport raqami bemor kartasidagidan farq qiladi",
  dob_differs: "Tug‘ilgan sana bemor kartasidagidan farq qiladi",
  sex_differs: "Jinsi bemor kartasidagidan farq qiladi",
  several_patients: "Bir nechta bemor mos keladi (ehtimoliy takror kartalar)",
  duplicate_in_file: "Faylda takrorlangan qator",
  conflicting_in_file: "Faylda bir ko‘rsatkich uchun turli qiymatlar",
  several_results_same_day: "Bir kunda bir tahlil uchun bir nechta natija",
  group_has_errors: "Shu natijaning boshqa qatorida xato bor",
  existing_result: "Bu natija klinikada allaqachon bor",
  existing_result_differs: "Klinikada shu kun uchun boshqa natija bor — almashtirilmaydi",
  name_differs: "Ism bemor kartasidagidan farq qiladi",
  phone_differs: "Telefon bemor kartasidagidan farq qiladi",
  already_imported: "Allaqachon import qilingan",
  value_rejected: "Qiymat qabul qilinmadi",
  preparer_not_staff: "Tayyorlovchi endi klinika xodimi emas",
  reference_missing: "Bemor yoki tahlil endi mavjud emas",
  import_failed: "Import qilib bo‘lmadi",
};

export const WARNING_CODES = new Set(["name_differs", "phone_differs"]);

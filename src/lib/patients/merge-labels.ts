/** Uzbek wording for the patient merge preview (Phase 14). Client-safe. */

export const MERGE_BLOCKER_LABELS: Record<string, string> = {
  same_patient: "Bir xil bemor tanlangan",
  canonical_merged: "Asosiy karta allaqachon boshqa kartaga birlashtirilgan",
  duplicate_merged: "Takror karta allaqachon birlashtirilgan",
  duplicate_has_merged_records: "Takror kartaga boshqa kartalar birlashtirilgan — uni asosiy karta sifatida tanlang",
  dob_differs: "Tug‘ilgan sanalar farq qiladi — bular turli odamlar bo‘lishi mumkin",
  sex_differs: "Jinsi farq qiladi",
  pinfl_differs: "JShShIR farq qiladi",
  document_differs: "Pasport / ID raqami farq qiladi",
  telegram_differs: "Ikki kartada turli Telegram hisoblari bor",
  duplicate_active_appointments: "Takror kartada faol yoki kelgusi qabullar bor — avval ularni yakunlang yoki bekor qiling",
  duplicate_open_referrals: "Takror kartada ochiq yo‘llanmalar bor",
  duplicate_active_lab_orders: "Takror kartada faol laboratoriya buyurtmalari bor",
  duplicate_unfinished_lab_results: "Takror kartada tugallanmagan laboratoriya natijalari bor",
  duplicate_open_conversations: "Takror kartada ochiq suhbatlar bor — avval yoping",
  duplicate_pending_notifications: "Takror karta uchun yuborilmagan bildirishnomalar bor",
  duplicate_pending_import: "Takror kartaga import kutilayotgan qatorlar bor",
};

export const MERGE_WARNING_LABELS: Record<string, string> = {
  name_differs: "Ismlar farq qiladi — asosiy kartadagi ism qoladi",
  phone_differs: "Telefonlar farq qiladi — asosiy kartadagi telefon qoladi",
  doctor_access_extends: "Quyidagi shifokorlar birlashtirilgan kartani ko‘radi (har biri faqat o‘z qabullarini, avvalgidek)",
};

export const MERGE_PLAN_LABELS: Record<string, string> = {
  keep: "O‘zgarmaydi",
  same: "Bir xil",
  copy: "Takror kartadan nusxa olinadi",
  move: "Takror kartadan ko‘chiriladi",
  differs: "Farq qiladi",
};

export const MERGE_FIELD_LABELS: Record<string, string> = {
  full_name: "F.I.Sh.",
  phone: "Telefon",
  date_of_birth: "Tug‘ilgan sana",
  sex: "Jinsi",
  pinfl: "JShShIR",
  document_number: "Pasport / ID",
  telegram_user_id: "Telegram hisobi",
  consent: "Rozilik",
};

export const MERGE_COUNT_LABELS: Record<string, string> = {
  appointments: "Qabullar",
  payments: "To‘lovlar",
  conversations: "Suhbatlar",
  referrals: "Yo‘llanmalar",
  clinical_records: "Tibbiy yozuvlar (soni)",
  lab_orders: "Laboratoriya buyurtmalari",
  lab_results: "Laboratoriya natijalari (versiyalar)",
  lab_documents: "Laboratoriya hujjatlari",
  audit_events: "Jurnal yozuvlari",
};

export const DUPLICATE_REASON_LABELS: Record<string, string> = {
  same_name_and_birth_date: "Ism va tug‘ilgan sana bir xil",
  same_phone_and_birth_date: "Telefon va tug‘ilgan sana bir xil",
  same_name_and_phone: "Ism va telefon bir xil",
};

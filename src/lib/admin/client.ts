"use client";

export class AdminApiError extends Error {
  status: number;
  code?: string;
  /** Safe structured extras from the server (e.g. the matching patients of a possible duplicate). */
  details?: Record<string, unknown>;
  constructor(status: number, message: string, code?: string, details?: Record<string, unknown>) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

async function request<T>(path: string, method: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new AdminApiError(res.status, data?.error ?? "Xatolik yuz berdi", data?.code, data?.details);
  }
  // Server responses are wrapped in { ok: true, data }; unwrap so callers
  // receive the payload directly.
  if (typeof data === "object" && data !== null && data.ok === true && "data" in data) {
    return data.data as T;
  }
  return data as T;
}

export const adminApi = {
  get: <T>(path: string) => request<T>(path, "GET"),
  post: <T>(path: string, body?: unknown) => request<T>(path, "POST", body),
  patch: <T>(path: string, body?: unknown) => request<T>(path, "PATCH", body),
  put: <T>(path: string, body?: unknown) => request<T>(path, "PUT", body),
  del: <T>(path: string) => request<T>(path, "DELETE"),
};

export const STATUS_LABELS: Record<string, string> = {
  pending: "Kutilmoqda",
  confirmed: "Tasdiqlangan",
  checked_in: "Keldi",
  in_progress: "Jarayonda",
  completed: "Yakunlangan",
  cancelled: "Bekor qilingan",
  no_show: "Kelmagandi",
};

export const STATUS_TONES: Record<string, "amber" | "blue" | "green" | "purple" | "neutral" | "gray" | "red"> = {
  pending: "amber",
  confirmed: "blue",
  checked_in: "green",
  in_progress: "purple",
  completed: "green",
  cancelled: "red",
  no_show: "gray",
};

export const PAYMENT_STATUS_LABELS: Record<string, string> = {
  paid: "To‘langan",
  unpaid: "To‘lanmagan",
  pending: "Kutilmoqda",
  refunded: "Qaytarilgan",
  failed: "Muvaffaqiyatsiz",
  manual_review: "Tekshiruvda",
};

export const PAYMENT_STATUS_TONES: Record<string, "green" | "amber" | "blue" | "gray" | "red" | "purple"> = {
  paid: "green",
  unpaid: "amber",
  pending: "blue",
  refunded: "gray",
  failed: "red",
  manual_review: "purple",
};

export const REFERRAL_STATUS_LABELS: Record<string, string> = {
  pending: "Kutilmoqda",
  accepted: "Qabul qilindi",
  in_progress: "Qabul boshlangan",
  declined: "Rad etildi",
  completed: "Yakunlandi",
  revoked: "Bekor qilindi",
  expired: "Muddati o‘tgan",
};

export const REFERRAL_STATUS_TONES: Record<string, "amber" | "blue" | "green" | "red" | "gray"> = {
  pending: "amber",
  accepted: "blue",
  in_progress: "blue",
  declined: "red",
  completed: "green",
  revoked: "gray",
  expired: "gray",
};

export const REFERRAL_PRIORITY_LABELS: Record<string, string> = {
  routine: "Oddiy",
  urgent: "Shoshilinch",
};

/** Doctor-authored clinical record types (public.clinical_record_type). */
export const CLINICAL_RECORD_TYPE_LABELS: Record<string, string> = {
  consultation_note: "Klinik qayd",
  assessment: "Klinik baho",
  diagnosis: "Tashxis",
  prescription: "Retsept",
  lab_order: "Tahlilga yo‘llanma",
  lab_result: "Tahlil natijasi",
  medical_history: "Anamnez",
  follow_up: "Keyingi qadam / yo‘llanma",
};

export const CLINICAL_RECORD_TYPE_TONES: Record<string, "neutral" | "green" | "red" | "amber" | "blue" | "purple"> = {
  consultation_note: "neutral",
  assessment: "blue",
  diagnosis: "purple",
  prescription: "green",
  lab_order: "amber",
  lab_result: "blue",
  medical_history: "amber",
  follow_up: "neutral",
};

export const SOURCE_LABELS: Record<string, string> = {
  telegram_mini_app: "Mini App",
  telegram_chat: "Telegram bot",
  web: "Veb-sayt",
  admin: "Admin",
  walk_in: "Navbatda",
};

// A conversation's `channel` (conversation_channel: 'telegram' | 'mini_app')
// is a different domain than an appointment's `source` above — distinct
// enum, distinct values — kept in its own map rather than folded into
// SOURCE_LABELS so a lookup miss here can't be mistaken for one there.
export const CHANNEL_LABELS: Record<string, string> = {
  telegram: "Telegram",
  mini_app: "Mini App",
};

export function formatDateTime(iso: string | null | undefined, withSeconds = false): string {
  if (!iso) return "—";
  const d = new Date(iso);
  const date = d.toLocaleDateString("uz-UZ", { day: "2-digit", month: "2-digit", year: "numeric" });
  const time = d.toLocaleTimeString("uz-UZ", { hour: "2-digit", minute: "2-digit", ...(withSeconds ? { second: "2-digit" } : {}) });
  return `${date} ${time}`;
}

export function formatTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleTimeString("uz-UZ", { hour: "2-digit", minute: "2-digit" });
}

export function formatPrice(amount: number | null | undefined): string {
  if (amount == null) return "—";
  return `${amount.toLocaleString("uz-UZ")} so‘m`;
}
"use client";

export class AdminApiError extends Error {
  status: number;
  code?: string;
  constructor(status: number, message: string, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
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
    throw new AdminApiError(res.status, data?.error ?? "Xatolik yuz berdi", data?.code);
  }
  return data as T;
}

export const adminApi = {
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

export const SOURCE_LABELS: Record<string, string> = {
  telegram_mini_app: "Mini App",
  telegram_bot: "Telegram bot",
  admin: "Admin",
  walk_in: "Navbatda",
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
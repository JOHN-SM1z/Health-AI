"use client";

/**
 * Typed client for the patient-facing APIs. Every call includes the
 * Telegram initData so the server can verify identity — the browser never
 * claims an identity on its own.
 */
export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: string; code?: string; status: number };

export async function apiPost<T>(path: string, body: unknown, initData: string | null): Promise<ApiResult<T>> {
  return apiFetch<T>(path, { method: "POST", body: JSON.stringify({ ...(body as object), initData }) });
}

export async function apiGet<T>(path: string, initData: string | null): Promise<ApiResult<T>> {
  return apiFetch<T>(path, { method: "POST", body: JSON.stringify({ initData }) });
}

async function apiFetch<T>(path: string, init: RequestInit): Promise<ApiResult<T>> {
  try {
    const res = await fetch(path, {
      ...init,
      headers: { "Content-Type": "application/json" },
    });
    const json = (await res.json()) as { ok?: boolean; data?: T; error?: string; code?: string };
    if (res.ok && json.ok && json.data !== undefined) {
      return { ok: true, data: json.data };
    }
    return { ok: false, error: json.error ?? "Xatolik yuz berdi", code: json.code, status: res.status };
  } catch {
    return { ok: false, error: "Tarmoq xatoligi", status: 0 };
  }
}
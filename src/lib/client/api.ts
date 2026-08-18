"use client";

/**
 * Typed client for the patient-facing APIs. Every call includes the
 * Telegram initData so the server can verify identity — the browser never
 * claims an identity on its own. The clinic tenant is embedded in the
 * web_app URL (?clinic=<id>); it is forwarded on every call so the server
 * resolves the right clinic.
 */

const CLINIC_STORAGE_KEY = "health-ai.clinic-id";

export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: string; code?: string; status: number };

/** Clinic id for the current Mini App session (URL param or stored). */
export function getClientClinicId(): string | null {
  if (typeof window === "undefined") return null;
  const fromUrl = new URLSearchParams(window.location.search).get("clinic");
  if (fromUrl) {
    sessionStorage.setItem(CLINIC_STORAGE_KEY, fromUrl);
    return fromUrl;
  }
  return sessionStorage.getItem(CLINIC_STORAGE_KEY);
}

export async function apiPost<T>(path: string, body: unknown, initData: string | null): Promise<ApiResult<T>> {
  return apiFetch<T>(path, { method: "POST", body: JSON.stringify({ ...(body as object), initData }) });
}

export async function apiGet<T>(path: string, initData: string | null): Promise<ApiResult<T>> {
  return apiFetch<T>(path, { method: "POST", body: JSON.stringify({ initData }) });
}

async function apiFetch<T>(path: string, init: RequestInit): Promise<ApiResult<T>> {
  const clinicId = getClientClinicId();
  const url = clinicId
    ? `${path}${path.includes("?") ? "&" : "?"}clinic=${encodeURIComponent(clinicId)}`
    : path;
  try {
    const res = await fetch(url, {
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

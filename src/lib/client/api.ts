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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function readStored(storage: () => Storage): string | null {
  try {
    const v = storage().getItem(CLINIC_STORAGE_KEY);
    return v && UUID.test(v) ? v : null;
  } catch {
    return null;
  }
}

/**
 * Clinic id for the Mini App: the URL's ?clinic= when present (and a
 * well-formed id), otherwise the one remembered from an earlier visit. It is
 * kept in localStorage as well as sessionStorage, so re-opening the Mini App
 * from a link without ?clinic= still reaches the same clinic. It is only a
 * tenant hint: the server verifies the patient's Telegram signature against
 * that clinic's own bot, so a wrong value can never show someone's data.
 */
export function getClientClinicId(): string | null {
  if (typeof window === "undefined") return null;
  const fromUrl = new URLSearchParams(window.location.search).get("clinic");
  if (fromUrl && UUID.test(fromUrl)) {
    for (const storage of [() => sessionStorage, () => localStorage]) {
      try {
        storage().setItem(CLINIC_STORAGE_KEY, fromUrl);
      } catch {
        // storage unavailable (private mode) — the URL still works
      }
    }
    return fromUrl;
  }
  return readStored(() => sessionStorage) ?? readStored(() => localStorage);
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
    // Sanitize body: remove initData when it is null to avoid sending a null value
    // that some server-side validators may treat as an unexpected type.
    let body = init.body;
    const headers = { "Content-Type": "application/json", ...(init.headers ?? {}) };

    if (typeof body === "string") {
      try {
        const parsed = JSON.parse(body);
        if (Object.prototype.hasOwnProperty.call(parsed, "initData") && parsed.initData == null) {
          delete parsed.initData;
        }
        body = JSON.stringify(parsed);
      } catch {
        // leave as-is if not valid JSON
      }
    }

    const res = await fetch(url, {
      ...init,
      body,
      headers,
    });

    let json: { ok?: boolean; data?: T; error?: string; code?: string } | null = null;
    try {
      json = (await res.json()) as { ok?: boolean; data?: T; error?: string; code?: string };
    } catch {
      // Non-JSON response (e.g. 500/502 HTML error page)
    }

    if (res.ok && json?.ok && json?.data !== undefined) {
      return { ok: true, data: json.data };
    }

    const fallbackError = res.status >= 500 ? "Serverda xatolik yuz berdi" : "Xatolik yuz berdi";
    return { ok: false, error: json?.error ?? fallbackError, code: json?.code, status: res.status };
  } catch {
    return { ok: false, error: "Tarmoq xatoligi", status: 0 };
  }
}

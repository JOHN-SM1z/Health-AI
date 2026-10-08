"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { adminApi, AdminApiError } from "@/lib/admin/client";

/**
 * Loads `path` now and every `intervalMs` while the tab is visible, and at
 * once when the tab comes back. A failed background refresh keeps the last
 * good data and marks it stale — it never pretends the old list is current.
 */
export function useLive<T>(path: string | null, intervalMs = 10_000) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  const [stale, setStale] = useState(false);
  const inFlight = useRef(false);

  const load = useCallback(async () => {
    if (!path || inFlight.current) return;
    inFlight.current = true;
    try {
      setData(await adminApi.get<T>(path));
      setError(null);
      setStale(false);
      setUpdatedAt(new Date());
    } catch (e) {
      setError(e instanceof AdminApiError ? e.message : "Ma’lumotni yuklab bo‘lmadi");
      setStale(true);
    } finally {
      inFlight.current = false;
    }
  }, [path]);

  useEffect(() => {
    void load();
    const tick = () => {
      if (document.visibilityState === "visible") void load();
    };
    const timer = window.setInterval(tick, intervalMs);
    document.addEventListener("visibilitychange", tick);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [load, intervalMs]);

  return { data, error, updatedAt, stale, reload: load };
}

/** "Yangilandi 14:05" — or that the shown data is out of date. */
export function freshnessLabel(updatedAt: Date | null, stale: boolean): string {
  if (!updatedAt) return stale ? "Yuklab bo‘lmadi" : "Yuklanmoqda…";
  const t = updatedAt.toLocaleTimeString("uz-UZ", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  return stale ? `Eskirgan ma’lumot (oxirgi: ${t}) — aloqa yo‘q` : `Yangilandi ${t}`;
}

export const VISIT_STATUS: Record<string, { label: string; tone: "amber" | "blue" | "green" | "gray" | "red" | "purple" }> = {
  awaiting_payment: { label: "Kassada to‘lov kutilmoqda", tone: "amber" },
  waiting: { label: "Navbatda", tone: "blue" },
  called: { label: "Chaqirildi", tone: "purple" },
  in_progress: { label: "Qabulda", tone: "green" },
  completed: { label: "Yakunlandi", tone: "gray" },
  cancelled: { label: "Bekor qilindi", tone: "red" },
};

export function money(n: number, currency = "UZS"): string {
  const unit = currency === "UZS" ? "so‘m" : currency;
  return `${n.toLocaleString("uz-UZ", { maximumFractionDigits: 2 })} ${unit}`;
}

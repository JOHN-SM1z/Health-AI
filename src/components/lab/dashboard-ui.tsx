"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { ShieldAlert } from "lucide-react";
import { AEmpty, AError, Card, LoadingRow } from "@/components/admin/ui";
import { adminApi, AdminApiError } from "@/lib/admin/client";

/**
 * Shared pieces of the laboratory dashboards (Phase 17), built from the
 * existing admin UI kit — no separate visual system.
 */

export type DashboardLoad<T> =
  | { state: "loading" }
  | { state: "forbidden"; message: string }
  | { state: "error"; message: string }
  | { state: "ready"; data: T };

/** Loads a dashboard endpoint and keeps it fresh (every `refreshMs`, default 60 s). */
export function useDashboard<T>(url: string | null, refreshMs = 60_000): { load: DashboardLoad<T>; reload: () => void } {
  const [load, setLoad] = useState<DashboardLoad<T>>({ state: "loading" });
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    if (!url) return;
    let cancelled = false;
    adminApi
      .get<T>(url)
      .then((data) => !cancelled && setLoad({ state: "ready", data }))
      .catch((e) => {
        if (cancelled) return;
        if (e instanceof AdminApiError && (e.status === 401 || e.status === 403)) {
          setLoad({ state: "forbidden", message: e.message });
        } else {
          setLoad({ state: "error", message: e instanceof AdminApiError ? e.message : "Ma’lumotlarni yuklab bo‘lmadi" });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [url, tick]);

  useEffect(() => {
    if (!url || refreshMs <= 0) return;
    const id = setInterval(reload, refreshMs);
    return () => clearInterval(id);
  }, [url, refreshMs, reload]);

  return { load, reload };
}

/** Loading, permission and error states; renders `children(data)` when ready. */
export function DashboardState<T>({ load, children }: { load: DashboardLoad<T>; children: (data: T) => ReactNode }) {
  if (load.state === "loading") {
    return (
      <Card>
        <p className="sr-only" role="status">Yuklanmoqda…</p>
        <LoadingRow />
      </Card>
    );
  }
  if (load.state === "forbidden") {
    return (
      <Card>
        <AEmpty
          icon={<ShieldAlert className="h-8 w-8" />}
          title="Bu sahifani ko‘rish uchun ruxsat yo‘q"
          subtitle="Ko‘rsatkichlar faqat ularga ruxsati bor xodimlarga ko‘rsatiladi."
        />
      </Card>
    );
  }
  if (load.state === "error") return <AError message={load.message} />;
  return <>{children(load.data)}</>;
}

export function SectionTitle({ children, hint }: { children: ReactNode; hint?: string }) {
  return (
    <div className="mb-3">
      <h2 className="font-display text-base font-semibold tracking-tight text-foreground">{children}</h2>
      {hint && <p className="mt-0.5 text-xs text-ink-muted">{hint}</p>}
    </div>
  );
}

/** Horizontal bars in the analytics page's style. */
export function Bars({ rows, format }: { rows: Array<{ label: string; value: number }>; format?: (n: number) => string }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <div className="space-y-3.5">
      {rows.map((r) => (
        <div key={r.label}>
          <div className="mb-1.5 flex justify-between gap-3 text-sm">
            <span className="min-w-0 truncate text-ink-muted">{r.label}</span>
            <span className="font-numeric shrink-0 font-medium text-foreground">{format ? format(r.value) : r.value.toLocaleString("uz-UZ")}</span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-sand">
            <div
              className="h-full rounded-full bg-gradient-to-r from-pine to-mint transition-[width] duration-500"
              style={{ width: `${Math.max((r.value / max) * 100, 4)}%` }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

/** Hours as "1 soatdan kam" / "3,5 soat" / "2 kun 4 soat"; "—" when unknown. */
export function formatHours(h: number | null | undefined): string {
  if (h === null || h === undefined) return "—";
  if (h < 1) return "1 soatdan kam";
  if (h < 48) return `${h.toLocaleString("uz-UZ", { maximumFractionDigits: 1 })} soat`;
  const days = Math.floor(h / 24);
  const rest = Math.round(h - days * 24);
  return rest ? `${days} kun ${rest} soat` : `${days} kun`;
}

/** "45 daqiqa", "5 soat", "3 kun" since an instant. */
export function formatWaiting(since: string | null, now = Date.now()): string {
  if (!since) return "—";
  const minutes = Math.max(0, Math.round((now - Date.parse(since)) / 60_000));
  if (minutes < 60) return `${minutes} daqiqa`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} soat`;
  return `${Math.round(hours / 24)} kun`;
}

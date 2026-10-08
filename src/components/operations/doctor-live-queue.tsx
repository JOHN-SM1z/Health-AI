"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Card, ABadge, AButton, AError } from "@/components/admin/ui";
import { adminApi, AdminApiError } from "@/lib/admin/client";
import { freshnessLabel, useLive, VISIT_STATUS } from "@/components/operations/use-live";

type Visit = {
  id: string;
  status: "waiting" | "called" | "in_progress";
  queueNumber: number | null;
  patient: { id: string; patientNumber: number; fullName: string | null };
  services: string[];
};

/**
 * The doctor's own walk-in queue (paid visits only): call the next patient,
 * start the consultation (opens the patient's workspace, where records are
 * written as usual) and complete it. Arrival order, not appointment times.
 */
export function DoctorLiveQueue() {
  const router = useRouter();
  const live = useLive<{ visits: Visit[] }>("/api/doctor/visits", 10_000);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const act = async (v: Visit, action: "call" | "recall" | "start" | "complete") => {
    setBusy(v.id);
    setError(null);
    try {
      const r = await adminApi.post<{ patientId?: string }>(`/api/doctor/visits/${v.id}`, { action, expected: v.status });
      if (action === "start" && r.patientId) {
        router.push(`/doctor/patients/${r.patientId}`);
        return;
      }
      await live.reload();
    } catch (e) {
      setError(e instanceof AdminApiError ? e.message : "Amalni bajarib bo‘lmadi");
      await live.reload();
    } finally {
      setBusy(null);
    }
  };

  const visits = live.data?.visits ?? [];
  if (live.data && visits.length === 0) return null;

  return (
    <Card className="mb-6">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <p className="font-display text-sm font-bold text-foreground">Jonli navbat ({visits.length})</p>
        <span className={`text-xs ${live.stale ? "font-semibold text-danger" : "text-ink-muted"}`}>{freshnessLabel(live.updatedAt, live.stale)}</span>
      </div>
      {error && <AError message={error} />}
      {!live.data ? (
        <p className="text-sm text-ink-muted">{live.error ?? "Yuklanmoqda…"}</p>
      ) : (
        <ul className="divide-y divide-hairline" aria-label="Jonli navbat">
          {visits.map((v) => (
            <li key={v.id} className="flex flex-wrap items-center justify-between gap-3 py-2.5">
              <div className="flex items-center gap-3">
                <span className="font-numeric text-2xl font-bold">{v.queueNumber ?? "—"}</span>
                <div>
                  <p className="text-sm font-medium">{v.patient.fullName}</p>
                  <p className="text-xs text-ink-muted">
                    Karta № {v.patient.patientNumber} · {v.services.join(", ")}
                  </p>
                </div>
                <ABadge tone={VISIT_STATUS[v.status]?.tone}>{VISIT_STATUS[v.status]?.label}</ABadge>
              </div>
              <div className="flex gap-1.5">
                {v.status === "waiting" && (
                  <AButton size="sm" variant="secondary" loading={busy === v.id} onClick={() => act(v, "call")}>
                    Chaqirish
                  </AButton>
                )}
                {v.status === "called" && (
                  <AButton size="sm" variant="outline" loading={busy === v.id} onClick={() => act(v, "recall")}>
                    Navbatga qaytarish
                  </AButton>
                )}
                {(v.status === "waiting" || v.status === "called") && (
                  <AButton size="sm" loading={busy === v.id} onClick={() => act(v, "start")}>
                    Qabulni boshlash
                  </AButton>
                )}
                {v.status === "in_progress" && (
                  <>
                    <AButton size="sm" variant="outline" onClick={() => router.push(`/doctor/patients/${v.patient.id}`)}>
                      Bemor kartasi
                    </AButton>
                    <AButton size="sm" loading={busy === v.id} onClick={() => act(v, "complete")}>
                      Yakunlash
                    </AButton>
                  </>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

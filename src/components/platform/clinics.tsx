"use client";

import { useEffect, useState } from "react";
import { Card, AButton, ABadge } from "@/components/admin/ui";

export type PlatformClinic = {
  id: string;
  name: string;
  slug: string | null;
  timezone: string;
  is_active: boolean;
  created_at: string;
  clinic_telegram_integrations: {
    status: string;
    enabled: boolean;
    telegram_username: string | null;
    webhook_status: string | null;
    validated_at: string | null;
  } | null;
};

const statusTone: Record<string, "green" | "red" | "neutral"> = {
  active: "green",
  error: "red",
  disabled: "neutral",
};

export function PlatformClinics({ clinics }: { clinics: PlatformClinic[] }) {
  const [items, setItems] = useState(clinics);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setItems(clinics), [clinics]);

  async function toggle(clinicId: string, isActive: boolean) {
    setBusyId(clinicId);
    setError(null);
    try {
      const res = await fetch(`/api/platform/clinics?id=${encodeURIComponent(clinicId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isActive }),
      });
      const json = await res.json();
      if (!res.ok || !json.ok) {
        setError(json.error ?? "Update failed");
        return;
      }
      setItems((prev) => prev.map((c) => (c.id === clinicId ? { ...c, is_active: isActive } : c)));
    } finally {
      setBusyId(null);
    }
  }

  if (items.length === 0) {
    return <p className="text-sm text-ink-muted">No clinics registered yet.</p>;
  }

  return (
    <div className="space-y-4">
      {error && <div className="rounded-xl border border-danger/25 bg-danger-tint px-4 py-3 text-sm font-medium text-danger">{error}</div>}
      {items.map((clinic) => {
        const bot = clinic.clinic_telegram_integrations;
        const botStatus = bot ? (bot.status as string) : "disabled";
        return (
          <Card key={clinic.id}>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="font-display font-bold text-foreground">{clinic.name}</p>
                <p className="text-sm text-ink-muted">
                  {clinic.slug ?? "no slug"} · {clinic.timezone} · created {new Date(clinic.created_at).toLocaleDateString()}
                </p>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <ABadge tone={clinic.is_active ? "green" : "neutral"}>
                    {clinic.is_active ? "Active" : "Inactive"}
                  </ABadge>
                  <ABadge tone={statusTone[botStatus] ?? "neutral"}>bot: {botStatus}</ABadge>
                  {bot?.telegram_username && <span className="text-sm text-ink-muted">@{bot.telegram_username}</span>}
                  {bot?.validated_at && (
                    <span className="text-xs text-ink-muted/80">validated {new Date(bot.validated_at).toLocaleDateString()}</span>
                  )}
                </div>
              </div>
              <div className="flex gap-2">
                {!clinic.is_active && (
                  <AButton onClick={() => toggle(clinic.id, true)} loading={busyId === clinic.id}>
                    Activate
                  </AButton>
                )}
                {clinic.is_active && (
                  <AButton variant="danger" onClick={() => toggle(clinic.id, false)} loading={busyId === clinic.id}>
                    Deactivate
                  </AButton>
                )}
              </div>
            </div>
          </Card>
        );
      })}
    </div>
  );
}

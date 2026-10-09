"use client";

import { useEffect, useState } from "react";
import { Card, ABadge } from "@/components/admin/ui";
import { adminApi, AdminApiError } from "@/lib/admin/client";

type Features = { onlineIdentityRequired: boolean; smsEnabled: boolean; smsProvider: string | null; onlinePaymentProvider: string | null };

/** Owner only (the API refuses everyone else; the card then stays hidden). */
export function OnlineFeatures() {
  const [f, setF] = useState<Features | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    adminApi.get<Features>("/api/admin/clinic-features").then(setF, () => setF(null));
  }, []);
  if (!f) return null;

  const save = async (patch: Partial<Pick<Features, "onlineIdentityRequired" | "smsEnabled">>) => {
    setError(null);
    try {
      setF(await adminApi.patch<Features>("/api/admin/clinic-features", patch));
    } catch (e) {
      setError(e instanceof AdminApiError ? e.message : "Saqlab bo‘lmadi");
    }
  };

  return (
    <Card>
      <p className="mb-3 font-display text-sm font-bold">Onlayn xizmatlar</p>
      {error && <p className="mb-2 text-sm text-danger">{error}</p>}
      <label className="mb-3 flex items-start gap-2 text-sm">
        <input type="checkbox" checked={f.onlineIdentityRequired} onChange={(e) => void save({ onlineIdentityRequired: e.target.checked })} />
        <span>
          Mini App orqali yozilishdan oldin pasport/ID va tug‘ilgan sana majburiy
          <span className="block text-xs text-ink-muted">Server tekshiradi: shaxsi tasdiqlanmagan Telegram foydalanuvchisi yozila olmaydi.</span>
        </span>
      </label>
      <label className="mb-3 flex items-start gap-2 text-sm">
        <input type="checkbox" checked={f.smsEnabled} onChange={(e) => void save({ smsEnabled: e.target.checked })} />
        <span>
          Telegrami yo‘q bemorlarga navbat SMS (rozilik bilan)
          <span className="block text-xs text-ink-muted">
            SMS xizmati: {f.smsProvider ? <ABadge tone="green">{f.smsProvider}</ABadge> : <ABadge tone="amber">sozlanmagan — Eskiz shartnomasi va kalitlar kerak</ABadge>}
          </span>
        </span>
      </label>
      <p className="text-sm">
        Onlayn to‘lov:{" "}
        {f.onlinePaymentProvider ? <ABadge tone="green">{f.onlinePaymentProvider}</ABadge> : <ABadge tone="amber">o‘chiq — bemorlar kassada to‘laydi</ABadge>}
      </p>
    </Card>
  );
}

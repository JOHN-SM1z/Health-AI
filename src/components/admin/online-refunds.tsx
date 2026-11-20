"use client";

import { useCallback, useEffect, useState } from "react";
import { Card, ATable, AButton, AInput, ABadge } from "@/components/admin/ui";
import { adminApi, AdminApiError, formatDateTime, formatPrice } from "@/lib/admin/client";

type Refund = { id: string; amount: number; currency: string; reason: string; requestedAt: string; patientName: string | null; phone: string | null };

const REASONS: Record<string, string> = {
  duplicate_payment: "Ikki marta to‘langan",
  slot_unavailable: "Vaqt band bo‘lib qolgan",
  booking_cancelled: "Yozuv bekor qilingan",
};

/**
 * Owner/manager: online payments to return (20261008000012). The money is returned in the payment provider's
 * cabinet; here the provider's refund reference is recorded, and the payment and the visit ledger are updated.
 * Hidden when nothing is waiting, and for every other role (the API refuses them).
 */
export function OnlineRefunds() {
  const [refunds, setRefunds] = useState<Refund[] | null>(null);
  const [refs, setRefs] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setRefunds((await adminApi.get<{ refunds: Refund[] }>("/api/admin/payments/refunds")).refunds);
    } catch {
      setRefunds([]);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const done = async (id: string) => {
    setError(null);
    try {
      await adminApi.post(`/api/admin/payments/refunds/${id}`, { reference: refs[id] ?? "" });
      await load();
    } catch (e) {
      setError(e instanceof AdminApiError ? e.message : "Saqlab bo‘lmadi");
    }
  };

  if (!refunds || refunds.length === 0) return null;
  return (
    <Card>
      <p className="mb-1 font-display text-sm font-bold">Onlayn to‘lovlarni qaytarish</p>
      <p className="mb-3 text-xs text-ink-muted">Pulni to‘lov tizimi kabinetida qaytaring, so‘ng qaytarish raqamini shu yerga yozing.</p>
      {error && <p className="mb-2 text-sm text-danger">{error}</p>}
      <ATable headers={["Bemor", "Sabab", "Summa", "So‘ralgan", "Qaytarish raqami", ""]}>
        {refunds.map((r) => (
          <tr key={r.id}>
            <td className="px-4 py-3">
              <p className="font-medium">{r.patientName ?? "—"}</p>
              <p className="text-xs text-ink-muted">{r.phone ?? ""}</p>
            </td>
            <td className="px-4 py-3">
              <ABadge tone="amber">{REASONS[r.reason] ?? r.reason}</ABadge>
            </td>
            <td className="px-4 py-3 font-numeric">{formatPrice(r.amount)}</td>
            <td className="px-4 py-3 text-xs">{formatDateTime(r.requestedAt)}</td>
            <td className="px-4 py-3">
              <AInput value={refs[r.id] ?? ""} onChange={(v) => setRefs({ ...refs, [r.id]: v })} placeholder="Masalan: RF-123456" aria-label="Qaytarish raqami" />
            </td>
            <td className="px-4 py-3 text-right">
              <AButton size="sm" disabled={(refs[r.id] ?? "").trim().length < 3} onClick={() => done(r.id)}>
                Qaytarildi
              </AButton>
            </td>
          </tr>
        ))}
      </ATable>
    </Card>
  );
}

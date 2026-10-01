"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Banknote } from "lucide-react";
import { PageHeader, Card, ABadge, AEmpty, AError, AButton, AModal, ASelect, LoadingRow } from "@/components/admin/ui";
import { adminApi, AdminApiError, formatDateTime, formatPrice } from "@/lib/admin/client";
import type { KassaOrder } from "@/lib/labs/kassa";

type Filter = "unpaid" | "paid" | "all";
const FILTERS: Array<{ key: Filter; label: string }> = [
  { key: "unpaid", label: "To‘lanmagan" },
  { key: "paid", label: "To‘langan" },
  { key: "all", label: "Hammasi" },
];
const STATUS: Record<string, { label: string; tone: "green" | "amber" | "red" | "gray" }> = {
  paid: { label: "To‘langan", tone: "green" },
  unpaid: { label: "To‘lanmagan", tone: "amber" },
  pending: { label: "Kutilmoqda", tone: "amber" },
  manual_review: { label: "Tekshiruvda", tone: "amber" },
  failed: { label: "Amalga oshmadi", tone: "red" },
  refunded: { label: "Qaytarilgan", tone: "gray" },
};
const METHODS = [
  { value: "cash", label: "Naqd" },
  { value: "card", label: "Karta" },
  { value: "transfer", label: "O‘tkazma" },
];
const REASONS = [
  { value: "patient_request", label: "Bemor so‘rovi" },
  { value: "duplicate_payment", label: "Ikki marta to‘langan" },
  { value: "order_cancelled", label: "Buyurtma bekor qilingan" },
  { value: "other", label: "Boshqa" },
];

/**
 * Laboratory Kassa: the laboratory orders with the status of their payment (the existing payments, not a
 * copy), for the people at the desk. The amount is what the server computed; this screen can only ask to
 * confirm a payment (with how it was paid) or to refund it, and shows the server's answer.
 */
export default function LabKassaPage() {
  const [filter, setFilter] = useState<Filter>("unpaid");
  const [data, setData] = useState<{ orders: KassaOrder[]; can: { confirm: boolean; refund: boolean } } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [acting, setActing] = useState<{ order: KassaOrder; kind: "confirm" | "refund" } | null>(null);
  const [choice, setChoice] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setData(await adminApi.get(`/api/admin/lab/kassa?filter=${filter}`));
      setError(null);
    } catch (e) {
      setError(e instanceof AdminApiError ? e.message : "Kassani yuklab bo‘lmadi");
    }
  }, [filter]);

  useEffect(() => {
    setData(null);
    void load();
  }, [load]);

  const submit = async () => {
    if (!acting || !choice) return;
    setBusy(true);
    setError(null);
    try {
      await adminApi.post(
        `/api/admin/lab/kassa/${acting.order.orderId}/payment`,
        acting.kind === "confirm" ? { action: "confirm", method: choice } : { action: "refund", reason: choice },
      );
      setActing(null);
    } catch (e) {
      setError(e instanceof AdminApiError ? e.message : "Amalni bajarib bo‘lmadi");
      setActing(null);
    } finally {
      setBusy(false);
      await load();
    }
  };

  return (
    <div>
      <PageHeader title="Laboratoriya kassa" subtitle="Tahlil buyurtmalari va ularning to‘lovi" />
      <div className="mb-4 flex flex-wrap gap-2" role="tablist" aria-label="To‘lov holati">
        {FILTERS.map((f) => (
          <AButton key={f.key} size="sm" variant={filter === f.key ? "primary" : "outline"} onClick={() => setFilter(f.key)}>
            {f.label}
          </AButton>
        ))}
      </div>
      {error && <AError message={error} />}
      {data === null ? (
        <Card>
          <LoadingRow />
        </Card>
      ) : data.orders.length === 0 ? (
        <Card>
          <AEmpty title="Buyurtma yo‘q" subtitle="Bu bo‘limda laboratoriya buyurtmalari ko‘rinmaydi" icon={<Banknote className="h-6 w-6" />} />
        </Card>
      ) : (
        <ul className="flex flex-col gap-3">
          {data.orders.map((o) => {
            const s = STATUS[o.payment.status] ?? { label: o.payment.status, tone: "gray" as const };
            const cancelled = o.orderStatus === "cancelled";
            return (
              <li key={o.orderId}>
                <Card>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <p className="text-sm font-bold text-foreground">{o.patient.fullName ?? "—"}</p>
                      <p className="text-xs text-ink-muted">{formatDateTime(o.createdAt)}{cancelled ? " · buyurtma bekor qilingan" : ""}</p>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="font-numeric text-sm font-bold text-foreground">{formatPrice(o.payment.amount)}</span>
                      <ABadge tone={s.tone}>{s.label}</ABadge>
                    </div>
                  </div>
                  <p className="mt-2 text-sm text-ink-muted">{o.items.map((i) => i.name).join(", ")}</p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {data.can.confirm && !cancelled && ["unpaid", "pending", "manual_review"].includes(o.payment.status) && (
                      <AButton size="sm" onClick={() => { setChoice("cash"); setActing({ order: o, kind: "confirm" }); }}>
                        To‘lovni qabul qilish
                      </AButton>
                    )}
                    {data.can.refund && o.payment.status === "paid" && (
                      <AButton size="sm" variant="outline" onClick={() => { setChoice("patient_request"); setActing({ order: o, kind: "refund" }); }}>
                        Qaytarish
                      </AButton>
                    )}
                    {(o.payment.status === "paid" || o.payment.status === "refunded") && (
                      <Link href={`/admin/lab-kassa/receipt/${o.orderId}`} target="_blank" className="inline-flex items-center rounded-lg border border-hairline px-3 py-1.5 text-sm font-medium text-foreground hover:bg-sand">
                        Hujjat
                      </Link>
                    )}
                  </div>
                </Card>
              </li>
            );
          })}
        </ul>
      )}

      {acting && (
        <AModal
          title={acting.kind === "confirm" ? "To‘lovni qabul qilish" : "To‘lovni qaytarish"}
          onClose={() => setActing(null)}
          footer={
            <>
              <AButton variant="ghost" onClick={() => setActing(null)} disabled={busy}>
                Bekor qilish
              </AButton>
              <AButton loading={busy} onClick={() => void submit()}>
                {acting.kind === "confirm" ? "Tasdiqlash" : "Qaytarish"}
              </AButton>
            </>
          }
        >
          <p className="mb-1 text-sm text-foreground">{acting.order.patient.fullName ?? "—"}</p>
          <p className="mb-3 font-numeric text-lg font-bold text-foreground">{formatPrice(acting.order.payment.amount)}</p>
          <p className="mb-1 text-xs font-medium text-ink-muted">{acting.kind === "confirm" ? "To‘lov usuli" : "Qaytarish sababi"}</p>
          <ASelect value={choice} onChange={setChoice} options={acting.kind === "confirm" ? METHODS : REASONS} aria-label={acting.kind === "confirm" ? "To‘lov usuli" : "Qaytarish sababi"} />
          {acting.kind === "confirm" && <p className="mt-3 text-xs text-ink-muted">Summa tizim tomonidan tahlil narxlaridan hisoblangan; uni o‘zgartirib bo‘lmaydi.</p>}
        </AModal>
      )}
    </div>
  );
}

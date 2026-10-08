"use client";

import { useEffect, useState } from "react";
import { PageHeader, Card, ABadge, ATable, AEmpty, AError, AButton, AModal, ASelect } from "@/components/admin/ui";
import { adminApi, AdminApiError, formatDateTime, formatPrice } from "@/lib/admin/client";
import { Receipt } from "lucide-react";

/**
 * Lab orders at the Kassa (Phase 6): each lab order's bill from the existing
 * payment engine. Staff record a desk payment (cash / card terminal), a
 * refund, or a review — the amount always comes from the order's stored
 * prices, never from this screen. Test names and work status only; result
 * values never appear here.
 */

type Row = {
  orderId: string;
  paymentId: string;
  createdAt: string;
  patientName: string | null;
  orderStatus: string;
  tests: Array<{ name: string; status: string }>;
  amount: number;
  currency: string;
  paymentStatus: string;
  method: string | null;
  paidAt: string | null;
};

const PAYMENT: Record<string, { label: string; tone: "amber" | "green" | "gray" | "red" | "purple" | "neutral" }> = {
  unpaid: { label: "To‘lanmagan", tone: "amber" },
  pending: { label: "Kutilmoqda", tone: "purple" },
  paid: { label: "To‘langan", tone: "green" },
  failed: { label: "Muvaffaqiyatsiz", tone: "red" },
  refunded: { label: "Qaytarilgan", tone: "gray" },
  manual_review: { label: "Tekshiruvda", tone: "neutral" },
};
const METHOD: Record<string, string> = { cash: "naqd", card_terminal: "karta" };

export default function LabKassaPage() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [filter, setFilter] = useState<"open" | "all">("open");
  const [error, setError] = useState<string | null>(null);
  const [paying, setPaying] = useState<Row | null>(null);
  const [refunding, setRefunding] = useState<Row | null>(null);

  const load = async (f = filter) => {
    try {
      const res = await adminApi.get<{ payments: Row[] }>(`/api/admin/lab/payments?filter=${f}`);
      setRows(res.payments);
    } catch (e) {
      setError(e instanceof AdminApiError ? e.message : "To‘lovlarni yuklab bo‘lmadi");
    }
  };

  useEffect(() => {
    void load(filter);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reload when the filter changes
  }, [filter]);

  const change = async (row: Row, body: { status: string; method?: string }) => {
    setError(null);
    try {
      await adminApi.post(`/api/admin/lab/orders/${row.orderId}/payment`, body);
      setPaying(null);
      setRefunding(null);
      await load();
    } catch (e) {
      setError(e instanceof AdminApiError ? e.message : "To‘lovni saqlab bo‘lmadi");
    }
  };

  return (
    <div>
      <PageHeader title="Laboratoriya kassasi" subtitle="Tahlil buyurtmalari to‘lovlari — summa buyurtmadagi narxlardan olinadi. Qabulxonada ro‘yxatga olingan tashrif tahlillari asosiy kassada to‘lanadi." />
      <div className="mb-4 max-w-xs">
        <ASelect
          value={filter}
          onChange={(v) => setFilter(v as "open" | "all")}
          options={[
            { value: "open", label: "To‘lanmaganlar" },
            { value: "all", label: "Barchasi" },
          ]}
          aria-label="Saralash"
        />
      </div>
      {error && <AError message={error} />}
      {rows === null ? (
        <Card><div className="h-2 w-full animate-pulse rounded bg-hairline" /></Card>
      ) : rows.length === 0 ? (
        <Card><AEmpty title={filter === "open" ? "To‘lanmagan buyurtma yo‘q" : "Laboratoriya to‘lovlari yo‘q"} icon={<Receipt className="h-6 w-6" />} /></Card>
      ) : (
        <ATable headers={["Sana", "Bemor", "Tahlillar", "Summa", "To‘lov", "Amallar"]}>
          {rows.map((r) => {
            const status = PAYMENT[r.paymentStatus] ?? { label: r.paymentStatus, tone: "neutral" as const };
            const refundDue = r.paymentStatus === "paid" && r.orderStatus === "cancelled";
            return (
              <tr key={r.paymentId} className="hover:bg-sand">
                <td className="px-4 py-3 text-xs text-ink-muted">{formatDateTime(r.createdAt)}</td>
                <td className="px-4 py-3 font-medium text-foreground">{r.patientName ?? "—"}</td>
                <td className="px-4 py-3 text-xs text-foreground">
                  {r.tests.map((t) => (
                    <span key={t.name} className={t.status === "cancelled" ? "text-ink-muted line-through" : ""}>
                      {t.name}
                      <br />
                    </span>
                  ))}
                  {r.orderStatus === "cancelled" && <span className="text-ink-muted">Buyurtma bekor qilingan</span>}
                </td>
                <td className="font-numeric px-4 py-3 font-semibold text-foreground">{formatPrice(r.amount)}</td>
                <td className="px-4 py-3">
                  <ABadge tone={status.tone}>{status.label}</ABadge>
                  {r.paymentStatus === "paid" && r.method && <span className="ml-1 text-xs text-ink-muted">({METHOD[r.method] ?? r.method})</span>}
                  {refundDue && <p className="mt-1 text-xs text-danger">Qaytarish kerak</p>}
                </td>
                <td className="px-4 py-3">
                  <div className="flex flex-wrap gap-1">
                    {["unpaid", "failed", "manual_review"].includes(r.paymentStatus) && r.orderStatus !== "cancelled" && r.amount > 0 && (
                      <AButton size="sm" onClick={() => setPaying(r)}>To‘lovni qabul qilish</AButton>
                    )}
                    {r.paymentStatus === "paid" && (
                      <AButton size="sm" variant="outline" onClick={() => setRefunding(r)}>Qaytarish</AButton>
                    )}
                  </div>
                </td>
              </tr>
            );
          })}
        </ATable>
      )}

      {paying && (
        <AModal
          title="To‘lovni qabul qilish"
          onClose={() => setPaying(null)}
          footer={<AButton variant="ghost" onClick={() => setPaying(null)}>Bekor qilish</AButton>}
        >
          <p className="text-sm text-foreground">
            {paying.patientName ?? "—"} — <span className="font-semibold">{formatPrice(paying.amount)}</span>
          </p>
          <div className="flex gap-2">
            <AButton onClick={() => void change(paying, { status: "paid", method: "cash" })}>Naqd</AButton>
            <AButton onClick={() => void change(paying, { status: "paid", method: "card_terminal" })}>Karta (terminal)</AButton>
          </div>
        </AModal>
      )}
      {refunding && (
        <AModal
          title="To‘lovni qaytarish"
          onClose={() => setRefunding(null)}
          footer={
            <>
              <AButton variant="ghost" onClick={() => setRefunding(null)}>Bekor qilish</AButton>
              <AButton variant="danger" onClick={() => void change(refunding, { status: "refunded" })}>Qaytarishni tasdiqlash</AButton>
            </>
          }
        >
          <p className="text-sm text-foreground">
            {refunding.patientName ?? "—"} uchun {formatPrice(refunding.amount)} to‘liq qaytariladi. Qisman qaytarish hozircha mavjud emas.
          </p>
        </AModal>
      )}
    </div>
  );
}

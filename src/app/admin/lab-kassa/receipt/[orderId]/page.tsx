"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { AError, LoadingRow } from "@/components/admin/ui";
import { adminApi, AdminApiError, formatDateTime, formatPrice } from "@/lib/admin/client";
import type { LabReceipt } from "@/lib/labs/kassa";

const METHOD_LABELS: Record<string, string> = { cash: "Naqd", card: "Karta", transfer: "O‘tkazma" };

/** A printable payment confirmation. NOT a fiscal receipt — it says so on its face (the server supplies the wording). */
export default function LabReceiptPage() {
  const { orderId } = useParams<{ orderId: string }>();
  const [receipt, setReceipt] = useState<LabReceipt | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    adminApi
      .get<{ receipt: LabReceipt }>(`/api/admin/lab/kassa/${orderId}/receipt`)
      .then((r) => setReceipt(r.receipt))
      .catch((e) => setError(e instanceof AdminApiError ? e.message : "Hujjatni yuklab bo‘lmadi"));
  }, [orderId]);

  if (error) return <AError message={error} />;
  if (!receipt) return <LoadingRow />;

  return (
    <article className="mx-auto max-w-md rounded-xl border border-hairline bg-surface p-6 text-sm print:border-0 print:shadow-none" aria-label="To‘lov tasdig‘i">
      <header className="mb-4 border-b border-hairline pb-3">
        <p className="font-display text-lg font-bold text-foreground">{receipt.clinic.name}</p>
        <p className="text-xs text-ink-muted">To‘lovni tasdiqlovchi hujjat № {receipt.number}</p>
        {receipt.refunded && <p className="mt-1 font-bold text-danger">QAYTARILGAN</p>}
      </header>
      <dl className="mb-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
        <dt className="text-ink-muted">Bemor</dt>
        <dd className="text-right font-medium text-foreground">{receipt.patient.fullName ?? "—"}</dd>
        <dt className="text-ink-muted">Buyurtma sanasi</dt>
        <dd className="text-right">{receipt.orderedAt ? formatDateTime(receipt.orderedAt) : "—"}</dd>
        <dt className="text-ink-muted">To‘langan</dt>
        <dd className="text-right">{receipt.paidAt ? formatDateTime(receipt.paidAt) : "—"}</dd>
        <dt className="text-ink-muted">Usul</dt>
        <dd className="text-right">{receipt.method ? METHOD_LABELS[receipt.method] ?? receipt.method : "—"}</dd>
      </dl>
      <ul className="divide-y divide-hairline/70 border-y border-hairline">
        {receipt.items.map((i) => (
          <li key={i.code} className="flex justify-between py-1.5">
            <span>{i.name}</span>
            <span className="font-numeric text-ink-muted">{formatPrice(i.price)}</span>
          </li>
        ))}
      </ul>
      {receipt.items.reduce((sum, i) => sum + i.price, 0) !== receipt.amount && (
        <p className="mt-2 text-xs text-ink-muted">Paket narxi qo‘llangan: jami alohida narxlar yig‘indisidan farq qilishi mumkin.</p>
      )}
      <p className="mt-3 flex justify-between text-base font-bold text-foreground">
        <span>Jami</span>
        <span className="font-numeric">{formatPrice(receipt.amount)}</span>
      </p>
      <p className="mt-4 text-xs text-ink-muted">{receipt.disclaimer}</p>
      <button type="button" onClick={() => window.print()} className="mt-4 rounded-lg border border-hairline px-3 py-1.5 text-sm font-medium text-foreground hover:bg-sand print:hidden">
        Chop etish
      </button>
    </article>
  );
}

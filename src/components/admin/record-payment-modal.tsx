"use client";

import { useState } from "react";
import { Banknote, CreditCard } from "lucide-react";
import { AModal, AButton, AError } from "@/components/admin/ui";
import { adminApi, AdminApiError, formatPrice } from "@/lib/admin/client";

type Provider = "cash" | "card_terminal";

/**
 * Records that a payment was actually collected. Before this, a payment row
 * existed and its status could be read everywhere, but nothing in the UI
 * could ever mark one paid or say how it was collected — so the payment-
 * method breakdown on the owner dashboard and Moliya page could never show
 * anything but the booking-time default ("manual"), and a receptionist
 * taking cash at the desk had no way to record it at all.
 *
 * Only asks for the collection method (cash vs. card terminal) — the two
 * things a person actually chooses between at the front desk. Refunding a
 * payment is a separate, owner/admin-only action and is not built here.
 */
export function RecordPaymentModal({
  appointmentId,
  patientName,
  amount,
  onClose,
  onRecorded,
}: {
  appointmentId: string;
  patientName: string;
  amount: number | null | undefined;
  onClose: () => void;
  onRecorded: () => void;
}) {
  const [provider, setProvider] = useState<Provider | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const confirm = async () => {
    if (!provider) return;
    setBusy(true);
    setError(null);
    try {
      await adminApi.post(`/api/admin/appointments/${appointmentId}/payment`, { status: "paid", provider });
      onRecorded();
    } catch (e) {
      setError(e instanceof AdminApiError ? e.message : "To‘lovni qayd etishda xatolik");
      setBusy(false);
    }
  };

  return (
    <AModal
      title="To‘lovni qayd etish"
      onClose={onClose}
      maxWidth="max-w-sm"
      footer={
        <>
          <AButton variant="ghost" size="md" onClick={onClose} disabled={busy}>
            Bekor qilish
          </AButton>
          <AButton size="md" loading={busy} disabled={!provider} onClick={() => void confirm()}>
            To‘landi deb belgilash
          </AButton>
        </>
      }
    >
      {error && <AError message={error} />}
      <p className="mb-3 text-sm text-ink-muted">
        {patientName}
        {amount != null ? ` — ${formatPrice(amount)}` : ""}
      </p>
      <p className="mb-2 text-xs font-medium text-ink-muted">To‘lov qanday qabul qilindi?</p>
      <div className="grid grid-cols-2 gap-2">
        <button
          type="button"
          onClick={() => setProvider("cash")}
          className={`flex items-center justify-center gap-2 rounded-lg border px-3 py-2.5 text-sm font-medium transition-colors ${
            provider === "cash" ? "border-pine bg-pine text-white" : "border-hairline bg-surface text-foreground hover:bg-sand"
          }`}
        >
          <Banknote className="h-4 w-4" />
          Naqd
        </button>
        <button
          type="button"
          onClick={() => setProvider("card_terminal")}
          className={`flex items-center justify-center gap-2 rounded-lg border px-3 py-2.5 text-sm font-medium transition-colors ${
            provider === "card_terminal" ? "border-pine bg-pine text-white" : "border-hairline bg-surface text-foreground hover:bg-sand"
          }`}
        >
          <CreditCard className="h-4 w-4" />
          Karta
        </button>
      </div>
    </AModal>
  );
}

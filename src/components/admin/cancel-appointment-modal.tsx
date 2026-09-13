"use client";

import { useState } from "react";
import { AModal, AButton, ATextArea, AError } from "@/components/admin/ui";
import { adminApi, AdminApiError } from "@/lib/admin/client";

/**
 * Compact reason-capturing cancel flow — mirrors the pattern already used on
 * /admin/appointments, so cancellations keep feeding real reasons into
 * cancel_reasons (analytics, owner alerts) instead of a generic default.
 */
export function CancelAppointmentModal({
  appointmentId,
  patientName,
  onClose,
  onCancelled,
}: {
  appointmentId: string;
  patientName: string;
  onClose: () => void;
  onCancelled: () => void;
}) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      await adminApi.patch(`/api/admin/appointments/${appointmentId}`, { action: "cancel", reason: reason.trim() || undefined });
      onCancelled();
    } catch (e) {
      setError(e instanceof AdminApiError ? e.message : "Bekor qilishda xatolik");
      setBusy(false);
    }
  };

  return (
    <AModal
      title="Qabulni bekor qilish"
      onClose={onClose}
      footer={
        <>
          <AButton variant="ghost" size="md" onClick={onClose} disabled={busy}>
            Yopish
          </AButton>
          <AButton variant="danger" size="md" loading={busy} onClick={() => void confirm()}>
            Bekor qilish
          </AButton>
        </>
      }
    >
      {error && <AError message={error} />}
      <p className="mb-2 text-sm text-ink-muted">{patientName} uchun qabulni bekor qilasizmi?</p>
      <ATextArea value={reason} onChange={setReason} placeholder="Sabab (ixtiyoriy)" rows={3} />
    </AModal>
  );
}

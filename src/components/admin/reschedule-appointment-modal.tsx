"use client";

import { useState } from "react";
import { AModal, AButton, AError } from "@/components/admin/ui";
import { adminApi, AdminApiError, formatDateTime } from "@/lib/admin/client";
import { SlotPicker, type Slot } from "@/components/admin/slot-picker";

/**
 * Inline reschedule — only changes when the same doctor+service happens,
 * using the transactional reschedule RPC (via the existing PATCH
 * action:"reschedule"). Reuses SlotPicker so a receptionist handling a new
 * Telegram booking request never has to leave the dashboard to change its
 * time.
 */
export function RescheduleAppointmentModal({
  appointmentId,
  patientName,
  serviceId,
  doctorId,
  currentStartAt,
  onClose,
  onRescheduled,
}: {
  appointmentId: string;
  patientName: string;
  serviceId: string;
  doctorId: string;
  currentStartAt: string;
  onClose: () => void;
  onRescheduled: () => void;
}) {
  const [selectedSlot, setSelectedSlot] = useState<Slot | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const confirm = async () => {
    if (!selectedSlot) return;
    setBusy(true);
    setError(null);
    try {
      await adminApi.patch(`/api/admin/appointments/${appointmentId}`, { action: "reschedule", newStartAt: selectedSlot.start });
      onRescheduled();
    } catch (e) {
      setError(e instanceof AdminApiError ? e.message : "Vaqtni o‘zgartirishda xatolik");
      setBusy(false);
    }
  };

  return (
    <AModal
      title="Qabul vaqtini o‘zgartirish"
      onClose={onClose}
      footer={
        <>
          <AButton variant="ghost" size="md" onClick={onClose} disabled={busy}>
            Bekor qilish
          </AButton>
          <AButton size="md" loading={busy} disabled={!selectedSlot} onClick={() => void confirm()}>
            Saqlash
          </AButton>
        </>
      }
    >
      {error && <AError message={error} />}
      <p className="mb-3 text-sm text-ink-muted">
        {patientName} — hozirgi vaqt: {formatDateTime(currentStartAt)}
      </p>
      <SlotPicker serviceId={serviceId} doctorId={doctorId} selectedSlot={selectedSlot} onSelect={setSelectedSlot} />
    </AModal>
  );
}

"use client";

import { useEffect, useState } from "react";
import type { Database } from "@/lib/supabase/database.types";
import { createClient } from "@/lib/supabase/browser";
import { AModal, AButton, AError, ABadge, LoadingRow } from "@/components/admin/ui";
import { adminApi, AdminApiError, formatDateTime, formatPrice, STATUS_LABELS, STATUS_TONES } from "@/lib/admin/client";
import { nextConsultationStep } from "@/lib/doctor/consultation-flow";

type AppointmentStatus = Database["public"]["Enums"]["appointment_status"];

export type ConsultationAppointment = {
  id: string;
  start_at: string;
  status: AppointmentStatus;
  notes: string | null;
  cancelled_reason?: string | null;
  no_show_reason?: string | null;
  patients: { id: string; full_name: string | null; phone: string | null } | null;
  services: { name: string; price: number } | null;
};

type PriorVisit = { id: string; start_at: string; services: { name: string } | null };

/**
 * Shared focused view for both "Qabulni boshlash" (from the next-patient
 * card) and clicking any row in today's timeline or appointment history —
 * one component instead of a separate detail page, so opening it never
 * navigates the doctor away from the dashboard. Only shows fields the
 * backend actually has: there is no diagnosis/prescription/clinical-notes
 * table in this schema (see AGENTS.md — this product does not implement
 * clinical records), so this is patient context + status progression, not
 * an EMR form.
 */
export function ConsultationModal({
  appointment,
  doctorId,
  onClose,
  onStatusChanged,
}: {
  appointment: ConsultationAppointment;
  doctorId: string;
  onClose: () => void;
  onStatusChanged: () => void;
}) {
  const [status, setStatus] = useState(appointment.status);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [priorVisits, setPriorVisits] = useState<PriorVisit[] | null>(null);

  const patient = appointment.patients;

  useEffect(() => {
    let cancelled = false;
    if (!patient?.id) {
      setPriorVisits([]);
      return;
    }
    const supabase = createClient();
    void supabase
      .from("appointments")
      .select("id, start_at, services(name)")
      .eq("patient_id", patient.id)
      .eq("doctor_id", doctorId)
      .eq("status", "completed")
      .neq("id", appointment.id)
      .order("start_at", { ascending: false })
      .limit(3)
      .then(({ data }) => {
        if (!cancelled) setPriorVisits((data as PriorVisit[] | null) ?? []);
      });
    return () => {
      cancelled = true;
    };
    // patient?.id / doctorId / appointment.id are all fixed for the lifetime
    // of one open modal instance (a new appointment means a new mount).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const advance = async () => {
    const next = nextConsultationStep(status);
    if (!next) return;
    setBusy(true);
    setError(null);
    try {
      await adminApi.patch(`/api/doctor/appointments/${appointment.id}`, { status: next.status });
      setStatus(next.status);
      onStatusChanged();
      if (next.status === "completed") onClose();
    } catch (e) {
      setError(e instanceof AdminApiError ? e.message : "Holatni yangilab bo‘lmadi");
    } finally {
      setBusy(false);
    }
  };

  const next = nextConsultationStep(status);

  return (
    <AModal
      title={patient?.full_name ?? "Bemor"}
      onClose={onClose}
      maxWidth="max-w-md"
      footer={
        next ? (
          <AButton loading={busy} onClick={() => void advance()}>
            {next.label}
          </AButton>
        ) : (
          <AButton variant="outline" onClick={onClose}>
            Yopish
          </AButton>
        )
      }
    >
      {error && <AError message={error} />}

      <div className="flex items-center justify-between">
        <p className="text-sm text-ink-muted">
          {formatDateTime(appointment.start_at)} · {appointment.services?.name ?? "—"}
          {appointment.services?.price != null && ` · ${formatPrice(appointment.services.price)}`}
        </p>
        <ABadge tone={STATUS_TONES[status] ?? "neutral"}>{STATUS_LABELS[status] ?? status}</ABadge>
      </div>

      {patient?.phone && <p className="text-sm text-ink-muted">{patient.phone}</p>}

      <div>
        <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-muted">Tashrif sababi</p>
        <p className="text-sm text-foreground">
          {appointment.notes?.trim() || "Ko‘rsatilmagan"}
        </p>
      </div>

      {(appointment.cancelled_reason || appointment.no_show_reason) && (
        <div>
          <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-muted">
            {appointment.cancelled_reason ? "Bekor qilish sababi" : "Kelmagandi sababi"}
          </p>
          <p className="text-sm text-foreground">{appointment.cancelled_reason || appointment.no_show_reason}</p>
        </div>
      )}

      <div>
        <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-muted">Oldingi tashriflar</p>
        {priorVisits === null ? (
          <LoadingRow />
        ) : priorVisits.length === 0 ? (
          <p className="text-sm text-ink-muted">Bu — ushbu shifokordagi birinchi tashrif</p>
        ) : (
          <ul className="space-y-1">
            {priorVisits.map((v) => (
              <li key={v.id} className="text-sm text-foreground">
                {formatDateTime(v.start_at)} — {v.services?.name ?? "—"}
              </li>
            ))}
          </ul>
        )}
      </div>
    </AModal>
  );
}

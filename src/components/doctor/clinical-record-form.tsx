"use client";

import { useRef, useState } from "react";
import { AButton, AError, AInput, ASelect, ATextArea } from "@/components/admin/ui";
import { adminApi, AdminApiError } from "@/lib/admin/client";
import { WRITABLE_RECORD_TYPES } from "@/lib/clinical-records/categories";
import { newIdempotencyKey } from "@/lib/idempotency-key";

/** The current version of one of the doctor's own records, being corrected. */
export type RecordDraft = {
  recordId: string;
  rootRecordId: string;
  version: number;
  type: string;
  summary: string;
  details: string | null;
  code: string | null;
};

const TYPES = WRITABLE_RECORD_TYPES.map(({ value, label }) => ({ value, label }));
const SUMMARY_HINTS: Record<string, string> = Object.fromEntries(WRITABLE_RECORD_TYPES.map((t) => [t.value, t.hint]));

/**
 * Adds a record to the doctor's own consultation, or corrects one of their
 * own records: edit and save — the server saves the correction as the
 * record's next version and keeps the earlier one in its history, so no
 * reason is asked for. The server sets the author, time and provenance and
 * checks the consultation and the record are the doctor's own; this form
 * only sends text.
 */
export function ClinicalRecordForm({
  patientId,
  appointmentId,
  correcting,
  onSaved,
  onCancel,
  onConflict,
}: {
  patientId: string;
  appointmentId: string;
  correcting?: RecordDraft | null;
  onSaved: () => void;
  onCancel?: () => void;
  /**
   * The record changed since it was opened: nothing was saved. The parent
   * shows the latest version and hands this form its new version; the
   * doctor's text stays here to review and save again.
   */
  onConflict?: (rootRecordId: string) => void;
}) {
  const [type, setType] = useState(correcting?.type ?? "assessment");
  const [summary, setSummary] = useState(correcting?.summary ?? "");
  const [details, setDetails] = useState(correcting?.details ?? "");
  const [code, setCode] = useState(correcting?.code ?? "");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // One key per record being written: a retry after a lost response can't
  // save it twice; a new key once it is saved.
  const [key, setKey] = useState(newIdempotencyKey);
  const inFlight = useRef(false);

  const save = async () => {
    if (!summary.trim() || inFlight.current) return;
    inFlight.current = true;
    setSaving(true);
    setError(null);
    try {
      const text = {
        idempotencyKey: key,
        summary: summary.trim(),
        details: details.trim() || undefined,
        code: type === "diagnosis" && code.trim() ? code.trim() : undefined,
      };
      if (correcting) {
        await adminApi.post(`/api/doctor/patients/${patientId}/records/${correcting.recordId}/corrections`, {
          ...text,
          expectedVersion: correcting.version,
        });
      } else {
        await adminApi.post(`/api/doctor/patients/${patientId}/records`, { ...text, appointmentId, recordType: type });
      }
      setSummary("");
      setDetails("");
      setCode("");
      setKey(newIdempotencyKey());
      onSaved();
    } catch (e) {
      if (correcting && e instanceof AdminApiError && e.code === "VERSION_CONFLICT") {
        setError(
          "Tahriringiz saqlanmadi: bu yozuv siz ochganingizdan keyin yangilangan. Oxirgi versiya ro‘yxatda ko‘rsatildi, matningiz shu yerda qoldi — tekshirib, qayta saqlang.",
        );
        onConflict?.(correcting.rootRecordId);
      } else {
        setError(e instanceof AdminApiError ? e.message : "Yozuvni saqlab bo‘lmadi");
      }
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-3" aria-label={correcting ? "Yozuvni tahrirlash" : "Yangi yozuv"}>
      {error && <AError message={error} />}
      {correcting ? (
        <p className="text-xs text-ink-muted">Saqlanganda yangi versiya bo‘ladi; oldingi matn yozuv tarixida qoladi.</p>
      ) : (
        <div>
          <p className="mb-1 text-xs font-medium text-ink-muted">Yozuv turi</p>
          <ASelect value={type} onChange={setType} options={TYPES} aria-label="Yozuv turi" />
        </div>
      )}
      <div>
        <p className="mb-1 text-xs font-medium text-ink-muted">{SUMMARY_HINTS[type] ?? "Qisqacha mazmun"}</p>
        <AInput value={summary} onChange={setSummary} aria-label="Qisqacha mazmun" placeholder={SUMMARY_HINTS[type]} />
      </div>
      {type === "diagnosis" && (
        <div>
          <p className="mb-1 text-xs font-medium text-ink-muted">Kod (ixtiyoriy, masalan XKT-10)</p>
          <AInput value={code} onChange={setCode} aria-label="Kod" placeholder="I10" />
        </div>
      )}
      <div>
        <p className="mb-1 text-xs font-medium text-ink-muted">Batafsil (ixtiyoriy)</p>
        <ATextArea value={details} onChange={setDetails} rows={3} aria-label="Batafsil" />
      </div>
      <div className="flex gap-2">
        <AButton loading={saving} disabled={!summary.trim()} onClick={() => void save()}>
          {correcting ? "Saqlash" : "Yozuvni saqlash"}
        </AButton>
        {onCancel && (
          <AButton variant="ghost" onClick={onCancel} disabled={saving}>
            Bekor qilish
          </AButton>
        )}
      </div>
    </div>
  );
}

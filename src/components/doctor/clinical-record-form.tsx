"use client";

import { useRef, useState } from "react";
import { AButton, AError, AInput, ASelect, ATextArea } from "@/components/admin/ui";
import { adminApi, AdminApiError } from "@/lib/admin/client";
import { WRITABLE_RECORD_TYPES } from "@/lib/clinical-records/categories";
import { newIdempotencyKey } from "@/lib/idempotency-key";

export type RecordDraft = { recordId: string; type: string; summary: string; details: string | null; code: string | null };

const TYPES = WRITABLE_RECORD_TYPES.map(({ value, label }) => ({ value, label }));
const SUMMARY_HINTS: Record<string, string> = Object.fromEntries(WRITABLE_RECORD_TYPES.map((t) => [t.value, t.hint]));

/**
 * Adds a record to the doctor's own consultation (or corrects one of their
 * own records). The server sets the author, time and provenance and checks
 * the consultation is theirs with this patient; this form only sends text.
 */
export function ClinicalRecordForm({
  patientId,
  appointmentId,
  correcting,
  onSaved,
  onCancel,
}: {
  patientId: string;
  appointmentId: string;
  correcting?: RecordDraft | null;
  onSaved: () => void;
  onCancel?: () => void;
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
      await adminApi.post(`/api/doctor/patients/${patientId}/records`, {
        idempotencyKey: key,
        appointmentId,
        recordType: type,
        summary: summary.trim(),
        details: details.trim() || undefined,
        code: type === "diagnosis" && code.trim() ? code.trim() : undefined,
        correctsRecordId: correcting?.recordId,
      });
      setSummary("");
      setDetails("");
      setCode("");
      setKey(newIdempotencyKey());
      onSaved();
    } catch (e) {
      setError(e instanceof AdminApiError ? e.message : "Yozuvni saqlab bo‘lmadi");
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-3" aria-label={correcting ? "Yozuvni tuzatish" : "Yangi yozuv"}>
      {error && <AError message={error} />}
      {correcting ? (
        <p className="text-xs text-ink-muted">
          Asl yozuv o‘zgarmaydi: tuzatish yangi yozuv sifatida saqlanadi va asl yozuv “Tuzatilgan” deb belgilanadi.
        </p>
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
          {correcting ? "Tuzatishni saqlash" : "Yozuvni saqlash"}
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

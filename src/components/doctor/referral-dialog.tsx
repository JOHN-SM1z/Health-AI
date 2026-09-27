"use client";

import { useEffect, useState } from "react";
import { AButton, AError, AModal, ASelect, ATextArea, LoadingRow } from "@/components/admin/ui";
import { adminApi, AdminApiError, REFERRAL_PRIORITY_LABELS } from "@/lib/admin/client";

type Recipient = { id: string; name: string; title: string | null; specialty: string | null };

const VALIDITY_OPTIONS = [
  { value: "30", label: "30 kun" },
  { value: "60", label: "60 kun" },
  { value: "90", label: "90 kun" },
  { value: "180", label: "180 kun" },
];

/** Refers the patient of one of the doctor's own consultations to a colleague. */
export function ReferralDialog({
  appointmentId,
  patientName,
  onClose,
  onCreated,
}: {
  appointmentId: string;
  patientName: string;
  onClose: () => void;
  onCreated: (referralId: string) => void;
}) {
  const [recipients, setRecipients] = useState<Recipient[] | null>(null);
  const [doctorId, setDoctorId] = useState("");
  const [priority, setPriority] = useState<"routine" | "urgent">("routine");
  const [validForDays, setValidForDays] = useState("90");
  const [reason, setReason] = useState("");
  const [handoffNote, setHandoffNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    adminApi
      .get<{ doctors: Recipient[] }>("/api/doctor/referrals/recipients")
      .then((res) => setRecipients(res.doctors))
      .catch((e) => {
        setRecipients([]);
        setError(e instanceof AdminApiError ? e.message : "Shifokorlarni yuklab bo‘lmadi");
      });
  }, []);

  const canSubmit = !!doctorId && reason.trim().length >= 3;

  const submit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await adminApi.post<{ referral: { id: string } }>("/api/doctor/referrals", {
        appointmentId,
        referredToDoctorId: doctorId,
        reason: reason.trim(),
        handoffNote: handoffNote.trim() || undefined,
        priority,
        validForDays: Number(validForDays),
      });
      onCreated(res.referral.id);
    } catch (e) {
      setError(e instanceof AdminApiError ? e.message : "Yo‘llanmani yuborib bo‘lmadi");
      setSubmitting(false);
    }
  };

  const doctorLabel = (d: Recipient) => [d.name, d.specialty ?? d.title].filter(Boolean).join(" — ");

  return (
    <AModal
      title="Yo‘llanma berish"
      onClose={onClose}
      footer={
        <>
          <AButton variant="ghost" onClick={onClose} disabled={submitting}>
            Bekor qilish
          </AButton>
          <AButton loading={submitting} disabled={!canSubmit} onClick={() => void submit()}>
            Yo‘llanma yuborish
          </AButton>
        </>
      }
    >
      {error && <AError message={error} />}
      <p className="text-sm text-ink-muted">
        Bemor: <span className="font-medium text-foreground">{patientName}</span>
      </p>
      {recipients === null ? (
        <LoadingRow />
      ) : recipients.length === 0 ? (
        <p className="text-sm text-ink-muted">Yo‘llanma berish mumkin bo‘lgan shifokor topilmadi.</p>
      ) : (
        <div className="flex flex-col gap-3">
          <div>
            <p className="mb-1 text-xs font-medium text-ink-muted">Qabul qiluvchi shifokor</p>
            <ASelect
              value={doctorId}
              onChange={setDoctorId}
              options={[{ value: "", label: "Shifokorni tanlang" }, ...recipients.map((d) => ({ value: d.id, label: doctorLabel(d) }))]}
              aria-label="Qabul qiluvchi shifokor"
            />
          </div>
          <div>
            <p className="mb-1 text-xs font-medium text-ink-muted">Muhimlik</p>
            <div className="flex gap-2">
              {(["routine", "urgent"] as const).map((p) => (
                <AButton key={p} size="sm" variant={priority === p ? "primary" : "outline"} onClick={() => setPriority(p)}>
                  {REFERRAL_PRIORITY_LABELS[p]}
                </AButton>
              ))}
            </div>
          </div>
          <div>
            <p className="mb-1 text-xs font-medium text-ink-muted">Yo‘llanma sababi</p>
            <ATextArea value={reason} onChange={setReason} rows={3} aria-label="Yo‘llanma sababi" placeholder="Nima uchun yo‘llanmoqda" />
          </div>
          <div>
            <p className="mb-1 text-xs font-medium text-ink-muted">Shifokor uchun izoh (ixtiyoriy)</p>
            <ATextArea
              value={handoffNote}
              onChange={setHandoffNote}
              rows={3}
              aria-label="Shifokor uchun izoh"
              placeholder="Tekshiruv natijalari, e’tibor berish kerak bo‘lgan jihatlar"
            />
          </div>
          <div>
            <p className="mb-1 text-xs font-medium text-ink-muted">Amal qilish muddati</p>
            <ASelect value={validForDays} onChange={setValidForDays} options={VALIDITY_OPTIONS} aria-label="Amal qilish muddati" />
          </div>
          <p className="text-xs text-ink-muted">
            Sabab va izohni faqat siz va qabul qiluvchi shifokor ko‘radi.
          </p>
        </div>
      )}
    </AModal>
  );
}

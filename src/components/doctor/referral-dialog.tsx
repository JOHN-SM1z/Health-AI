"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { AButton, AError, AModal, ASelect, ATextArea, LoadingRow } from "@/components/admin/ui";
import { adminApi, AdminApiError, formatDateTime, REFERRAL_PRIORITY_LABELS } from "@/lib/admin/client";
import { newIdempotencyKey } from "@/lib/idempotency-key";

type Recipient = { id: string; name: string; title: string | null; specialty: string | null };

/** The consultation the referral is raised from — the doctor's own visit with the patient. */
export type ReferralConsultation = { appointmentId: string; startAt: string; serviceName: string | null };

const VALIDITY_OPTIONS = [
  { value: "30", label: "30 kun" },
  { value: "60", label: "60 kun" },
  { value: "90", label: "90 kun" },
  { value: "180", label: "180 kun" },
];

function ReviewRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="border-b border-hairline/70 py-2 text-sm last:border-b-0">
      <p className="text-xs text-ink-muted">{label}</p>
      <div className="mt-0.5 whitespace-pre-wrap font-medium text-foreground">{children}</div>
    </div>
  );
}

/**
 * Refers the patient of one of the doctor's own consultations to a colleague:
 * fill in → review → send. The server decides everything that matters
 * (the doctor's access to the consultation, the patient, the recipient's
 * clinic); this dialog only collects the doctor's choices.
 */
export function ReferralDialog({
  consultation,
  patientName,
  onClose,
  onCreated,
}: {
  consultation: ReferralConsultation;
  patientName: string;
  onClose: () => void;
  onCreated: (referralId: string) => void;
}) {
  const [recipients, setRecipients] = useState<Recipient[] | null>(null);
  const [specialty, setSpecialty] = useState("");
  const [doctorId, setDoctorId] = useState("");
  const [priority, setPriority] = useState<"routine" | "urgent">("routine");
  const [validForDays, setValidForDays] = useState("90");
  const [reason, setReason] = useState("");
  const [handoffNote, setHandoffNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // Set when the doctor opens the review: one idempotency key per intended
  // referral, so a double click or a retry after a lost response can't send
  // it twice. Going back to edit drops it; the next review gets a new one.
  const [review, setReview] = useState<{ idempotencyKey: string; approxExpiry: string } | null>(null);
  const inFlight = useRef(false);

  useEffect(() => {
    adminApi
      .get<{ doctors: Recipient[] }>("/api/doctor/referrals/recipients")
      .then((res) => setRecipients(res.doctors))
      .catch((e) => {
        setRecipients([]);
        setError(e instanceof AdminApiError ? e.message : "Shifokorlarni yuklab bo‘lmadi");
      });
  }, []);

  const specialties = [...new Set((recipients ?? []).map((d) => d.specialty).filter((s): s is string => !!s))].sort();
  const filteredRecipients = (recipients ?? []).filter((d) => !specialty || d.specialty === specialty);
  const recipient = recipients?.find((d) => d.id === doctorId) ?? null;
  const canReview = !!recipient && reason.trim().length >= 3;
  const doctorLabel = (d: Recipient) => [d.name, d.specialty ?? d.title].filter(Boolean).join(" — ");

  const openReview = () => {
    setError(null);
    setReview({
      idempotencyKey: newIdempotencyKey(),
      approxExpiry: formatDateTime(new Date(Date.now() + Number(validForDays) * 86_400_000).toISOString()),
    });
  };

  const submit = async () => {
    if (!review || !canReview || inFlight.current) return;
    inFlight.current = true;
    setSubmitting(true);
    setError(null);
    try {
      const res = await adminApi.post<{ referral: { id: string } }>("/api/doctor/referrals", {
        idempotencyKey: review.idempotencyKey,
        appointmentId: consultation.appointmentId,
        referredToDoctorId: doctorId,
        reason: reason.trim(),
        handoffNote: handoffNote.trim() || undefined,
        priority,
        validForDays: Number(validForDays),
      });
      onCreated(res.referral.id);
    } catch (e) {
      // The same key is kept, so sending again after a network error is safe.
      setError(e instanceof AdminApiError ? e.message : "Yo‘llanmani yuborib bo‘lmadi");
      setSubmitting(false);
    } finally {
      inFlight.current = false;
    }
  };

  return (
    <AModal
      title={review ? "Yo‘llanmani tekshiring" : "Yo‘llanma berish"}
      onClose={onClose}
      footer={
        review ? (
          <>
            <AButton variant="ghost" onClick={() => setReview(null)} disabled={submitting}>
              Tahrirlash
            </AButton>
            <AButton loading={submitting} onClick={() => void submit()}>
              Yo‘llanma yuborish
            </AButton>
          </>
        ) : (
          <>
            <AButton variant="ghost" onClick={onClose}>
              Bekor qilish
            </AButton>
            <AButton disabled={!canReview} onClick={openReview}>
              Ko‘rib chiqish
            </AButton>
          </>
        )
      }
    >
      {error && <AError message={error} />}
      <div className="rounded-xl border border-hairline px-3 py-2 text-sm">
        <p>
          <span className="text-ink-muted">Bemor:</span> <span className="font-medium text-foreground">{patientName}</span>
        </p>
        <p>
          <span className="text-ink-muted">Qabul:</span>{" "}
          <span className="font-medium text-foreground">
            {formatDateTime(consultation.startAt)}
            {consultation.serviceName ? ` · ${consultation.serviceName}` : ""}
          </span>
        </p>
      </div>

      {recipients === null ? (
        <LoadingRow />
      ) : recipients.length === 0 ? (
        <p className="text-sm text-ink-muted">Yo‘llanma berish mumkin bo‘lgan shifokor topilmadi.</p>
      ) : review && recipient ? (
        <div>
          <ReviewRow label="Qabul qiluvchi shifokor">{doctorLabel(recipient)}</ReviewRow>
          <ReviewRow label="Muhimlik">{REFERRAL_PRIORITY_LABELS[priority]}</ReviewRow>
          <ReviewRow label="Amal qilish muddati">
            {validForDays} kun (taxminan {review.approxExpiry} gacha)
          </ReviewRow>
          <ReviewRow label="Yo‘llanma sababi">{reason.trim()}</ReviewRow>
          <ReviewRow label="Shifokor uchun izoh">{handoffNote.trim() || "—"}</ReviewRow>
          <p className="mt-2 text-xs text-ink-muted">
            Yuborilgach sabab va izohni o‘zgartirib bo‘lmaydi. Ularni bemorni davolashga vakolatli shifokorlar ko‘radi.
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <div>
            <p className="mb-1 text-xs font-medium text-ink-muted">Bo‘lim / mutaxassislik</p>
            <ASelect value={specialty} onChange={(value) => { setSpecialty(value); setDoctorId(""); }}
              options={[{ value: "", label: "Barcha bo‘limlar" }, ...specialties.map((name) => ({ value: name, label: name }))]}
              aria-label="Bo‘lim / mutaxassislik" />
          </div>
          <div>
            <p className="mb-1 text-xs font-medium text-ink-muted">Qabul qiluvchi shifokor</p>
            <ASelect
              value={doctorId}
              onChange={setDoctorId}
              options={[{ value: "", label: "Shifokorni tanlang" }, ...filteredRecipients.map((d) => ({ value: d.id, label: doctorLabel(d) }))]}
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
          <p className="text-xs text-ink-muted">Sabab va izohni bemorni davolashga vakolatli shifokorlar ko‘radi.</p>
        </div>
      )}
    </AModal>
  );
}

"use client";

import { useState } from "react";
import { ShieldCheck, ShieldAlert } from "lucide-react";
import { AButton, AInput } from "@/components/admin/ui";
import { adminApi, AdminApiError } from "@/lib/admin/client";
import { parseDob } from "@/components/mini-app/identity-step";

export type IdentityVerifiedBy = "oneid" | "reception" | null;

const OUTCOME_TEXT: Record<string, string> = {
  mismatch: "Hujjat kartadagi ma’lumotga mos kelmadi. Hujjatni qayta ko‘ring; bemor boshqa odam bo‘lishi mumkin.",
  other_document:
    "Kartada boshqa turdagi hujjat saqlangan. Pasportdagi boshqa raqamni kiriting (pasport/ID karta raqami yoki JSHSHIR).",
  document_in_use: "Bu hujjat boshqa kartada bor. Kartalarni birlashtirish uchun administratorga murojaat qiling.",
};

/**
 * The passport in hand: the receptionist copies the series/number (or JSHSHIR) and the date of birth from the
 * patient's document; the server says only whether they match the card. Stored values are never shown.
 */
export function IdentityCheck({
  patientId,
  verifiedBy,
  onVerified,
  compact = false,
}: {
  patientId: string;
  verifiedBy: IdentityVerifiedBy;
  onVerified?: () => void;
  compact?: boolean;
}) {
  const [state, setState] = useState<IdentityVerifiedBy>(verifiedBy);
  const [open, setOpen] = useState(false);
  const [document, setDocument] = useState("");
  const [dob, setDob] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  if (state) {
    return (
      <span
        className="inline-flex items-center gap-1 rounded-full bg-pine-tint px-2 py-0.5 text-[11px] font-semibold text-pine-deep"
        data-testid="identity-verified"
      >
        <ShieldCheck className="h-3.5 w-3.5" />
        {state === "oneid" ? "Shaxs OneID orqali tasdiqlangan" : "Hujjat qabulxonada tekshirilgan"}
      </span>
    );
  }

  const submit = async () => {
    const iso = parseDob(dob);
    if (!document.trim() || !iso) return setMessage("Hujjat raqami va tug‘ilgan sanani (kk.oo.yyyy) hujjatdan kiriting");
    setBusy(true);
    setMessage(null);
    try {
      const res = await adminApi.post<{ outcome: string }>(`/api/operations/patients/${patientId}/verify-identity`, { document, dateOfBirth: iso });
      if (res.outcome === "verified") {
        setState("reception");
        setOpen(false);
        onVerified?.();
      } else {
        setMessage(OUTCOME_TEXT[res.outcome] ?? "Tekshirib bo‘lmadi");
      }
    } catch (e) {
      setMessage(e instanceof AdminApiError ? e.message : "Tekshirib bo‘lmadi");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={compact ? "" : "mt-2"}>
      {!open ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-1 rounded-full bg-clay-tint px-2 py-0.5 text-[11px] font-semibold text-clay-deep">
            <ShieldAlert className="h-3.5 w-3.5" /> Shaxs tasdiqlanmagan
          </span>
          <AButton size="sm" variant="outline" onClick={() => setOpen(true)}>
            Hujjatni tekshirish
          </AButton>
        </div>
      ) : (
        <div className="flex flex-col gap-2 rounded-xl border border-hairline bg-surface p-3">
          <p className="text-xs text-ink-muted">Bemorning pasporti yoki ID kartasidan ko‘chiring — kartadagi ma’lumot ko‘rsatilmaydi, faqat moslik tekshiriladi.</p>
          <div className="grid gap-2 sm:grid-cols-2">
            <AInput value={document} onChange={setDocument} placeholder="AB1234567 yoki JSHSHIR" aria-label="Hujjat raqami (qo‘ldagi hujjatdan)" autoComplete="off" />
            <AInput value={dob} onChange={setDob} placeholder="Tug‘ilgan sana: kk.oo.yyyy" aria-label="Tug‘ilgan sana (qo‘ldagi hujjatdan)" autoComplete="off" />
          </div>
          {message && (
            <p role="alert" className="text-xs font-medium text-danger">
              {message}
            </p>
          )}
          <div className="flex gap-2">
            <AButton size="sm" loading={busy} onClick={() => void submit()}>
              Tekshirish
            </AButton>
            <AButton size="sm" variant="ghost" onClick={() => setOpen(false)}>
              Bekor
            </AButton>
          </div>
        </div>
      )}
    </div>
  );
}

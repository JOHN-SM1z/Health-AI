"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { Send } from "lucide-react";
import { PageHeader, Card, ABadge, ATable, AEmpty, AError, AButton, AModal, ATextArea, LoadingRow } from "@/components/admin/ui";
import { ReferralLifecycle } from "@/components/doctor/referral-lifecycle";
import {
  adminApi,
  AdminApiError,
  formatDateTime,
  REFERRAL_PRIORITY_LABELS,
  REFERRAL_STATUS_LABELS,
  REFERRAL_STATUS_TONES,
  STATUS_LABELS,
  STATUS_TONES,
} from "@/lib/admin/client";

type Action = "accept" | "decline" | "complete" | "revoke";
type Appointment = { id: string; start_at: string; status: string; services?: { name: string } | null };
type Doctor = { id: string; name: string; title?: string | null } | null;

type Referral = {
  id: string;
  role: "referrer" | "receiver";
  status: string;
  priority: string;
  reason: string;
  handoffNote: string | null;
  declinedReason: string | null;
  revokedReason: string | null;
  createdAt: string;
  expiresAt: string;
  acceptedAt: string | null;
  startedAt: string | null;
  declinedAt: string | null;
  completedAt: string | null;
  revokedAt: string | null;
  referringDoctor: Doctor;
  referredToDoctor: Doctor;
  patientId: string;
  patientRecordAccessible: boolean;
  patient: { fullName: string | null; phone: string | null; preferredLanguage: string | null } | null;
  consultation: Appointment | null;
  followUp: Appointment | null;
  history: Appointment[] | null;
  allowedActions: Action[];
};

const ACTION_LABELS: Record<Action, string> = {
  accept: "Qabul qilish",
  decline: "Rad etish",
  complete: "Yakunlash",
  revoke: "Yo‘llanmani bekor qilish",
};

const DONE: Record<Action, string> = {
  accept: "Yo‘llanma qabul qilindi",
  decline: "Yo‘llanma rad etildi",
  complete: "Yo‘llanma yakunlandi",
  revoke: "Yo‘llanma bekor qilindi",
};

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-hairline/70 py-2 text-sm last:border-b-0">
      <span className="text-ink-muted">{label}</span>
      <span className="text-right font-medium text-foreground">{children}</span>
    </div>
  );
}

function AppointmentLine({ appointment }: { appointment: Appointment }) {
  return (
    <span className="inline-flex flex-wrap items-center justify-end gap-2">
      {formatDateTime(appointment.start_at)}
      {appointment.services?.name && <span className="text-ink-muted">· {appointment.services.name}</span>}
      <ABadge tone={STATUS_TONES[appointment.status] ?? "neutral"}>{STATUS_LABELS[appointment.status] ?? appointment.status}</ABadge>
    </span>
  );
}

export default function DoctorReferralPage() {
  const { id } = useParams<{ id: string }>();
  const [referral, setReferral] = useState<Referral | null>(null);
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<Action | null>(null);
  const [reasonFor, setReasonFor] = useState<"decline" | "revoke" | null>(null);
  const [reason, setReason] = useState("");

  const load = useCallback(async () => {
    try {
      const res = await adminApi.get<{ referral: Referral }>(`/api/doctor/referrals/${id}`);
      setReferral(res.referral);
      setMissing(false);
    } catch (e) {
      if (e instanceof AdminApiError && e.status === 404) {
        setReferral(null);
        setMissing(true);
      } else {
        setError(e instanceof AdminApiError ? e.message : "Yo‘llanmani yuklab bo‘lmadi");
      }
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  const run = async (action: Action, withReason?: string) => {
    setBusy(action);
    setError(null);
    try {
      await adminApi.patch(`/api/doctor/referrals/${id}`, { action, ...(withReason ? { reason: withReason } : {}) });
      // Reload before confirming so the notice never sits next to the old status.
      await load();
      setNotice(DONE[action]);
      setReasonFor(null);
      setReason("");
    } catch (e) {
      setError(e instanceof AdminApiError ? e.message : "Amalni bajarib bo‘lmadi");
    } finally {
      setBusy(null);
    }
  };

  const back = (
    <Link href="/doctor/referrals" className="text-sm font-medium text-pine hover:underline">
      ← Yo‘llanmalar
    </Link>
  );

  if (missing) {
    return (
      <div>
        <PageHeader title="Yo‘llanma" action={back} />
        <Card>
          <AEmpty
            title={notice ?? "Yo‘llanma topilmadi"}
            subtitle={notice ? "Bu yo‘llanma endi sizga ko‘rinmaydi" : "U mavjud emas yoki sizga tegishli emas"}
            icon={<Send className="h-6 w-6" />}
          />
        </Card>
      </div>
    );
  }

  if (!referral) {
    return (
      <div>
        <PageHeader title="Yo‘llanma" action={back} />
        {error && <AError message={error} />}
        <Card>
          <LoadingRow />
        </Card>
      </div>
    );
  }

  const incoming = referral.role === "receiver";
  const needsReason = (a: Action): a is "decline" | "revoke" => a === "decline" || a === "revoke";

  return (
    <div>
      <PageHeader
        title="Yo‘llanma"
        subtitle={`${referral.patient?.fullName ?? "Bemor"} — ${incoming ? `${referral.referringDoctor?.name ?? "—"} dan` : `${referral.referredToDoctor?.name ?? "—"} ga`}`}
        action={back}
      />
      {error && <AError message={error} />}
      {notice && (
        <Card className="mb-4 border-pine/30 bg-pine-tint/60">
          <p className="text-sm font-medium text-pine-deep">{notice}</p>
        </Card>
      )}

      {incoming && referral.status === "accepted" && referral.patientRecordAccessible && (
        <Card className="mb-4">
          <p className="text-sm text-foreground">
            Keyingi qadam: bemor bilan o‘z qabulingizni bemor kartasida boshlang — yo‘llanma “Qabul boshlangan” holatiga o‘tadi, yakunlash
            esa shundan keyin mumkin bo‘ladi.{" "}
            <Link href={`/doctor/patients/${referral.patientId}`} className="font-medium text-pine hover:underline">
              Bemor kartasini ochish
            </Link>
          </p>
        </Card>
      )}

      {referral.allowedActions.length > 0 && (
        <div className="mb-4 flex flex-wrap gap-2">
          {referral.allowedActions.map((action) => (
            <AButton
              key={action}
              variant={action === "revoke" ? "danger" : action === "decline" ? "outline" : "primary"}
              loading={busy === action}
              disabled={busy !== null}
              onClick={() => (needsReason(action) ? setReasonFor(action) : void run(action))}
            >
              {ACTION_LABELS[action]}
            </AButton>
          ))}
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-5">
        <Card className="lg:col-span-3">
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <ABadge tone={REFERRAL_STATUS_TONES[referral.status] ?? "gray"}>{REFERRAL_STATUS_LABELS[referral.status] ?? referral.status}</ABadge>
            <ABadge tone={referral.priority === "urgent" ? "red" : "neutral"}>
              {REFERRAL_PRIORITY_LABELS[referral.priority] ?? referral.priority}
            </ABadge>
          </div>
          <div className="mb-4">
            <ReferralLifecycle
              status={referral.status}
              createdAt={referral.createdAt}
              acceptedAt={referral.acceptedAt}
              startedAt={referral.startedAt}
              completedAt={referral.completedAt}
            />
          </div>
          <p className="mb-1 font-display text-sm font-bold text-foreground">Yo‘llanma sababi</p>
          <p className="mb-4 whitespace-pre-wrap text-sm text-foreground">{referral.reason}</p>
          {referral.handoffNote && (
            <>
              <p className="mb-1 font-display text-sm font-bold text-foreground">Shifokor uchun izoh</p>
              <p className="mb-4 whitespace-pre-wrap text-sm text-foreground">{referral.handoffNote}</p>
            </>
          )}
          {referral.declinedReason && (
            <p className="mb-2 text-sm text-ink-muted">Rad etish sababi: {referral.declinedReason}</p>
          )}
          {referral.revokedReason && (
            <p className="mb-2 text-sm text-ink-muted">Bekor qilish sababi: {referral.revokedReason}</p>
          )}
          <Field label="Yo‘llagan shifokor">{referral.referringDoctor?.name ?? "—"}</Field>
          <Field label="Qabul qiluvchi shifokor">{referral.referredToDoctor?.name ?? "—"}</Field>
          <Field label="Yuborilgan">{formatDateTime(referral.createdAt)}</Field>
          <Field label="Amal qilish muddati">{formatDateTime(referral.expiresAt)}</Field>
          {referral.acceptedAt && <Field label="Qabul qilingan">{formatDateTime(referral.acceptedAt)}</Field>}
          {referral.startedAt && <Field label="Qabul boshlangan">{formatDateTime(referral.startedAt)}</Field>}
          {referral.declinedAt && <Field label="Rad etilgan">{formatDateTime(referral.declinedAt)}</Field>}
          {referral.completedAt && <Field label="Yakunlangan">{formatDateTime(referral.completedAt)}</Field>}
          {referral.revokedAt && <Field label="Bekor qilingan">{formatDateTime(referral.revokedAt)}</Field>}
        </Card>

        <div className="flex flex-col gap-4 lg:col-span-2">
          <Card>
            <p className="mb-2 font-display text-sm font-bold text-foreground">Bemor</p>
            <Field label="Ism">
              {referral.patientRecordAccessible ? (
                <Link href={`/doctor/patients/${referral.patientId}`} className="text-pine hover:underline">
                  {referral.patient?.fullName ?? "—"}
                </Link>
              ) : (
                (referral.patient?.fullName ?? "—")
              )}
            </Field>
            <Field label="Telefon">{referral.patient?.phone ?? "—"}</Field>
            <Field label="Yo‘llanma berilgan qabul">
              {referral.consultation ? <AppointmentLine appointment={referral.consultation} /> : "—"}
            </Field>
            <Field label="Yo‘llanma bo‘yicha qabul">
              {referral.followUp ? <AppointmentLine appointment={referral.followUp} /> : "Hali yozilmagan"}
            </Field>
          </Card>

          <Card>
            <p className="mb-2 font-display text-sm font-bold text-foreground">
              Qabullar tarixi {referral.referringDoctor?.name ? `(${referral.referringDoctor.name})` : ""}
            </p>
            {referral.history === null ? (
              <p className="text-sm text-ink-muted">
                {"Yo‘llanma faol emas — qabullar tarixi endi ko‘rinmaydi."}
              </p>
            ) : referral.history.length === 0 ? (
              <p className="text-sm text-ink-muted">Qabullar yo‘q</p>
            ) : (
              <ATable headers={["Sana", "Xizmat", "Holat"]}>
                {referral.history.map((a) => (
                  <tr key={a.id}>
                    <td className="px-4 py-2 text-foreground">{formatDateTime(a.start_at)}</td>
                    <td className="px-4 py-2 text-foreground">{a.services?.name ?? "—"}</td>
                    <td className="px-4 py-2">
                      <ABadge tone={STATUS_TONES[a.status] ?? "neutral"}>{STATUS_LABELS[a.status] ?? a.status}</ABadge>
                    </td>
                  </tr>
                ))}
              </ATable>
            )}
          </Card>
        </div>
      </div>

      {reasonFor && (
        <AModal
          title={reasonFor === "decline" ? "Yo‘llanmani rad etish" : "Yo‘llanmani bekor qilish"}
          onClose={() => setReasonFor(null)}
          footer={
            <>
              <AButton variant="ghost" onClick={() => setReasonFor(null)} disabled={busy !== null}>
                Orqaga
              </AButton>
              <AButton
                variant={reasonFor === "revoke" ? "danger" : "primary"}
                loading={busy === reasonFor}
                disabled={reasonFor === "revoke" && reason.trim().length < 3}
                onClick={() => void run(reasonFor, reason.trim() || undefined)}
              >
                {ACTION_LABELS[reasonFor]}
              </AButton>
            </>
          }
        >
          <p className="text-sm text-ink-muted">
            {reasonFor === "decline"
              ? "Sababni yozsangiz, yo‘llagan shifokor uni ko‘radi (ixtiyoriy)."
              : "Sababni yozing — qabul qiluvchi shifokor yo‘llanmani boshqa ko‘rmaydi."}
          </p>
          <ATextArea value={reason} onChange={setReason} rows={3} aria-label="Sabab" />
        </AModal>
      )}
    </div>
  );
}

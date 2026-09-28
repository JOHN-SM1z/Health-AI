"use client";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { ClipboardList, Clock, ShieldOff, UserRound } from "lucide-react";
import { PageHeader, Card, ABadge, AEmpty, AError, AButton, ASelect, ATextArea, LoadingRow } from "@/components/admin/ui";
import {
  adminApi,
  AdminApiError,
  formatDateTime,
  formatTime,
  CLINICAL_RECORD_TYPE_TONES,
  REFERRAL_PRIORITY_LABELS,
  REFERRAL_STATUS_LABELS,
  REFERRAL_STATUS_TONES,
  STATUS_LABELS,
  STATUS_TONES,
} from "@/lib/admin/client";
import { ReferralDialog } from "@/components/doctor/referral-dialog";
import { ClinicalRecordForm, type RecordDraft } from "@/components/doctor/clinical-record-form";
import { ReferralLifecycle } from "@/components/doctor/referral-lifecycle";
import { RecordHistory } from "@/components/doctor/record-history";
import { RECORD_CATEGORY_LABELS, type RecordCategory } from "@/lib/clinical-records/categories";

type Appointment = {
  id: string;
  startAt: string;
  status: string;
  mine: boolean;
  doctor: { id: string; name: string } | null;
  service: { name: string } | null;
};

type ClinicalRecord = {
  id: string;
  type: string;
  summary: string;
  details: string | null;
  code: string | null;
  createdAt: string;
  appointmentId: string;
  author: { id: string; name: string | null };
  /** Written by the calling doctor — the only records they may edit. */
  mine: boolean;
  /** The server sends only the current version of each record; 1 means never corrected. */
  version: number;
  rootRecordId: string;
  /** Written in the doctor's consultation under way, or earlier (set by the server). */
  stage: "current" | "historical";
  category: RecordCategory;
};

type Referral = {
  id: string;
  role: "referrer" | "receiver" | "care_team";
  status: string;
  priority: string;
  reason: string;
  handoffNote: string | null;
  createdAt: string;
  expiresAt: string;
  referringDoctor: { id: string; name: string } | null;
  referredToDoctor: { id: string; name: string } | null;
  followUpAppointmentId: string | null;
  acceptedAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
};

type ConsultationRef = { appointmentId: string; startAt: string; serviceName: string | null };

type Workspace = {
  patient: { id: string; fullName: string | null; phone: string | null };
  relationship: "own" | "referred";
  /** When referral-based access ends at the latest (null: none open). */
  referralAccessUntil: string | null;
  appointments: Appointment[];
  records: ClinicalRecord[];
  referrals: Referral[];
  consultation: {
    current: ConsultationRef | null;
    booked: ConsultationRef | null;
    canStartWalkIn: boolean;
    blockedReason: null;
    services: Array<{ id: string; name: string }>;
  };
};

/** Why the workspace can't be shown — never with any of the patient's data. */
type Blocked = { title: string; subtitle: string; icon: ReactNode };

const BLOCKED: Record<string, Blocked> = {
  referral_expired: {
    title: "Yo‘llanma muddati tugagan",
    subtitle: "Yo‘llanma muddati tugagan. Yangi davolash uchun qabulxona sizni bemorning mavjud kartasiga qabulga yozishi mumkin.",
    icon: <Clock className="h-6 w-6" />,
  },
  referral_revoked: {
    title: "Yo‘llanma bekor qilingan",
    subtitle: "Yo‘llanma bekor qilindi, shuning uchun bemor ma‘lumotlari endi sizga ko‘rinmaydi.",
    icon: <ShieldOff className="h-6 w-6" />,
  },
  referral_declined: {
    title: "Yo‘llanma rad etilgan",
    subtitle: "Siz bu yo‘llanmani rad etgansiz — bemor ma‘lumotlari sizga ko‘rinmaydi.",
    icon: <ShieldOff className="h-6 w-6" />,
  },
  referral_completed: {
    title: "Yo‘llanma yakunlangan",
    subtitle: "Yo‘llanma yakunlandi. Bemor bilan o‘z qabulingiz bo‘lmasa, uning ma‘lumotlari endi sizga ko‘rinmaydi.",
    icon: <ClipboardList className="h-6 w-6" />,
  },
  doctor_not_linked: {
    title: "Shifokor hisobi ulanmagan",
    subtitle: "Admin panelda shifokor kartasiga profilingizni bog‘lang.",
    icon: <UserRound className="h-6 w-6" />,
  },
  patient_not_found: {
    title: "Bemor topilmadi",
    subtitle: "U mavjud emas yoki uni ko‘rishga ruxsatingiz yo‘q.",
    icon: <UserRound className="h-6 w-6" />,
  },
};

/** A doctor may refer from their own visit once the patient has been seen. */
const REFERABLE = ["in_progress", "completed"];
/** Visits that have not taken place yet. */
const SCHEDULED = ["pending", "confirmed", "checked_in"];

/** Record types gathered in the clinical summary (consultation notes stay with their visit). */
const SUMMARY_TYPES = ["diagnosis", "medical_history", "prescription", "lab_order", "lab_result"] as const;
const SUMMARY_TITLES: Record<(typeof SUMMARY_TYPES)[number], string> = {
  diagnosis: "Tashxislar",
  medical_history: "Anamnez",
  prescription: "Retseptlar",
  lab_order: "Tahlilga yo‘llanmalar",
  lab_result: "Tahlil natijalari",
};

function Section({ title, subtitle, children }: { title: string; subtitle?: string; children: ReactNode }) {
  return (
    <section className="mb-6" aria-label={title}>
      <h2 className="font-display text-base font-bold text-foreground">{title}</h2>
      {subtitle && <p className="mb-2 text-sm text-ink-muted">{subtitle}</p>}
      <div className="mt-2 flex flex-col gap-3">{children}</div>
    </section>
  );
}

function RecordItem({
  record,
  patientId,
  onCorrect,
}: {
  record: ClinicalRecord;
  patientId: string;
  onCorrect?: (r: ClinicalRecord) => void;
}) {
  const [showHistory, setShowHistory] = useState(false);
  return (
    <li className="rounded-xl border border-hairline px-3 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <ABadge tone={CLINICAL_RECORD_TYPE_TONES[record.type] ?? "neutral"}>{RECORD_CATEGORY_LABELS[record.category] ?? record.type}</ABadge>
        {record.version > 1 && <ABadge tone="gray">Tuzatilgan · {record.version}-versiya</ABadge>}
        {record.code && <span className="font-numeric text-xs text-ink-muted">{record.code}</span>}
      </div>
      {/* Only the current version: earlier ones are in the record's history. */}
      <p className="mt-1 text-sm font-medium text-foreground">{record.summary}</p>
      {record.details && <p className="mt-0.5 whitespace-pre-wrap text-sm text-foreground">{record.details}</p>}
      {/* Provenance: who wrote it and when — never implied to be the reader's. */}
      <p className="mt-1 text-xs text-ink-muted">
        {record.mine ? "Siz yozgansiz" : `Muallif: ${record.author.name ?? "—"}`} · {formatDateTime(record.createdAt)}
        {/* Only the author edits; another doctor records their own view as a new record. */}
        {onCorrect && record.mine && (
          <>
            {" · "}
            <button type="button" className="text-pine hover:underline" onClick={() => onCorrect(record)}>
              Tahrirlash
            </button>
          </>
        )}
        {record.version > 1 && (
          <>
            {" · "}
            <button type="button" className="text-pine hover:underline" aria-expanded={showHistory} onClick={() => setShowHistory((v) => !v)}>
              {showHistory ? "Tarixni yopish" : "Tarix"}
            </button>
          </>
        )}
      </p>
      {showHistory && <RecordHistory patientId={patientId} recordId={record.id} />}
    </li>
  );
}

export default function DoctorPatientWorkspacePage() {
  const { id } = useParams<{ id: string }>();
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [blocked, setBlocked] = useState<Blocked | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [serviceId, setServiceId] = useState("");
  const [correcting, setCorrecting] = useState<RecordDraft & { appointmentId: string } | null>(null);
  const [referFrom, setReferFrom] = useState<Appointment | null>(null);
  const [confirmComplete, setConfirmComplete] = useState<string | null>(null);
  const [declineFor, setDeclineFor] = useState<string | null>(null);
  const [declineReason, setDeclineReason] = useState("");
  const [notice, setNotice] = useState<ReactNode | null>(null);

  const load = useCallback(async (): Promise<Workspace | null> => {
    try {
      const res = await adminApi.get<{ record: Workspace }>(`/api/doctor/patients/${id}`);
      setWorkspace(res.record);
      setBlocked(null);
      return res.record;
    } catch (e) {
      setWorkspace(null);
      const known = e instanceof AdminApiError && e.code ? BLOCKED[e.code] : undefined;
      if (known) setBlocked(known);
      else if (e instanceof AdminApiError && e.status === 404) setBlocked(BLOCKED.patient_not_found);
      else setError(e instanceof AdminApiError ? e.message : "Bemor ma‘lumotlarini yuklab bo‘lmadi");
      return null;
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  const act = async (run: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await run();
      await load();
    } catch (e) {
      setError(e instanceof AdminApiError ? e.message : "Amalni bajarib bo‘lmadi");
    } finally {
      setBusy(false);
    }
  };

  const startConsultation = (body: { appointmentId: string } | { serviceId: string }) =>
    act(() => adminApi.post(`/api/doctor/patients/${id}/consultations`, body));
  const completeConsultation = (appointmentId: string) =>
    act(() => adminApi.patch(`/api/doctor/appointments/${appointmentId}`, { status: "completed" }));
  const actOnReferral = (referralId: string, action: "accept" | "decline" | "complete", reason?: string) =>
    act(async () => {
      await adminApi.patch(`/api/doctor/referrals/${referralId}`, { action, ...(reason ? { reason } : {}) });
      setConfirmComplete(null);
      setDeclineFor(null);
      setDeclineReason("");
    });
  const correct = (rec: ClinicalRecord) =>
    setCorrecting({
      recordId: rec.id,
      rootRecordId: rec.rootRecordId,
      version: rec.version,
      type: rec.type,
      summary: rec.summary,
      details: rec.details,
      code: rec.code,
      appointmentId: rec.appointmentId,
    });
  // The record changed since it was opened: show its latest version and move
  // the still-open form (with the doctor's unsaved text) onto it, so the next
  // save is a deliberate correction of what is current now.
  const reloadAfterConflict = async (rootRecordId: string) => {
    const latest = (await load())?.records.find((r) => r.rootRecordId === rootRecordId && r.mine);
    setCorrecting((c) => (latest && c ? { ...c, recordId: latest.id, version: latest.version } : null));
  };

  const recordsByAppointment = useMemo(() => {
    const map = new Map<string, ClinicalRecord[]>();
    for (const r of workspace?.records ?? []) map.set(r.appointmentId, [...(map.get(r.appointmentId) ?? []), r]);
    return map;
  }, [workspace]);

  const back =
    workspace?.relationship === "own" ? (
      <Link href="/doctor/patients" className="text-sm font-medium text-pine hover:underline">
        ← Bemorlarim
      </Link>
    ) : (
      <Link href="/doctor/referrals" className="text-sm font-medium text-pine hover:underline">
        ← Yo‘llanmalar
      </Link>
    );

  if (blocked) {
    return (
      <div>
        <PageHeader title="Bemor kartasi" action={back} />
        <Card>
          <AEmpty title={blocked.title} subtitle={blocked.subtitle} icon={blocked.icon} />
        </Card>
      </div>
    );
  }

  if (!workspace) {
    return (
      <div>
        <PageHeader title="Bemor kartasi" action={back} />
        {error && <AError message={error} />}
        <Card>
          <LoadingRow />
        </Card>
      </div>
    );
  }

  const { consultation } = workspace;
  const current = consultation.current;
  const scheduled = workspace.appointments
    .filter((a) => a.id !== current?.appointmentId && SCHEDULED.includes(a.status))
    .sort((x, y) => x.startAt.localeCompare(y.startAt));
  const previous = workspace.appointments.filter((a) => a.id !== current?.appointmentId && !SCHEDULED.includes(a.status));
  const activeReferralToMe = workspace.referrals.some((r) => r.role === "receiver" && ["pending", "accepted", "in_progress"].includes(r.status));
  // The referral this consultation is the handoff for, if any.
  const handoff = current ? workspace.referrals.find((r) => r.role === "receiver" && r.followUpAppointmentId === current.appointmentId) : undefined;
  const currentRecords = current ? (recordsByAppointment.get(current.appointmentId) ?? []) : [];
  const referringDoctorIds = new Set(workspace.referrals.filter((r) => r.role === "receiver").map((r) => r.referringDoctor?.id));
  // The server sends each visible record's consultation; anything else is
  // still listed rather than silently dropped.
  const shownAppointmentIds = new Set([...(current ? [current.appointmentId] : []), ...previous.map((a) => a.id)]);
  const unplaced = workspace.records.filter((r) => !shownAppointmentIds.has(r.appointmentId));
  // Records by type (the server sends only each record's current version).
  const summary = SUMMARY_TYPES.map((type) => [type, workspace.records.filter((r) => r.type === type)] as const).filter(
    ([, items]) => items.length > 0,
  );

  return (
    <div>
      <PageHeader title={workspace.patient.fullName ?? "Bemor"} subtitle={workspace.patient.phone ?? undefined} action={back} />
      {error && <AError message={error} />}
      {notice && (
        <Card className="mb-4 border-pine/30 bg-pine-tint/60">
          <p className="text-sm font-medium text-pine-deep">{notice}</p>
        </Card>
      )}

      <div className="mb-6 flex flex-wrap items-center gap-2 text-sm">
        {workspace.relationship === "own" && <ABadge tone="green">Mening bemorim</ABadge>}
        {(workspace.relationship === "referred" || activeReferralToMe) && <ABadge tone="blue">Yo‘llanma bo‘yicha</ABadge>}
        <span className="text-ink-muted">Faqat sizga ruxsat etilgan ma‘lumotlar ko‘rsatiladi.</span>
        {workspace.relationship === "referred" && workspace.referralAccessUntil && (
          <span className="text-ink-muted">
            Yo‘llanma bo‘yicha kirish {formatDateTime(workspace.referralAccessUntil)} da tugaydi (yo‘llanma yopilsa — darhol).
          </span>
        )}
      </div>

      {workspace.referrals.length > 0 && (
        <Section title="Yo‘llanmalar">
          {workspace.referrals.map((r) => (
            <Card key={r.id}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm font-medium text-foreground">
                  {r.role === "receiver"
                    ? `Sizga yo‘llagan: ${r.referringDoctor?.name ?? "—"}`
                    : r.role === "referrer"
                      ? `Siz yo‘llagansiz: ${r.referredToDoctor?.name ?? "—"}`
                      : `${r.referringDoctor?.name ?? "—"} → ${r.referredToDoctor?.name ?? "—"}`}
                </p>
                <div className="flex flex-wrap gap-2">
                  <ABadge tone={r.priority === "urgent" ? "red" : "neutral"}>{REFERRAL_PRIORITY_LABELS[r.priority] ?? r.priority}</ABadge>
                  <ABadge tone={REFERRAL_STATUS_TONES[r.status] ?? "gray"}>{REFERRAL_STATUS_LABELS[r.status] ?? r.status}</ABadge>
                </div>
              </div>
              <p className="mt-2 text-xs text-ink-muted">Yo‘llanma sababi</p>
              <p className="whitespace-pre-wrap text-sm text-foreground">{r.reason}</p>
              {r.handoffNote && (
                <>
                  <p className="mt-2 text-xs text-ink-muted">Shifokor uchun izoh</p>
                  <p className="whitespace-pre-wrap text-sm text-foreground">{r.handoffNote}</p>
                </>
              )}
              <div className="mt-3">
                <ReferralLifecycle status={r.status} createdAt={r.createdAt} acceptedAt={r.acceptedAt} startedAt={r.startedAt} completedAt={r.completedAt} />
              </div>
              <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                <p className="text-xs text-ink-muted">
                  Yuborilgan {formatDateTime(r.createdAt)} · Amal qiladi {formatDateTime(r.expiresAt)} ·{" "}
                  {r.role !== "care_team" && (
                    <Link href={`/doctor/referrals/${r.id}`} className="text-pine hover:underline">
                      Yo‘llanmani ochish
                    </Link>
                  )}
                </p>
                {r.role === "receiver" && r.status === "pending" && declineFor !== r.id && (
                  <div className="flex gap-2">
                    <AButton size="sm" variant="outline" onClick={() => setDeclineFor(r.id)}>
                      Rad etish
                    </AButton>
                    <AButton size="sm" loading={busy} onClick={() => void actOnReferral(r.id, "accept")}>
                      Yo‘llanmani qabul qilish
                    </AButton>
                  </div>
                )}
                {r.role === "receiver" && r.status === "in_progress" && confirmComplete !== r.id && (
                  <AButton size="sm" variant="outline" onClick={() => setConfirmComplete(r.id)}>
                    Yo‘llanmani yakunlash
                  </AButton>
                )}
              </div>
              {r.role === "receiver" && ["pending", "accepted"].includes(r.status) && (
                <p className="mt-2 text-sm text-ink-muted">
                  Tarix hozirdan ko‘rinadi. Quyida qabulingizni boshlang — yo‘llanma “Qabul boshlangan” holatiga o‘tadi.
                </p>
              )}
              {declineFor === r.id && (
                <div className="mt-3 flex flex-col gap-2 border-t border-hairline pt-3">
                  <p className="text-sm text-foreground">Rad etish sababi (ixtiyoriy) — yo‘llagan shifokor uni ko‘radi.</p>
                  <ATextArea value={declineReason} onChange={setDeclineReason} rows={2} aria-label="Rad etish sababi" />
                  <div className="flex gap-2">
                    <AButton size="sm" variant="outline" onClick={() => setDeclineFor(null)}>
                      Orqaga
                    </AButton>
                    <AButton size="sm" loading={busy} onClick={() => void actOnReferral(r.id, "decline", declineReason.trim() || undefined)}>
                      Yo‘llanmani rad etish
                    </AButton>
                  </div>
                </div>
              )}
              {confirmComplete === r.id && (
                <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-hairline pt-3">
                  <p className="text-sm text-foreground">
                    Yo‘llanma yakunlanadi. Bemor bilan o‘z qabulingiz bo‘lsa, uning tibbiy tarixi ko‘rinishda qoladi.
                  </p>
                  <div className="flex gap-2">
                    <AButton size="sm" variant="outline" onClick={() => setConfirmComplete(null)}>
                      Bekor qilish
                    </AButton>
                    <AButton size="sm" loading={busy} onClick={() => void actOnReferral(r.id, "complete")}>
                      Ha, yakunlash
                    </AButton>
                  </div>
                </div>
              )}
            </Card>
          ))}
        </Section>
      )}

      <Section title="Mening qabulim" subtitle="Siz bu bemor uchun yozadigan yangi qabul — oldingi yozuvlardan alohida.">
        <Card className={current ? "border-pine/40" : undefined}>
          {current ? (
            <div className="flex flex-col gap-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="text-sm text-foreground">
                    <ABadge tone="purple">Jarayonda</ABadge>{" "}
                    <span className="ml-1">
                      {formatDateTime(current.startAt)}
                      {current.serviceName ? ` · ${current.serviceName}` : ""}
                    </span>
                  </p>
                  {handoff && (
                    <p className="mt-1 text-xs text-ink-muted">
                      {handoff.referringDoctor?.name ?? "—"} yo‘llanmasi bo‘yicha qabul — yozuvlaringiz sizning nomingizdan saqlanadi, oldingi
                      yozuvlar o‘zgarmaydi.
                    </p>
                  )}
                </div>
                <div className="flex gap-2">
                  <AButton
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      const visit = workspace.appointments.find((a) => a.id === current.appointmentId);
                      if (visit) setReferFrom(visit);
                    }}
                  >
                    Yo‘llanma
                  </AButton>
                  <AButton variant="outline" size="sm" loading={busy} onClick={() => void completeConsultation(current.appointmentId)}>
                    Qabulni yakunlash
                  </AButton>
                </div>
              </div>
              {currentRecords.length > 0 && (
                <ul className="flex flex-col gap-2" aria-label="Joriy qabul yozuvlari">
                  {currentRecords.map((r) => (
                    <RecordItem key={r.id} record={r} patientId={workspace.patient.id} onCorrect={correct} />
                  ))}
                </ul>
              )}
              {correcting && correcting.appointmentId === current.appointmentId ? (
                <ClinicalRecordForm
                  key={correcting.rootRecordId}
                  patientId={workspace.patient.id}
                  appointmentId={current.appointmentId}
                  correcting={correcting}
                  onCancel={() => setCorrecting(null)}
                  onConflict={reloadAfterConflict}
                  onSaved={() => {
                    setCorrecting(null);
                    void load();
                  }}
                />
              ) : (
                <ClinicalRecordForm patientId={workspace.patient.id} appointmentId={current.appointmentId} onSaved={() => void load()} />
              )}
            </div>
          ) : consultation.booked ? (
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-sm text-foreground">
                Bugun {formatTime(consultation.booked.startAt)} ga yozilgan qabulingiz
                {consultation.booked.serviceName ? ` · ${consultation.booked.serviceName}` : ""}
              </p>
              <AButton loading={busy} onClick={() => void startConsultation({ appointmentId: consultation.booked!.appointmentId })}>
                Qabulni boshlash
              </AButton>
            </div>
          ) : consultation.canStartWalkIn ? (
            <div className="flex flex-wrap items-end gap-3">
              <div className="min-w-56 flex-1">
                <p className="mb-1 text-xs font-medium text-ink-muted">Xizmat</p>
                <ASelect
                  value={serviceId}
                  onChange={setServiceId}
                  options={[{ value: "", label: "Xizmatni tanlang" }, ...consultation.services.map((s) => ({ value: s.id, label: s.name }))]}
                  aria-label="Xizmat"
                />
              </div>
              <AButton loading={busy} disabled={!serviceId} onClick={() => void startConsultation({ serviceId })}>
                Hozir qabulni boshlash
              </AButton>
            </div>
          ) : (
            <p className="text-sm text-ink-muted">Bu bemor bilan qabul boshlay olmaysiz.</p>
          )}
        </Card>
      </Section>

      {scheduled.length > 0 && (
        <Section title="Rejalashtirilgan qabullar">
          <Card>
            <ul className="divide-y divide-hairline/70">
              {scheduled.map((a) => (
                <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                  <span className="text-foreground">
                    {formatDateTime(a.startAt)}
                    {a.service?.name ? ` · ${a.service.name}` : ""}
                    <span className="text-ink-muted"> · {a.mine ? "Siz" : (a.doctor?.name ?? "—")}</span>
                  </span>
                  <ABadge tone={STATUS_TONES[a.status] ?? "neutral"}>{STATUS_LABELS[a.status] ?? a.status}</ABadge>
                </li>
              ))}
            </ul>
          </Card>
        </Section>
      )}

      {summary.length > 0 && (
        <Section title="Klinik xulosa" subtitle="Amaldagi yozuvlar turi bo‘yicha — tuzatilgan yozuvning oxirgi versiyasi ko‘rsatiladi.">
          <div className="grid gap-3 md:grid-cols-2">
            {summary.map(([type, items]) => (
              <Card key={type}>
                <p className="mb-2 font-display text-sm font-bold text-foreground">{SUMMARY_TITLES[type]}</p>
                <ul className="flex flex-col gap-2" aria-label={SUMMARY_TITLES[type]}>
                  {items.map((r) => (
                    <li key={r.id} className="text-sm">
                      {type === "diagnosis" && (
                        <ABadge tone={r.stage === "current" ? "purple" : "neutral"}>{RECORD_CATEGORY_LABELS[r.category]}</ABadge>
                      )}{" "}
                      <span className="font-medium text-foreground">{r.summary}</span>
                      {r.code && <span className="font-numeric text-xs text-ink-muted"> · {r.code}</span>}
                      <p className="text-xs text-ink-muted">
                        {r.mine ? "Siz" : (r.author.name ?? "—")} · {formatDateTime(r.createdAt)}
                      </p>
                    </li>
                  ))}
                </ul>
              </Card>
            ))}
          </div>
        </Section>
      )}

      <Section
        title="Oldingi yozuvlar"
        subtitle="Qabullar va ularda yozilgan tibbiy yozuvlar — har birida muallif va vaqt. Ular mualliflariniki: ko‘rish yoki yangi tashxis qo‘yish ularni o‘zgartirmaydi."
      >
        {unplaced.length > 0 && (
          <Card>
            <p className="text-sm font-medium text-foreground">Boshqa qabullardagi yozuvlar</p>
            <ul className="mt-3 flex flex-col gap-2">
              {unplaced.map((r) => (
                <RecordItem key={r.id} record={r} patientId={workspace.patient.id} />
              ))}
            </ul>
          </Card>
        )}
        {previous.length === 0 && unplaced.length === 0 ? (
          <Card>
            <AEmpty title="Ko‘rsatiladigan oldingi yozuv yo‘q" icon={<ClipboardList className="h-6 w-6" />} />
          </Card>
        ) : (
          previous.map((a) => {
            const records = recordsByAppointment.get(a.id) ?? [];
            return (
              <Card key={a.id}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <p className="text-sm font-medium text-foreground">
                      {formatDateTime(a.startAt)}
                      {a.service?.name ? ` · ${a.service.name}` : ""}
                    </p>
                    <p className="text-xs text-ink-muted">
                      {a.mine
                        ? "Sizning qabulingiz"
                        : `${a.doctor?.name ?? "—"}${a.doctor && referringDoctorIds.has(a.doctor.id) ? " — yo‘llagan shifokor" : ""}`}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <ABadge tone={STATUS_TONES[a.status] ?? "neutral"}>{STATUS_LABELS[a.status] ?? a.status}</ABadge>
                    {a.mine && REFERABLE.includes(a.status) && (
                      <AButton size="sm" variant="outline" onClick={() => setReferFrom(a)}>
                        Yo‘llanma
                      </AButton>
                    )}
                  </div>
                </div>
                {records.length > 0 ? (
                  <ul className="mt-3 flex flex-col gap-2">
                    {records.map((r) => (
                      <RecordItem key={r.id} record={r} patientId={workspace.patient.id} onCorrect={correct} />
                    ))}
                  </ul>
                ) : (
                  <p className="mt-2 text-xs text-ink-muted">Bu qabulda tibbiy yozuv yo‘q.</p>
                )}
                {correcting && correcting.appointmentId === a.id && (
                  <div className="mt-3 border-t border-hairline pt-3">
                    <ClinicalRecordForm
                      key={correcting.rootRecordId}
                      patientId={workspace.patient.id}
                      appointmentId={a.id}
                      correcting={correcting}
                      onCancel={() => setCorrecting(null)}
                      onConflict={reloadAfterConflict}
                      onSaved={() => {
                        setCorrecting(null);
                        void load();
                      }}
                    />
                  </div>
                )}
              </Card>
            );
          })
        )}
      </Section>

      {referFrom && (
        <ReferralDialog
          consultation={{ appointmentId: referFrom.id, startAt: referFrom.startAt, serviceName: referFrom.service?.name ?? null }}
          patientName={workspace.patient.fullName ?? "—"}
          onClose={() => setReferFrom(null)}
          onCreated={(referralId) => {
            setReferFrom(null);
            setNotice(
              <>
                Yo‘llanma yuborildi.{" "}
                <Link href={`/doctor/referrals/${referralId}`} className="underline">
                  Yo‘llanmani ko‘rish
                </Link>
              </>,
            );
            void load();
          }}
        />
      )}
    </div>
  );
}

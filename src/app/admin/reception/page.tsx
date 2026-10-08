"use client";

import { useMemo, useState } from "react";
import { PageHeader, Card, ABadge, ATable, AEmpty, AError, AButton, AModal, AInput, ASelect } from "@/components/admin/ui";
import { adminApi, AdminApiError } from "@/lib/admin/client";
import { freshnessLabel, money, useLive, VISIT_STATUS } from "@/components/operations/use-live";
import { Search, UserCheck, UserPlus, Users } from "lucide-react";

/**
 * Reception (outpatient pilot): identify the patient once — by patient
 * number, JSHSHIR, passport/ID, phone or name — confirm identity before
 * selecting, then register the arrival with the doctor and services. The
 * server prices the services and creates the bill; the patient then pays at
 * the kassa, which issues the queue number. Reception never takes money.
 */

type Match = {
  id: string;
  patientNumber: number;
  fullName: string | null;
  dateOfBirth: string | null;
  sex: "female" | "male" | null;
  documentHint: string | null;
  phoneHint: string | null;
};
type Catalog = {
  clinic: { currency: string; operating_mode: string; queue_after_payment: boolean };
  doctors: Array<{ id: string; name: string; title: string | null; services: Array<{ id: string; name: string; price: number }> }>;
};
type Visit = {
  id: string;
  status: string;
  queueNumber: number | null;
  queueDate: string | null;
  arrivedAt: string;
  patient: { id: string; patientNumber: number; fullName: string | null };
  doctor: { id: string; name: string };
  balance: { charged: number; outstanding: number };
};

const newKey = () => crypto.randomUUID();
const EMPTY_NEW = { fullName: "", dateOfBirth: "", sex: "", phone: "", documentNumber: "", pinfl: "" };

export default function ReceptionPage() {
  const catalog = useLive<Catalog>("/api/operations/catalog", 120_000);
  const queue = useLive<{ visits: Visit[] }>("/api/operations/arrivals", 10_000);

  // ---------- identification ----------
  const [q, setQ] = useState("");
  const [dob, setDob] = useState("");
  const [matches, setMatches] = useState<Match[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [candidate, setCandidate] = useState<Match | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [patient, setPatient] = useState<Match | null>(null);
  const [creating, setCreating] = useState(false);
  const [np, setNp] = useState(EMPTY_NEW);

  // ---------- visit ----------
  const [doctorId, setDoctorId] = useState("");
  const [serviceIds, setServiceIds] = useState<string[]>([]);
  // One key per intended registration: a retry after a network error is the same request.
  const [key, setKey] = useState(newKey);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [existingId, setExistingId] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState<Visit | null>(null);
  const [cancelReason, setCancelReason] = useState("");

  const doctor = catalog.data?.doctors.find((d) => d.id === doctorId) ?? null;
  const total = useMemo(
    () => (doctor?.services ?? []).filter((s) => serviceIds.includes(s.id)).reduce((sum, s) => sum + s.price, 0),
    [doctor, serviceIds],
  );
  const currency = catalog.data?.clinic.currency ?? "UZS";

  const search = async () => {
    setError(null);
    setSearching(true);
    try {
      const params = new URLSearchParams({ q });
      if (dob) params.set("dob", dob);
      const res = await adminApi.get<{ patients: Match[] }>(`/api/operations/patients?${params}`);
      setMatches(res.patients);
    } catch (e) {
      setError(e instanceof AdminApiError ? e.message : "Qidirib bo‘lmadi");
    } finally {
      setSearching(false);
    }
  };

  const resetForm = () => {
    setPatient(null);
    setCreating(false);
    setNp(EMPTY_NEW);
    setDoctorId("");
    setServiceIds([]);
    setMatches(null);
    setQ("");
    setDob("");
    setKey(newKey());
    setExistingId(null);
  };

  const register = async () => {
    setError(null);
    setExistingId(null);
    setDone(null);
    setSaving(true);
    try {
      const body = {
        key,
        doctorId,
        serviceIds,
        ...(patient
          ? { patientId: patient.id }
          : {
              newPatient: {
                fullName: np.fullName,
                dateOfBirth: np.dateOfBirth,
                sex: np.sex || null,
                phone: np.phone || null,
                documentNumber: np.documentNumber || null,
                pinfl: np.pinfl || null,
              },
            }),
      };
      await adminApi.post<{ visitId: string }>("/api/operations/arrivals", body);
      const name = patient?.fullName ?? np.fullName;
      setDone(
        catalog.data?.clinic.queue_after_payment && total > 0
          ? `${name} ro‘yxatga olindi. Bemorni kassaga yo‘naltiring — navbat raqami to‘lovdan so‘ng beriladi.`
          : `${name} ro‘yxatga olindi va navbatga qo‘shildi.`,
      );
      resetForm();
      await queue.reload();
    } catch (e) {
      if (e instanceof AdminApiError) {
        setError(e.message);
        if (e.code === "patient_exists" && typeof e.details?.patientId === "string") setExistingId(e.details.patientId);
        // A refused request is final: the next attempt is a new request.
        if (e.status < 500) setKey(newKey());
      } else {
        // Network failure: keep the same key so a retry cannot register twice.
        setError("Aloqa uzildi. Qayta bosing — takroriy ro‘yxat yaratilmaydi.");
      }
    } finally {
      setSaving(false);
    }
  };

  const transition = async (v: Visit, status: string, reason?: string) => {
    setError(null);
    try {
      await adminApi.post(`/api/operations/arrivals/${v.id}`, { expected: v.status, status, reason: reason ?? null });
      setCancelling(null);
      setCancelReason("");
      await queue.reload();
    } catch (e) {
      setError(e instanceof AdminApiError ? e.message : "Amalni bajarib bo‘lmadi");
    }
  };

  const canRegister = !!doctorId && serviceIds.length > 0 && (patient !== null || (creating && np.fullName.trim().length >= 2 && !!np.dateOfBirth));

  return (
    <div className="flex flex-col gap-5">
      <PageHeader title="Qabulxona" subtitle="Bemorni aniqlang, shaxsini tasdiqlang va ro‘yxatga oling. To‘lov — kassada." />
      {error && <AError message={error} />}
      {existingId && (
        <div className="-mt-3">
          <AButton
            variant="secondary"
            size="sm"
            onClick={async () => {
              // Open the existing record for confirmation instead of creating a duplicate.
              const res = await adminApi.get<{ patients: Match[] }>(`/api/operations/patients?q=${encodeURIComponent(np.pinfl || np.documentNumber || np.fullName)}${np.dateOfBirth ? `&dob=${np.dateOfBirth}` : ""}`);
              const found = res.patients.find((p) => p.id === existingId) ?? null;
              setMatches(found ? [found] : res.patients);
              setCreating(false);
              setExistingId(null);
            }}
          >
            Mavjud kartani ko‘rish
          </AButton>
        </div>
      )}
      {done && (
        <div role="status" className="rounded-xl border border-pine/25 bg-pine-tint px-4 py-3 text-sm font-medium text-pine-deep">
          {done}
        </div>
      )}

      <div className="grid gap-5 lg:grid-cols-2">
        <Card>
          <p className="mb-3 font-display text-sm font-bold">1. Bemorni aniqlash</p>
          {patient ? (
            <div className="flex items-start justify-between gap-3 rounded-xl bg-pine-tint p-3">
              <div>
                <p className="font-semibold text-pine-deep">{patient.fullName}</p>
                <p className="text-xs text-pine-deep">
                  Karta № {patient.patientNumber} · {patient.dateOfBirth ?? "tug‘ilgan sana yo‘q"}
                </p>
              </div>
              <AButton variant="outline" size="sm" onClick={() => setPatient(null)}>
                O‘zgartirish
              </AButton>
            </div>
          ) : creating ? (
            <div className="grid gap-2 sm:grid-cols-2">
              <label className="text-xs font-medium sm:col-span-2">
                F.I.Sh.*
                <AInput value={np.fullName} onChange={(v) => setNp({ ...np, fullName: v })} aria-label="F.I.Sh." />
              </label>
              <label className="text-xs font-medium">
                Tug‘ilgan sana*
                <AInput type="date" value={np.dateOfBirth} onChange={(v) => setNp({ ...np, dateOfBirth: v })} aria-label="Tug‘ilgan sana" />
              </label>
              <label className="text-xs font-medium">
                Jinsi
                <ASelect
                  value={np.sex}
                  onChange={(v) => setNp({ ...np, sex: v })}
                  aria-label="Jinsi"
                  options={[
                    { value: "", label: "Ko‘rsatilmagan" },
                    { value: "female", label: "Ayol" },
                    { value: "male", label: "Erkak" },
                  ]}
                />
              </label>
              <label className="text-xs font-medium">
                Pasport / ID raqami
                <AInput value={np.documentNumber} onChange={(v) => setNp({ ...np, documentNumber: v })} placeholder="AB1234567" aria-label="Pasport / ID raqami" />
              </label>
              <label className="text-xs font-medium">
                JSHSHIR
                <AInput value={np.pinfl} onChange={(v) => setNp({ ...np, pinfl: v })} placeholder="14 raqam" aria-label="JSHSHIR" />
              </label>
              <label className="text-xs font-medium sm:col-span-2">
                Telefon
                <AInput value={np.phone} onChange={(v) => setNp({ ...np, phone: v })} placeholder="+998 90 123 45 67" aria-label="Telefon" />
              </label>
              <div className="sm:col-span-2">
                <AButton variant="ghost" size="sm" onClick={() => setCreating(false)}>
                  Bekor qilish — qidiruvga qaytish
                </AButton>
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              <div className="grid gap-2 sm:grid-cols-[1fr_11rem_auto]">
                <AInput value={q} onChange={setQ} placeholder="Karta №, JSHSHIR, pasport, telefon yoki F.I.Sh." aria-label="Bemorni qidirish" />
                <AInput type="date" value={dob} onChange={setDob} aria-label="Tug‘ilgan sana (ixtiyoriy)" />
                <AButton onClick={search} loading={searching} disabled={q.trim().length < 2}>
                  <Search className="h-4 w-4" /> Qidirish
                </AButton>
              </div>
              {matches && matches.length === 0 && <p className="text-sm text-ink-muted">Topilmadi.</p>}
              {matches?.map((m) => (
                <div key={m.id} className="flex items-center justify-between gap-3 rounded-xl border border-hairline p-3">
                  <div className="text-sm">
                    <p className="font-semibold">{m.fullName ?? "—"}</p>
                    <p className="text-xs text-ink-muted">
                      Karta № {m.patientNumber} · {m.dateOfBirth ?? "—"} · hujjat {m.documentHint ?? "—"} · tel. {m.phoneHint ?? "—"}
                    </p>
                  </div>
                  <AButton
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setCandidate(m);
                      setConfirmed(false);
                    }}
                  >
                    Tanlash
                  </AButton>
                </div>
              ))}
              <AButton variant="secondary" onClick={() => setCreating(true)}>
                <UserPlus className="h-4 w-4" /> Yangi bemor
              </AButton>
            </div>
          )}
        </Card>

        <Card>
          <p className="mb-3 font-display text-sm font-bold">2. Shifokor va xizmatlar</p>
          <ASelect
            value={doctorId}
            onChange={(v) => {
              setDoctorId(v);
              setServiceIds([]);
            }}
            aria-label="Shifokor"
            options={[{ value: "", label: "Shifokorni tanlang" }, ...(catalog.data?.doctors ?? []).map((d) => ({ value: d.id, label: d.title ? `${d.name} — ${d.title}` : d.name }))]}
          />
          <div className="mt-3 flex flex-col gap-1.5" role="group" aria-label="Xizmatlar">
            {(doctor?.services ?? []).map((s) => (
              <label key={s.id} className="flex items-center justify-between gap-3 rounded-lg border border-hairline px-3 py-2 text-sm">
                <span className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={serviceIds.includes(s.id)}
                    onChange={(e) => setServiceIds(e.target.checked ? [...serviceIds, s.id] : serviceIds.filter((x) => x !== s.id))}
                  />
                  {s.name}
                </span>
                <span className="font-numeric text-xs text-ink-muted">{money(s.price, currency)}</span>
              </label>
            ))}
          </div>
          <div className="mt-4 flex items-center justify-between gap-3">
            <p className="text-sm">
              Jami: <span className="font-numeric font-semibold">{money(total, currency)}</span>
              <span className="block text-[11px] text-ink-muted">Yakuniy narxni server hisoblaydi.</span>
            </p>
            <AButton onClick={register} loading={saving} disabled={!canRegister}>
              <UserCheck className="h-4 w-4" /> Ro‘yxatga olish
            </AButton>
          </div>
        </Card>
      </div>

      <Card>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <p className="font-display text-sm font-bold">Jonli navbat</p>
          <span className={`text-xs ${queue.stale ? "font-semibold text-danger" : "text-ink-muted"}`}>{freshnessLabel(queue.updatedAt, queue.stale)}</span>
        </div>
        {!queue.data ? (
          <p className="text-sm text-ink-muted">{queue.error ?? "Yuklanmoqda…"}</p>
        ) : queue.data.visits.length === 0 ? (
          <AEmpty title="Navbat bo‘sh" icon={<Users className="h-6 w-6" />} />
        ) : (
          <ATable headers={["№", "Bemor", "Shifokor", "Holat", "Qarz", ""]}>
            {queue.data.visits.map((v) => (
              <tr key={v.id}>
                <td className="px-4 py-3 font-numeric text-lg font-bold">{v.queueNumber ?? "—"}</td>
                <td className="px-4 py-3">
                  <p className="font-medium">{v.patient.fullName}</p>
                  <p className="text-xs text-ink-muted">Karta № {v.patient.patientNumber}</p>
                </td>
                <td className="px-4 py-3">{v.doctor.name}</td>
                <td className="px-4 py-3">
                  <ABadge tone={VISIT_STATUS[v.status]?.tone}>{VISIT_STATUS[v.status]?.label ?? v.status}</ABadge>
                </td>
                <td className="px-4 py-3 font-numeric">{v.balance.outstanding > 0 ? money(v.balance.outstanding, currency) : "—"}</td>
                <td className="px-4 py-3">
                  <div className="flex flex-wrap justify-end gap-1.5">
                    {v.status === "waiting" && (
                      <AButton size="sm" variant="secondary" onClick={() => transition(v, "called")}>
                        Chaqirish
                      </AButton>
                    )}
                    {v.status === "called" && (
                      <AButton size="sm" variant="outline" onClick={() => transition(v, "waiting")}>
                        Navbatga qaytarish
                      </AButton>
                    )}
                    {["awaiting_payment", "waiting", "called"].includes(v.status) && (
                      <AButton size="sm" variant="ghost" onClick={() => setCancelling(v)}>
                        Bekor qilish
                      </AButton>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </ATable>
        )}
      </Card>

      {candidate && (
        <AModal
          title="Shaxsini tasdiqlang"
          onClose={() => setCandidate(null)}
          footer={
            <>
              <AButton variant="outline" onClick={() => setCandidate(null)}>
                Yo‘q, boshqa odam
              </AButton>
              <AButton
                disabled={!confirmed}
                onClick={() => {
                  setPatient(candidate);
                  setCandidate(null);
                  setMatches(null);
                }}
              >
                Tanlash
              </AButton>
            </>
          }
        >
          <div className="text-sm">
            <p className="text-lg font-semibold">{candidate.fullName}</p>
            <p>Tug‘ilgan sana: {candidate.dateOfBirth ?? "—"}</p>
            <p>Hujjat: {candidate.documentHint ?? "—"} · Telefon: {candidate.phoneHint ?? "—"}</p>
            <p className="text-ink-muted">Karta № {candidate.patientNumber}</p>
          </div>
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
            Bemorning hujjati va tug‘ilgan sanasini tekshirdim — bu shu odam (Shaxsi tasdiqlandi)
          </label>
        </AModal>
      )}

      {cancelling && (
        <AModal
          title="Tashrifni bekor qilish"
          onClose={() => setCancelling(null)}
          footer={
            <>
              <AButton variant="outline" onClick={() => setCancelling(null)}>
                Yopish
              </AButton>
              <AButton variant="danger" disabled={cancelReason.trim().length < 3} onClick={() => transition(cancelling, "cancelled", cancelReason)}>
                Bekor qilish
              </AButton>
            </>
          }
        >
          <p className="text-sm">
            {cancelling.patient.fullName} — {cancelling.doctor.name}. To‘langan pul bo‘lsa, avval kassada qaytariladi.
          </p>
          <AInput value={cancelReason} onChange={setCancelReason} placeholder="Sabab" aria-label="Bekor qilish sababi" />
        </AModal>
      )}
    </div>
  );
}

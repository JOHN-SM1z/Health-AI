"use client";

import { useMemo, useState } from "react";
import { PageHeader, Card, ABadge, ATable, AEmpty, AError, AButton, AModal, AInput, ASelect } from "@/components/admin/ui";
import { adminApi, AdminApiError, formatTime } from "@/lib/admin/client";
import { freshnessLabel, money, useLive, VISIT_STATUS } from "@/components/operations/use-live";
import { FollowQr } from "@/components/operations/follow-qr";
import { classifyQuery, isIdentityDocument, parseDob } from "@/lib/operations/identity-query";
import { Search, UserCheck, UserPlus, Users } from "lucide-react";

/**
 * Reception (outpatient pilot). The owner's walk-in flow (2026-10-08): type
 * the passport/ID number or JSHSHIR and the date of birth (dd.mm.yyyy) — the
 * patient's card opens at once; no card → the new-patient form opens with
 * them filled in. A patient without a document is found by name, phone or
 * card number and taken with "Hujjat yo‘q — davom etish": care is never held
 * up by identity. A typed document is a lookup key, not verification. Staff see
 * the name, phone and card number only: passport/ID, JSHSHIR and date of birth
 * are compared on the server and never shown (owner decision 2026-10-08). Then the doctor or laboratory and the services;
 * the server prices them and creates the bill; the patient pays at the kassa,
 * which issues the queue number. Reception never takes money.
 */

/** What the server returns for a card: no passport/ID, JSHSHIR or date of birth (they are compared on the server). */
type Match = {
  id: string;
  patientNumber: number;
  fullName: string | null;
  phone: string | null;
  /** The date of birth typed at the desk was checked on the server and matches. */
  dobMatches: boolean | null;
};
type SearchResult = { patients: Match[]; exact: boolean; dobMismatch: boolean };
type Catalog = {
  clinic: { currency: string; operating_mode: string; queue_after_payment: boolean };
  doctors: Array<{ id: string; name: string; title: string | null; services: Array<{ id: string; name: string; price: number }> }>;
  lab: { tests: Array<{ id: string; name: string; price: number }>; panels: Array<{ id: string; name: string; price: number }> };
};
/** The reception's "doctor" choice for a laboratory walk-in. */
const LAB = "__lab__";
type Visit = {
  id: string;
  status: string;
  queueNumber: number | null;
  queueDate: string | null;
  arrivedAt: string;
  patient: { id: string; patientNumber: number; fullName: string | null };
  kind: "doctor" | "lab";
  doctor: { id: string; name: string } | null;
  balance: { charged: number; outstanding: number };
};

const newKey = () => crypto.randomUUID();
/** Today in the browser (the desk's own day) — dates of birth cannot be later. */
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const EMPTY_NEW = { fullName: "", dateOfBirth: "", sex: "", phone: "", documentNumber: "", pinfl: "" };

export default function ReceptionPage() {
  const catalog = useLive<Catalog>("/api/operations/catalog", 120_000);
  const queue = useLive<{ visits: Visit[] }>("/api/operations/arrivals", 10_000);
  // Paid online for today, not here yet (20261008000012): "Keldi" puts them in their doctor's queue.
  const booked = useLive<{ visits: Array<{ id: string; queueNumber: number; slotAt: string | null; patient: { fullName: string | null; patientNumber: number }; doctor: { name: string } | null }> }>(
    "/api/operations/booked",
    30_000,
  );
  const markArrived = async (visitId: string) => {
    try {
      await adminApi.post(`/api/operations/booked/${visitId}`, {});
      await Promise.all([booked.reload(), queue.reload()]);
    } catch (e) {
      setError(e instanceof AdminApiError ? e.message : "Belgilab bo‘lmadi");
    }
  };

  // ---------- identification ----------
  const [q, setQ] = useState("");
  const [dob, setDob] = useState("");
  const [matches, setMatches] = useState<Match[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [patient, setPatient] = useState<Match | null>(null);
  // How the card was taken: by document + date of birth, or without a document.
  const [foundBy, setFoundBy] = useState<"document" | "no_document">("document");
  const [creating, setCreating] = useState(false);
  const [np, setNp] = useState(EMPTY_NEW);

  // ---------- visit ----------
  const [doctorId, setDoctorId] = useState("");
  const [serviceIds, setServiceIds] = useState<string[]>([]);
  const [panelIds, setPanelIds] = useState<string[]>([]);
  const [smsConsent, setSmsConsent] = useState(false);
  // One key per intended registration: a retry after a network error is the same request.
  const [key, setKey] = useState(newKey);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [existingId, setExistingId] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState<Visit | null>(null);
  const [qrFor, setQrFor] = useState<Visit | null>(null);
  const [cancelReason, setCancelReason] = useState("");

  const isLab = doctorId === LAB;
  const doctor = catalog.data?.doctors.find((d) => d.id === doctorId) ?? null;
  // For a lab walk-in the "services" are lab tests (serviceIds) and panels (panelIds).
  const options = useMemo(() => (isLab ? (catalog.data?.lab.tests ?? []) : (doctor?.services ?? [])), [isLab, catalog.data, doctor]);
  const total = useMemo(
    () =>
      options.filter((s) => serviceIds.includes(s.id)).reduce((sum, s) => sum + s.price, 0) +
      (isLab ? (catalog.data?.lab.panels ?? []).filter((p) => panelIds.includes(p.id)).reduce((sum, p) => sum + p.price, 0) : 0),
    [options, serviceIds, isLab, catalog.data, panelIds],
  );
  const currency = catalog.data?.clinic.currency ?? "UZS";

  const choose = (m: Match, by: "document" | "no_document") => {
    setPatient(m);
    setFoundBy(by);
    setMatches(null);
    setNotice(null);
  };

  const find = async (text: string, dobText: string) => {
    setError(null);
    setNotice(null);
    const term = classifyQuery(text);
    const dobIso = dobText.trim() ? parseDob(dobText, today()) : null;
    if (dobText.trim() && !dobIso) {
      setError("Tug‘ilgan sanani kk.oo.yyyy ko‘rinishida kiriting (masalan, 21.09.1988)");
      return;
    }
    if (isIdentityDocument(term) && !dobIso) {
      setError("Pasport yoki JSHSHIR bilan birga tug‘ilgan sanani ham kiriting");
      return;
    }
    setSearching(true);
    try {
      const params = new URLSearchParams({ q: text });
      if (dobIso) params.set("dob", dobIso);
      const res = await adminApi.get<SearchResult>(`/api/operations/patients?${params}`);
      if (res.exact) {
        // Passport/JSHSHIR and date of birth match one card: it opens at once.
        choose(res.patients[0], "document");
      } else if (res.dobMismatch) {
        setMatches([]);
        setNotice("Bu hujjat bilan karta bor, lekin tug‘ilgan sana mos emas — sanani bemordan qayta so‘rang.");
      } else if (isIdentityDocument(term) && res.patients.length === 0) {
        // No card yet: start one with what was typed.
        setMatches(null);
        setCreating(true);
        setNp({
          ...EMPTY_NEW,
          documentNumber: term.kind === "document" ? term.value : "",
          pinfl: term.kind === "pinfl" ? term.value : "",
          dateOfBirth: dobText.trim(),
        });
        setNotice("Bu hujjat bilan karta yo‘q — yangi bemorning F.I.Sh.ini kiriting. Hujjat va tug‘ilgan sana kartada saqlanadi, lekin xodimlarga ko‘rsatilmaydi.");
      } else {
        setMatches(res.patients);
      }
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
    setPanelIds([]);
    setSmsConsent(false);
    setMatches(null);
    setNotice(null);
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
      const who = patient
        ? { patientId: patient.id }
        : {
            newPatient: {
              fullName: np.fullName,
              dateOfBirth: parseDob(np.dateOfBirth, today()),
              sex: np.sex || null,
              phone: np.phone || null,
              documentNumber: np.documentNumber || null,
              pinfl: np.pinfl || null,
            },
          };
      // A lab walk-in: tests (and panels) on the visit's bill; otherwise a doctor and services.
      if (isLab) await adminApi.post<{ visitId: string }>("/api/operations/lab-arrivals", { key, testIds: serviceIds, panelIds, smsConsent, ...who });
      else await adminApi.post<{ visitId: string }>("/api/operations/arrivals", { key, doctorId, serviceIds, smsConsent, ...who });
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

  const newDob = parseDob(np.dateOfBirth, today());
  const canRegister = !!doctorId && serviceIds.length + panelIds.length > 0 && (patient !== null || (creating && np.fullName.trim().length >= 2 && !!newDob));

  return (
    <div className="flex flex-col gap-5">
      <PageHeader title="Qabulxona" subtitle="Pasport yoki JSHSHIR va tug‘ilgan sana bilan bemorni toping va ro‘yxatga oling. To‘lov — kassada." />
      {error && <AError message={error} />}
      {existingId && (
        <div className="-mt-3">
          <AButton
            variant="secondary"
            size="sm"
            onClick={async () => {
              // Open the existing card instead of creating a duplicate.
              setCreating(false);
              setExistingId(null);
              await find(np.pinfl || np.documentNumber || np.fullName, np.dateOfBirth);
            }}
          >
            Mavjud kartani ko‘rish
          </AButton>
        </div>
      )}
      {notice && (
        <div role="status" className="rounded-xl border border-hairline bg-surface-2 px-4 py-3 text-sm">
          {notice}
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
                  Karta № {patient.patientNumber} · tel. {patient.phone ?? "—"}
                  {patient.dobMatches ? " · tug‘ilgan sana mos" : ""}
                </p>
                <p className="mt-1 text-[11px] text-pine-deep">
                  {foundBy === "document" ? "Hujjat va tug‘ilgan sana bo‘yicha topildi" : "Hujjatsiz tanlandi"}
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
                <AInput value={np.dateOfBirth} onChange={(v) => setNp({ ...np, dateOfBirth: v })} placeholder="kk.oo.yyyy" aria-label="Tug‘ilgan sana" />
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
                <AButton
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setCreating(false);
                    setNotice(null);
                  }}
                >
                  Bekor qilish — qidiruvga qaytish
                </AButton>
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              <form
                className="grid gap-2 sm:grid-cols-[1fr_9rem_auto]"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (q.trim().length >= 2) void find(q, dob);
                }}
              >
                <AInput value={q} onChange={setQ} placeholder="Pasport (AB1234567) yoki JSHSHIR" aria-label="Bemorni qidirish" />
                <AInput value={dob} onChange={setDob} placeholder="kk.oo.yyyy" aria-label="Tug‘ilgan sana (kk.oo.yyyy)" />
                <AButton type="submit" loading={searching} disabled={q.trim().length < 2}>
                  <Search className="h-4 w-4" /> Topish
                </AButton>
              </form>
              <p className="text-[11px] text-ink-muted">
                Hujjati yo‘q bemorni F.I.Sh., telefon yoki karta raqami bilan toping. Tug‘ilgan sanani so‘rab kiriting — tizim uni o‘zi tekshiradi
                (xodimlarga ko‘rsatilmaydi).
              </p>
              {matches && matches.length === 0 && !notice && <p className="text-sm text-ink-muted">Topilmadi.</p>}
              {matches?.map((m) => (
                <div key={m.id} className="flex items-center justify-between gap-3 rounded-xl border border-hairline p-3">
                  <div className="text-sm">
                    <p className="font-semibold">{m.fullName ?? "—"}</p>
                    <p className="text-xs text-ink-muted">
                      Karta № {m.patientNumber} · tel. {m.phone ?? "—"}
                      {m.dobMatches ? " · tug‘ilgan sana mos" : ""}
                    </p>
                  </div>
                  <AButton variant="outline" size="sm" onClick={() => choose(m, "no_document")}>
                    Hujjat yo‘q — davom etish
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
          <p className="mb-3 font-display text-sm font-bold">2. Shifokor yoki laboratoriya</p>
          <ASelect
            value={doctorId}
            onChange={(v) => {
              setDoctorId(v);
              setServiceIds([]);
              setPanelIds([]);
            }}
            aria-label="Shifokor"
            options={[
              { value: "", label: "Shifokorni tanlang" },
              ...(catalog.data?.doctors ?? []).map((d) => ({ value: d.id, label: d.title ? `${d.name} — ${d.title}` : d.name })),
              ...((catalog.data?.lab.tests.length ?? 0) > 0 ? [{ value: LAB, label: "Laboratoriya — tahlil topshirish" }] : []),
            ]}
          />
          {isLab && (catalog.data?.lab.panels.length ?? 0) > 0 && (
            <div className="mt-3 flex flex-col gap-1.5" role="group" aria-label="Panellar">
              {catalog.data!.lab.panels.map((p) => (
                <label key={p.id} className="flex items-center justify-between gap-3 rounded-lg border border-hairline px-3 py-2 text-sm">
                  <span className="flex items-center gap-2">
                    <input type="checkbox" checked={panelIds.includes(p.id)} onChange={(e) => setPanelIds(e.target.checked ? [...panelIds, p.id] : panelIds.filter((x) => x !== p.id))} />
                    {p.name} <span className="text-xs text-ink-muted">(panel)</span>
                  </span>
                  <span className="font-numeric text-xs text-ink-muted">{money(p.price, currency)}</span>
                </label>
              ))}
            </div>
          )}
          <div className="mt-3 flex flex-col gap-1.5" role="group" aria-label={isLab ? "Tahlillar" : "Xizmatlar"}>
            {options.map((s) => (
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
          <label className="mt-3 flex items-start gap-2 text-sm">
            <input type="checkbox" checked={smsConsent} onChange={(e) => setSmsConsent(e.target.checked)} aria-label="SMS roziligi" />
            <span>
              Telegrami yo‘q bo‘lsa, navbat raqami va chaqiruvni SMS orqali yuborish (bemor rozi)
              <span className="block text-[11px] text-ink-muted">SMSda faqat klinika nomi va navbat raqami bo‘ladi.</span>
            </span>
          </label>
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

      {booked.data && booked.data.visits.length > 0 && (
        <Card>
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <p className="font-display text-sm font-bold">Bugun onlayn to‘laganlar — kelishini belgilang</p>
            <span className="text-xs text-ink-muted">Shifokor ularni yozilgan vaqtida qabul qiladi</span>
          </div>
          <ATable headers={["№", "Bemor", "Shifokor", "Vaqt", ""]}>
            {booked.data.visits.map((v) => (
              <tr key={v.id}>
                <td className="px-4 py-3 font-numeric text-lg font-bold">{v.queueNumber}</td>
                <td className="px-4 py-3">
                  <p className="font-medium">{v.patient.fullName}</p>
                  <p className="text-xs text-ink-muted">Karta № {v.patient.patientNumber}</p>
                </td>
                <td className="px-4 py-3">{v.doctor?.name}</td>
                <td className="px-4 py-3 font-numeric">{v.slotAt ? formatTime(v.slotAt) : "—"}</td>
                <td className="px-4 py-3 text-right">
                  <AButton size="sm" onClick={() => markArrived(v.id)}>
                    Keldi
                  </AButton>
                </td>
              </tr>
            ))}
          </ATable>
        </Card>
      )}

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
                <td className="px-4 py-3">{v.kind === "lab" ? "Laboratoriya" : v.doctor?.name}</td>
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
                    {v.queueNumber !== null && ["waiting", "called"].includes(v.status) && (
                      <AButton size="sm" variant="outline" onClick={() => setQrFor(v)}>
                        Telegram QR
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

      {qrFor && (
        <AModal title={`Navbat № ${qrFor.queueNumber} — Telegramda kuzatish`} onClose={() => setQrFor(null)}>
          <FollowQr visitId={qrFor.id} auto />
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
            {cancelling.patient.fullName} — {cancelling.kind === "lab" ? "Laboratoriya" : cancelling.doctor?.name}. To‘langan pul bo‘lsa, avval kassada qaytariladi.
          </p>
          <AInput value={cancelReason} onChange={setCancelReason} placeholder="Sabab" aria-label="Bekor qilish sababi" />
        </AModal>
      )}
    </div>
  );
}

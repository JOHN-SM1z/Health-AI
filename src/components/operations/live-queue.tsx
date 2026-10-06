"use client";
import { useCallback, useEffect, useState, useRef } from "react";
import Link from "next/link";
import { AButton, AEmpty, AError, AInput, AModal, ASelect, Card, LoadingRow, PageHeader, ABadge } from "@/components/admin/ui";
import { adminApi } from "@/lib/admin/client";

type Patient = { id: string; full_name: string | null; phone: string | null; patient_number: number };
type Visit = { id: string; status: string; queue_number: number; queue_date: string; patient_id: string; arrived_at: string; patients: Patient; doctors: { name: string }; services: { name: string }; payments: { id: string; amount: number; currency: string; status: string } | null };
type Doctor = { id: string; name: string; doctor_services: { service_id: string }[] };
type Service = { id: string; name: string; price: number };
const labels: Record<string, string> = { waiting: "Kutilmoqda", called: "Chaqirildi", in_progress: "Qabulda", completed: "Yakunlangan", cancelled: "Bekor qilingan" };

export function LiveQueue({ doctor = false }: { doctor?: boolean }) {
  const [visits, setVisits] = useState<Visit[] | null>(null);
  const [error, setError] = useState("");
  const [updated, setUpdated] = useState("");
  const [date, setDate] = useState("");
  const [busy, setBusy] = useState("");
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("active");
  const [page,setPage]=useState(0);const [total,setTotal]=useState(0);const loadSequence=useRef(0);
  const load = useCallback(async () => {
    const sequence=++loadSequence.current;
    try {
      const result = await adminApi.get<{ visits: Visit[]; total:number; date: string; refreshedAt: string; timezone: string }>(`/api/operations/visits?page=${page}&filter=${filter}${doctor?"&scope=mine":""}`);
      if(sequence!==loadSequence.current)return;
      setTotal(result.total);
      setVisits(result.visits); setDate(result.date); setUpdated(new Date(result.refreshedAt).toLocaleTimeString("uz-UZ", { timeZone: result.timezone, hour: "2-digit", minute: "2-digit" })); setError("");
    } catch { if(sequence!==loadSequence.current)return; setError("Navbat yangilanmadi. Oxirgi ma’lumot eskirgan bo‘lishi mumkin. Yangilashni bosing."); }
  }, [page,filter,doctor]);
  useEffect(() => { void load(); const timer = setInterval(() => void load(), 20000); return () => clearInterval(timer); }, [load]);
  async function change(v: Visit, status: string) {
    setBusy(v.id);
    try { await adminApi.patch("/api/operations/visits", { id: v.id, expectedStatus: v.status, status }); await load(); }
    catch (e) { setError(e instanceof Error ? e.message : "Amal bajarilmadi"); }
    finally { setBusy(""); }
  }
  const visible = visits?.filter(v => filter === "all" || !["completed", "cancelled"].includes(v.status));
  return <div>
    <PageHeader title={doctor ? "Mening navbatim" : "Registratsiya va jonli navbat"} subtitle={`${date || "Bugun"} · ${updated ? `Oxirgi yangilanish ${updated}` : "Yuklanmoqda"}`} action={<div className="flex gap-2"><AButton variant="outline" onClick={() => void load()}>Yangilash</AButton>{!doctor && <AButton onClick={() => setOpen(true)}>Bemorni ro‘yxatdan o‘tkazish</AButton>}</div>} />
    {error && <AError message={error} />}
    <div className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-hairline bg-surface p-4">
      <p className="text-sm text-ink-muted">{doctor ? "Bemor tarixi va yo‘llanmalar qabul davomida ochiladi." : "Kelgan bemorni toping, xizmatni tanlang va talon bering. Oldindan vaqt belgilash shart emas."}</p>
      <div className="w-44"><ASelect aria-label="Navbat filtri" value={filter} onChange={value=>{setFilter(value);setPage(0);}} options={[{ value: "active", label: "Faol navbat" }, { value: "all", label: "Bugungi barcha" }]} /></div>
    </div>
    {visits === null ? <Card>{error ? <p>Ma’lumot mavjud emas.</p> : <LoadingRow />}</Card> : visible?.length === 0 ? <Card><AEmpty title="Navbat bo‘sh" subtitle={doctor ? "Sizga yo‘naltirilgan bemorlar shu yerda chiqadi." : "Kelgan bemorni ro‘yxatdan o‘tkazing."} /></Card> : <div className="space-y-3">{visible?.map(v => <Card key={v.id} className="flex flex-wrap items-center gap-4">
      <div className="flex min-w-20 flex-col border-r border-hairline pr-4"><span className="text-xs text-ink-muted">Talon{v.queue_date !== date ? ` · ${v.queue_date}` : ""}</span><strong className="font-numeric text-3xl text-pine">{v.queue_number.toString().padStart(3, "0")}</strong></div>
      <div className="min-w-40 flex-1"><p className="font-semibold">{v.patients.full_name}</p><p className="text-xs text-ink-muted">Bemor №{v.patients.patient_number} · {v.services.name}</p><p className="text-xs text-ink-muted">{v.doctors.name}</p></div>
      <div><ABadge tone={v.status === "completed" ? "green" : "gray"}>{labels[v.status]}</ABadge><p className="mt-1 text-xs text-ink-muted">{v.payments?.status === "paid" ? "To‘langan" : v.payments?.status === "refunded" ? "Qaytarilgan" : v.payments?.status === "voided" ? "Hisob bekor qilingan" : "To‘lov kutilmoqda"}</p></div>
      <div className="flex flex-wrap gap-2">
        {doctor && <Link className="rounded-lg border border-hairline px-3 py-2 text-sm text-pine" href={`/doctor/patients/${v.patient_id}?visit=${v.id}`}>Bemor tarixi</Link>}
        {!error && v.status === "waiting" && <AButton size="sm" loading={busy === v.id} onClick={() => void change(v, "called")}>Chaqirish</AButton>}
        {!error && doctor && ["waiting", "called"].includes(v.status) && <AButton size="sm" loading={busy === v.id} onClick={() => void change(v, "in_progress")}>Qabulni boshlash</AButton>}
        {!error && doctor && v.status === "in_progress" && <AButton size="sm" loading={busy === v.id} onClick={() => void change(v, "completed")}>Yakunlash</AButton>}
        {!doctor && ["waiting", "called"].includes(v.status) && !error && <AButton variant="ghost" size="sm" loading={busy === v.id} onClick={() => void change(v, "cancelled")}>Navbatdan chiqarish</AButton>}
      </div>
    </Card>)}</div>}
    {(total>100||page>0)&&<div className="my-4 flex items-center gap-3"><AButton variant="outline" disabled={page===0} onClick={()=>setPage(page-1)}>Oldingi</AButton><span className="text-sm">{page+1}-sahifa · jami {total}</span><AButton variant="outline" disabled={(page+1)*100>=total} onClick={()=>setPage(page+1)}>Keyingi</AButton></div>}
    {open && <ArrivalForm onClose={() => setOpen(false)} onSaved={async () => { await load(); }} />}
  </div>;
}

function ArrivalForm({ onClose, onSaved }: { onClose: () => void; onSaved: () => Promise<void> }) {
  const [key] = useState(() => crypto.randomUUID());
  const [q, setQ] = useState(""); const [patients, setPatients] = useState<Patient[]>([]); const [patient, setPatient] = useState<Patient | null>(null);
  const [isNew, setNew] = useState(false); const [name, setName] = useState(""); const [phone, setPhone] = useState("");
  const [doctors, setDoctors] = useState<Doctor[]>([]); const [services, setServices] = useState<Service[]>([]);
  const [doctorId, setDoctor] = useState(""); const [serviceId, setService] = useState("");
  const [busy, setBusy] = useState(false); const [error, setError] = useState(""); const [ticket, setTicket] = useState<{ queue_number: number; queue_date: string } | null>(null);
  useEffect(() => { adminApi.get<{ doctors: Doctor[]; services: Service[] }>("/api/operations/catalog").then(v => { setDoctors(v.doctors); setServices(v.services); }).catch(() => setError("Xizmatlar yuklanmadi")); }, []);
  useEffect(() => { let active = true; const timer = setTimeout(() => { if (q.trim().length < 2 && !/^\d$/.test(q.trim())) { setPatients([]); return; } adminApi.get<{ patients: Patient[] }>(`/api/operations/patients?q=${encodeURIComponent(q)}`).then(r => { if (active) setPatients(r.patients); }).catch(() => { if (active) setError("Bemorlarni qidirib bo‘lmadi"); }); }, 250); return () => { active = false; clearTimeout(timer); }; }, [q]);
  const offered = doctors.find(d => d.id === doctorId)?.doctor_services ?? [];
  const options = services.filter(s => offered.length === 0 || offered.some(o => o.service_id === s.id));
  async function save() {
    setBusy(true); setError("");
    try { const result = await adminApi.post<{ visit: { queue_number: number; queue_date: string } }>("/api/operations/visits", { ...(isNew ? { patientName: name.trim(), ...(phone.trim() ? { phone: phone.trim() } : {}) } : { patientId: patient?.id }), doctorId, serviceId, idempotencyKey: key }); setTicket(result.visit); await onSaved(); }
    catch (e) { setError(e instanceof Error ? e.message : "Saqlanmadi. Shu shaklda qayta urinib ko‘ring."); }
    finally { setBusy(false); }
  }
  return <AModal title={ticket ? "Bemor navbatga qo‘shildi" : "Bemorni ro‘yxatdan o‘tkazish"} onClose={() => { if (!busy) onClose(); }} footer={ticket ? <><AButton variant="outline" onClick={() => window.print()}>Talonni chop etish</AButton><AButton onClick={onClose}>Tayyor</AButton></> : <AButton loading={busy} disabled={!doctorId || !serviceId || (isNew ? name.trim().length < 2 : !patient)} onClick={() => void save()}>Ro‘yxatdan o‘tkazish</AButton>}>
    {error && <AError message={error} />}
    {ticket ? <div className="print-ticket text-center"><p>{ticket.queue_date}</p><p className="my-4 font-numeric text-6xl font-bold">{String(ticket.queue_number).padStart(3, "0")}</p><p>{isNew ? name : patient?.full_name}</p><p>{doctors.find(d => d.id === doctorId)?.name}</p><p>{services.find(s => s.id === serviceId)?.name}</p><p className="mt-3 text-xs text-ink-muted">Talon — to‘lov cheki emas. Kassa orqali to‘lovni tekshiring.</p></div> : <fieldset disabled={busy} className="space-y-4">
      <div className="flex gap-2"><AButton variant={!isNew ? "primary" : "outline"} onClick={() => setNew(false)}>Avval kelgan</AButton><AButton variant={isNew ? "primary" : "outline"} onClick={() => setNew(true)}>Yangi bemor</AButton></div>
      {isNew ? <><label className="block text-sm">Ism va familiya<AInput value={name} onChange={setName} autoComplete="off" /></label><label className="block text-sm">Telefon (ixtiyoriy)<AInput value={phone} onChange={setPhone} type="tel" /></label><p className="text-xs text-ink-muted">Takroriy karta ochmaslik uchun avval bemorni qidiring.</p></> : <><AInput value={q} onChange={v => { setQ(v); setPatient(null); }} placeholder="Bemor raqami, ism yoki telefon" aria-label="Bemorni qidirish" />{patients.map(p => <button key={p.id} className={`block w-full rounded-lg border p-3 text-left text-sm ${patient?.id === p.id ? "border-pine bg-pine-tint" : "border-hairline"}`} onClick={() => setPatient(p)}>{p.full_name} · №{p.patient_number}<span className="block text-xs text-ink-muted">{p.phone || "Telefon kiritilmagan"}</span></button>)}{patient && <p className="text-sm font-medium">Tanlandi: {patient.full_name}, №{patient.patient_number}. Bemor bilan ma’lumotni tekshiring.</p>}</>}
      <label className="block text-sm">Shifokor<ASelect value={doctorId} onChange={v => { setDoctor(v); setService(""); }} options={[{ value: "", label: "Tanlang" }, ...doctors.map(d => ({ value: d.id, label: d.name }))]} /></label>
      <label className="block text-sm">Xizmat<ASelect value={serviceId} onChange={setService} options={[{ value: "", label: "Tanlang" }, ...options.map(s => ({ value: s.id, label: s.name }))]} /></label>
      <p className="text-xs text-ink-muted">Yakuniy narx shifokor va xizmat sozlamalaridan kassaga uzatiladi.</p>
    </fieldset>}
  </AModal>;
}

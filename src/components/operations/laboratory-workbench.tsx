"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { adminApi, formatDateTime } from "@/lib/admin/client";
import { AButton, AError, AInput, Card, LoadingRow, PageHeader } from "@/components/admin/ui";
import { specimenLabels, type LabCommand, type LabDetail, type LabDraft, type LabSummary, type LabTest } from "@/lib/laboratory/contracts";

const endpoint = "/api/doctor/laboratory";
const message = (error: unknown) => error instanceof Error ? error.message : "Ma’lumot yuklanmadi";

export function LaboratoryWorkbench() {
  const params = useSearchParams();
  const patientId = params.get("patientId");
  const [orders, setOrders] = useState<LabSummary[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<LabDetail | null>(null);
  const [page, setPage] = useState(0);
  const [hasNext, setHasNext] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [patient, setPatient] = useState<{ full_name: string; patient_number: number } | null>(null);
  const [tests, setTests] = useState("");
  const [specimen, setSpecimen] = useState("");
  const [reason, setReason] = useState("");
  const retry = useRef<{ fingerprint: string; key: string } | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true); setError(""); setDetail(null);
    const load = async () => {
      try {
        if (selected) {
          const data = await adminApi.get<LabDetail>(`${endpoint}?orderId=${selected}`);
          if (active) setDetail(data);
        } else {
          const data = await adminApi.get<{ orders: LabSummary[] }>(`${endpoint}?page=${page}`);
          if (active) { setOrders(data.orders.slice(0, 50)); setHasNext(data.orders.length > 50); }
        }
      } catch (e) { if (active) { setError(message(e)); setOrders([]); } }
      finally { if (active) setLoading(false); }
    };
    void load();
    return () => { active = false; };
  }, [selected, page, refresh]);

  useEffect(() => {
    let active = true;
    setPatient(null);
    if (patientId) void adminApi.get<{ patient: { full_name: string; patient_number: number } }>(`/api/doctor/patients/${patientId}`)
      .then(data => { if (active) setPatient(data.patient); })
      .catch(e => { if (active) setError(message(e)); });
    return () => { active = false; };
  }, [patientId]);

  const send = useCallback(async (command: LabCommand) => {
    setBusy(true); setError(""); setNotice("");
    try {
      const result = await adminApi.post<{ id: string }>(endpoint, command);
      setNotice("Saqlandi. Natijalar hali tasdiqlanmagan.");
      setSelected(result.id); setReason(""); setRefresh(v => v + 1);
      return true;
    } catch (e) { setError(message(e)); return false; }
    finally { setBusy(false); }
  }, []);

  async function create() {
    if (!patientId || !patient) return;
    const names = tests.split("\n").map(v => v.trim()).filter(Boolean);
    const fingerprint = JSON.stringify([patientId, specimen.trim(), names]);
    if (retry.current?.fingerprint !== fingerprint) retry.current = { fingerprint, key: crypto.randomUUID() };
    if (await send({ action: "create", patientId, specimenType: specimen.trim(), tests: names, idempotencyKey: retry.current.key })) {
      retry.current = null; setTests(""); setSpecimen("");
    }
  }

  return <div className="mx-auto max-w-6xl space-y-5">
    <PageHeader title="Laboratoriya ish stoli" subtitle="Buyurtma, namuna va natija qoralamalari — bitta kuzatiladigan jarayon." action={<AButton variant="outline" disabled={busy} onClick={() => setRefresh(v => v + 1)}>Yangilash</AButton>} />
    <div className="rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950">
      <strong>Ichki ish stoli · bemorga yuborilmaydi.</strong> Tekshiruvchi vakolatlari va klinika tasdiqlash tartibi belgilanmaguncha natijalarni tasdiqlash va tarqatish yopiq. Qurilmalar hali ulanmagan.
    </div>
    {error && <AError message={error} />}
    {notice && <p role="status" className="text-sm text-pine">{notice}</p>}
    {selected && <AButton variant="ghost" disabled={busy} onClick={() => { setSelected(null); setNotice(""); }}>← Buyurtmalar ro‘yxati</AButton>}
    {!selected && patient && <Card><fieldset disabled={busy} className="grid gap-4 md:grid-cols-2">
      <div className="md:col-span-2"><h2 className="font-display text-lg font-semibold">Yangi laboratoriya buyurtmasi</h2><p className="mt-1 text-sm">{patient.full_name} · №{patient.patient_number}</p><p className="mt-1 text-xs text-ink-muted">Bir turdagi namuna uchun buyurtma. Narx va to‘lov bu oynada yaratilmaydi.</p></div>
      <label className="text-sm">Namuna turi<AInput value={specimen} onChange={setSpecimen} maxLength={100} placeholder="Klinika belgilagan namuna turi" /></label>
      <label className="text-sm">Tekshiruvlar — har qatorda bittadan<textarea className="mt-1 min-h-28 w-full rounded-lg border border-hairline p-3" value={tests} onChange={e => setTests(e.target.value)} maxLength={8050} /></label>
      <div><AButton loading={busy} disabled={!tests.trim() || !specimen.trim()} onClick={() => void create()}>Buyurtmani saqlash</AButton></div>
    </fieldset></Card>}
    {loading ? <LoadingRow /> : detail ? <>
      <Card><div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="font-display text-xl font-semibold">{detail.patient.full_name}</h2><p className="font-numeric mt-1 text-sm text-ink-muted">Bemor №{detail.patient.patient_number} · {formatDateTime(detail.order.created_at)}</p></div><Link className="text-sm text-pine underline" href={`/doctor/patients/${detail.order.patient_id}`}>Bemor tarixi</Link></div></Card>
      <div className="grid gap-5 lg:grid-cols-[minmax(240px,1fr)_2fr]">
        <div className="space-y-4"><h2 className="font-display text-lg font-semibold">Namuna harakati</h2>
          {detail.specimens.map(s => {
            const replaced = detail.specimens.some(n => n.replaces_id === s.id);
            const next = ({ ordered: "collected", collected: "received", received: "processing" } as Record<string, "collected" | "received" | "processing">)[s.status];
            return <Card key={s.id}><h3 className="font-semibold">{s.specimen_type}</h3><p className="mt-1 text-sm text-pine">{specimenLabels[s.status]}</p><p className="font-numeric my-3 break-all text-xs" aria-label="Namuna identifikatori">{s.accession}</p>
              {s.rejection_reason && <p className="mb-3 text-sm text-red-800">Sabab: {s.rejection_reason}</p>}
              <div className="flex flex-wrap gap-2">{next && <AButton size="sm" disabled={busy} onClick={() => void send({ action: "transition", orderId: detail.order.id, specimenId: s.id, expectedVersion: s.version, status: next })}>{specimenLabels[next]}</AButton>}
                {s.status === "rejected" && !replaced && <AButton size="sm" disabled={busy} onClick={() => void send({ action: "recollect", orderId: detail.order.id, specimenId: s.id, expectedVersion: s.version })}>Qayta olish uchun yangi namuna</AButton>}
                {s.status !== "rejected" && <AButton variant="danger" size="sm" disabled={busy || reason.trim().length < 3} onClick={() => void send({ action: "transition", orderId: detail.order.id, specimenId: s.id, expectedVersion: s.version, status: "rejected", reason })}>Namunani rad etish</AButton>}
              </div>{replaced && <p className="mt-2 text-xs text-ink-muted">Yangi namuna ochilgan; avvalgi yozuv saqlanadi.</p>}
            </Card>;
          })}
          <label className="block text-sm">Rad etish sababi<AInput value={reason} onChange={setReason} maxLength={500} /></label>
        </div>
        <div className="space-y-4"><h2 className="font-display text-lg font-semibold">Natijalar · tasdiqlanmagan</h2>
          {detail.tests.map(test => <DraftEditor key={`${test.id}:${detail.drafts.length}:${test.specimen_id}`} test={test} drafts={detail.drafts.filter(d => d.test_id === test.id)} enabled={detail.specimens.find(s => s.id === test.specimen_id)?.status === "processing"} busy={busy} orderId={detail.order.id} send={send} />)}
        </div>
      </div>
    </> : !selected && <>
      {!patientId && <p className="text-sm text-ink-muted">Yangi buyurtma uchun bemor tarixidagi “Laboratoriya buyurtmasi” havolasini oching.</p>}
      <Card>{orders.length === 0 ? <p className="text-sm text-ink-muted">Sizga ruxsat etilgan laboratoriya buyurtmalari yo‘q.</p> : <ul className="divide-y divide-hairline">{orders.map(o => <li key={o.id}><button className="flex w-full flex-wrap items-center justify-between gap-3 py-4 text-left hover:bg-sand focus-visible:outline-2 focus-visible:outline-pine" onClick={() => setSelected(o.id)}><span><strong className="block">{o.full_name} · №{o.patient_number}</strong><span className="text-xs text-ink-muted">{formatDateTime(o.created_at)}</span></span><span className="font-numeric text-sm">{o.draft_count}/{o.tests_count} qoralama →</span></button></li>)}</ul>}</Card>
      <div className="flex items-center gap-4"><AButton variant="outline" disabled={page === 0} onClick={() => setPage(v => v - 1)}>Oldingi</AButton><span className="text-sm">{page + 1}-sahifa</span><AButton variant="outline" disabled={!hasNext} onClick={() => setPage(v => v + 1)}>Keyingi</AButton></div>
    </>}
  </div>;
}

function DraftEditor({ test, drafts, enabled, busy, orderId, send }: { test: LabTest; drafts: LabDraft[]; enabled: boolean; busy: boolean; orderId: string; send: (command: LabCommand) => Promise<boolean> }) {
  const latest = drafts.filter(d => d.specimen_id === test.specimen_id).sort((a, b) => b.revision - a.revision)[0];
  const revision = Math.max(0, ...drafts.map(d => d.revision));
  const [value, setValue] = useState(latest?.value ?? "");
  const [unit, setUnit] = useState(latest?.unit ?? "");
  const [reference, setReference] = useState(latest?.reference_text ?? "");
  const [reason, setReason] = useState("");
  return <Card><fieldset disabled={busy || !enabled} className="space-y-3"><h3 className="font-semibold">{test.test_name}</h3>
    {!enabled && <p className="text-xs text-ink-muted">Natija kiritish uchun namuna tekshirish jarayoniga o‘tkazilishi kerak.</p>}
    <label className="block text-sm">Natija<AInput value={value} onChange={setValue} maxLength={2000} /></label>
    <div className="grid gap-3 sm:grid-cols-2"><label className="text-sm">Birlik<AInput value={unit} onChange={setUnit} maxLength={80} /></label><label className="text-sm">Tasdiqlangan ma’lumotnomadagi me’yor<AInput value={reference} onChange={setReference} maxLength={500} /></label></div>
    {revision > 0 && <label className="block text-sm">Yangi versiya sababi<AInput value={reason} onChange={setReason} maxLength={500} /></label>}
    <AButton size="sm" disabled={!value.trim() || (revision > 0 && reason.trim().length < 3)} onClick={() => void send({ action: "draft", orderId, testId: test.id, expectedRevision: revision, value, unit, referenceText: reference, ...(revision > 0 ? { reason } : {}) })}>Qoralamani saqlash</AButton>
  </fieldset>{drafts.length > 0 && <details className="mt-4 border-t border-hairline pt-3 text-xs"><summary className="cursor-pointer">Oldingi versiyalar ({drafts.length})</summary>{drafts.map(d => <div key={d.id} className="mt-3 whitespace-pre-wrap"><strong>v{d.revision} · {d.value} {d.unit}</strong><p>{d.reference_text}</p><p>{formatDateTime(d.created_at)} · Muallif: {d.author_id}</p>{d.correction_reason && <p>Sabab: {d.correction_reason}</p>}{d.specimen_id !== test.specimen_id && <p className="text-red-800">Avvalgi namuna natijasi — joriy namuna uchun ishlatilmaydi.</p>}</div>)}</details>}</Card>;
}

"use client";

import { useEffect, useMemo, useState } from "react";
import { PageHeader, Card, ABadge, AButton, AEmpty, AError, AInput, AModal, ATextArea } from "@/components/admin/ui";
import { adminApi, AdminApiError, formatDateTime } from "@/lib/admin/client";
import { newIdempotencyKey } from "@/lib/idempotency-key";
import { LAB_ITEM_STATUS, LabOrderDialog } from "@/components/doctor/lab-orders";
import { ResultEntryDialog } from "@/components/lab/result-entry";
import { ListChecks, Plus, TestTube } from "lucide-react";

/**
 * The lab work queue (Phase 7), shared by the lab workspace (/lab) and the
 * reception desk (/admin/lab-queue). Status and specimens only — who the
 * patient is (name, date of birth), which tests, which sample each needs,
 * where it is in the workflow. Never result values or clinical text.
 *
 * Every button is a convenience: the server re-checks the role, the clinic
 * and the item state in one locked transaction, so two people pressing
 * "collect" for the same test still produce one sample.
 */

type Item = { id: string; testCode: string; testName: string; sampleType: string; preparationText: string | null; status: string; sampleId: string | null };
type Sample = { id: string; code: string; sampleType: string; status: string; collectedAt: string; notes: string | null; rejectReason: string | null; itemIds: string[] };
type Order = {
  id: string;
  createdAt: string;
  source: string;
  patient: { id: string; fullName: string | null; dateOfBirth: string | null };
  items: Item[];
  samples: Sample[];
};
type PatientMatch = { id: string; fullName: string | null; dateOfBirth: string | null; phoneTail: string | null };

const SAMPLE_STATUS: Record<string, { label: string; tone: "blue" | "green" | "gray" }> = {
  collected: { label: "Olingan", tone: "blue" },
  received: { label: "Laboratoriyada", tone: "green" },
  rejected: { label: "Rad etilgan", tone: "gray" },
};

type View = "collect" | "receive" | "processing" | "all";
const VIEWS: Array<{ value: View; label: string }> = [
  { value: "collect", label: "Namuna olish" },
  { value: "receive", label: "Qabul kutilmoqda" },
  { value: "processing", label: "Jarayonda" },
  { value: "all", label: "Barchasi" },
];

const errorText = (e: unknown, fallback: string) => (e instanceof AdminApiError ? e.message : fallback);
const dob = (d: string | null) => (d ? d.split("-").reverse().join(".") : "tug‘ilgan sana yo‘q");

function inView(order: Order, view: View): boolean {
  if (view === "all") return true;
  if (view === "collect") return order.items.some((i) => i.status === "ready_for_collection" || i.status === "ordered");
  if (view === "receive") return order.samples.some((s) => s.status === "collected");
  return order.items.some((i) => i.status === "processing" || i.status === "resulted");
}

export function LabWorkQueue({
  canCollect,
  canProcess,
  canOrder,
  canEnter = false,
}: {
  canCollect: boolean;
  canProcess: boolean;
  canOrder: boolean;
  canEnter?: boolean;
}) {
  const [orders, setOrders] = useState<Order[] | null>(null);
  const [limit, setLimit] = useState(200);
  const [view, setView] = useState<View>(canProcess && !canCollect ? "receive" : "collect");
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [collecting, setCollecting] = useState<{ order: Order; items: Item[] } | null>(null);
  const [rejecting, setRejecting] = useState<Sample | null>(null);
  const [ordering, setOrdering] = useState<"search" | PatientMatch | null>(null);
  const [entering, setEntering] = useState<string | null>(null);

  const load = async () => {
    try {
      const res = await adminApi.get<{ orders: Order[]; limit: number }>("/api/lab/queue");
      setOrders(res.orders);
      setLimit(res.limit);
    } catch (e) {
      setError(errorText(e, "Ish navbatini yuklab bo‘lmadi"));
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const q = query.trim().toLowerCase();
  const visible = (orders ?? []).filter((o) => inView(o, view) && (!q || (o.patient.fullName ?? "").toLowerCase().includes(q)));

  const receive = async (sample: Sample) => {
    setError(null);
    setNotice(null);
    try {
      await adminApi.post(`/api/lab/samples/${sample.id}`, { action: "receive" });
      await load();
      setNotice(`${sample.code} qabul qilindi`);
    } catch (e) {
      setError(errorText(e, "Namunani qabul qilib bo‘lmadi"));
    }
  };

  return (
    <div>
      <PageHeader
        title="Ish navbati"
        subtitle="Laboratoriya buyurtmalari, namunalar va tahlil holati"
        action={canOrder ? <AButton onClick={() => { setNotice(null); setOrdering("search"); }}><Plus className="h-4 w-4" /> Yangi buyurtma</AButton> : undefined}
      />
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap gap-1">
          {VIEWS.map((v) => (
            <AButton key={v.value} size="sm" variant={view === v.value ? "primary" : "outline"} onClick={() => setView(v.value)}>
              {v.label}
            </AButton>
          ))}
        </div>
        <div className="w-full max-w-xs">
          <AInput value={query} onChange={setQuery} placeholder="Bemor ismi bo‘yicha" aria-label="Bemor qidirish" />
        </div>
      </div>
      {error && <AError message={error} />}
      {notice && (
        <p className="mb-3 rounded-lg bg-pine-tint px-3 py-2 text-sm text-pine-deep" role="status">
          {notice}
        </p>
      )}

      {orders === null ? (
        <Card><div className="h-2 w-full animate-pulse rounded bg-hairline" /></Card>
      ) : visible.length === 0 ? (
        <Card><AEmpty title="Bu bo‘limda ish yo‘q" subtitle="Yangi buyurtmalar shu yerda ko‘rinadi" icon={<ListChecks className="h-6 w-6" />} /></Card>
      ) : (
        <div className="flex flex-col gap-3">
          {visible.map((o) => (
            <QueueCard
              key={o.id}
              order={o}
              canCollect={canCollect}
              canProcess={canProcess}
              canEnter={canEnter}
              onEnter={(itemId) => { setError(null); setNotice(null); setEntering(itemId); }}
              onCollect={(items) => { setError(null); setNotice(null); setCollecting({ order: o, items }); }}
              onReceive={receive}
              onReject={(s) => { setError(null); setNotice(null); setRejecting(s); }}
            />
          ))}
          {orders.length >= limit && <p className="text-xs text-ink-muted">Eng yangi {limit} ta faol buyurtma ko‘rsatilmoqda.</p>}
        </div>
      )}

      {collecting && (
        <CollectDialog
          order={collecting.order}
          items={collecting.items}
          onClose={() => setCollecting(null)}
          onDone={async (code) => {
            setCollecting(null);
            await load();
            setNotice(`Namuna olindi: ${code} — shu kodni probirkaga yozing`);
          }}
        />
      )}
      {rejecting && (
        <RejectDialog
          sample={rejecting}
          onClose={() => setRejecting(null)}
          onDone={async () => {
            const code = rejecting.code;
            setRejecting(null);
            await load();
            setNotice(`${code} rad etildi — tahlillar qayta namuna olishga qaytdi`);
          }}
        />
      )}
      {entering && (
        <ResultEntryDialog
          itemId={entering}
          onClose={() => { setEntering(null); void load(); }}
          onChanged={async (message) => {
            setEntering(null);
            await load();
            setNotice(message);
          }}
        />
      )}
      {ordering === "search" && <PatientPicker onClose={() => setOrdering(null)} onPick={(p) => setOrdering(p)} />}
      {ordering && ordering !== "search" && (
        <LabOrderDialog
          desk
          patientId={ordering.id}
          appointmentId={null}
          previous={[]}
          recentDays={0}
          onViewResult={() => {}}
          onClose={() => setOrdering(null)}
          onOrdered={async (count) => {
            const name = ordering.fullName ?? "Bemor";
            setOrdering(null);
            setView("collect");
            await load();
            setNotice(`${name} uchun ${count} ta tahlil buyurtma qilindi`);
          }}
        />
      )}
    </div>
  );
}

function QueueCard({
  order,
  canCollect,
  canProcess,
  canEnter,
  onEnter,
  onCollect,
  onReceive,
  onReject,
}: {
  order: Order;
  canCollect: boolean;
  canProcess: boolean;
  canEnter: boolean;
  onEnter: (itemId: string) => void;
  onCollect: (items: Item[]) => void;
  onReceive: (s: Sample) => void;
  onReject: (s: Sample) => void;
}) {
  // Ready tests grouped by the sample they need: one tube per group.
  const groups = useMemo(() => {
    const map = new Map<string, Item[]>();
    for (const i of order.items.filter((x) => x.status === "ready_for_collection")) {
      const key = i.sampleType.trim().toLowerCase();
      map.set(key, [...(map.get(key) ?? []), i]);
    }
    return [...map.values()];
  }, [order.items]);
  const awaitingPayment = order.items.some((i) => i.status === "ordered");
  const codeOf = (sampleId: string | null) => order.samples.find((s) => s.id === sampleId)?.code;

  return (
    <section aria-label={`${order.patient.fullName ?? "Bemor"} buyurtmasi`}>
      <Card className="flex flex-col gap-3 p-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <div>
            <p className="font-semibold text-foreground">{order.patient.fullName ?? "—"}</p>
            <p className="text-xs text-ink-muted">{dob(order.patient.dateOfBirth)} · buyurtma {formatDateTime(order.createdAt)}</p>
          </div>
          {awaitingPayment && <ABadge tone="amber">To‘lov kutilmoqda</ABadge>}
        </div>

        <ul className="flex flex-col gap-1 text-sm">
          {order.items.map((i) => {
            const status = LAB_ITEM_STATUS[i.status] ?? { label: i.status, tone: "neutral" as const };
            return (
              <li key={i.id} className="flex flex-wrap items-center justify-between gap-2">
                <span className={i.status === "cancelled" ? "text-ink-muted line-through" : "text-foreground"}>
                  {i.testName} <span className="text-xs text-ink-muted">· {i.sampleType}</span>
                  {codeOf(i.sampleId) && <span className="font-numeric ml-1 text-xs text-ink-muted">· {codeOf(i.sampleId)}</span>}
                </span>
                <span className="flex items-center gap-1">
                  <ABadge tone={i.status === "ordered" ? "amber" : status.tone}>{i.status === "ordered" ? "To‘lov kutilmoqda" : status.label}</ABadge>
                  {canEnter && i.status === "processing" && (
                    <AButton size="sm" onClick={() => onEnter(i.id)}>Natija kiritish</AButton>
                  )}
                  {canEnter && i.status === "resulted" && (
                    <AButton size="sm" variant="outline" onClick={() => onEnter(i.id)}>Natijani ko‘rish</AButton>
                  )}
                </span>
              </li>
            );
          })}
        </ul>

        {canCollect && groups.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {groups.map((g) => (
              <AButton key={g[0].id} size="sm" onClick={() => onCollect(g)}>
                <TestTube className="h-4 w-4" /> {g[0].sampleType} namunasini olish ({g.length})
              </AButton>
            ))}
          </div>
        )}

        {order.samples.length > 0 && (
          <div className="border-t border-hairline pt-2">
            <p className="mb-1 text-xs font-medium uppercase tracking-wide text-ink-muted">Namunalar</p>
            <ul className="flex flex-col gap-1.5 text-sm">
              {order.samples.map((s) => {
                const st = SAMPLE_STATUS[s.status] ?? { label: s.status, tone: "gray" as const };
                return (
                  <li key={s.id} className="flex flex-wrap items-center justify-between gap-2">
                    <span>
                      <span className="font-numeric font-medium text-foreground">{s.code}</span>{" "}
                      <span className="text-xs text-ink-muted">
                        {s.sampleType} · {formatDateTime(s.collectedAt)}
                        {s.notes ? ` · ${s.notes}` : ""}
                        {s.rejectReason ? ` · sabab: ${s.rejectReason}` : ""}
                      </span>
                    </span>
                    <span className="flex items-center gap-1">
                      <ABadge tone={st.tone}>{st.label}</ABadge>
                      {canProcess && s.status === "collected" && <AButton size="sm" onClick={() => onReceive(s)}>Qabul qilish</AButton>}
                      {canProcess && (s.status === "collected" || s.status === "received") && (
                        <AButton size="sm" variant="outline" onClick={() => onReject(s)}>Rad etish</AButton>
                      )}
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </Card>
    </section>
  );
}

function CollectDialog({ order, items, onClose, onDone }: { order: Order; items: Item[]; onClose: () => void; onDone: (code: string) => void }) {
  const [selected, setSelected] = useState<string[]>(items.map((i) => i.id));
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // One key per dialog: a double tap or a retry after a lost response is the same sample.
  const [key] = useState(newIdempotencyKey);
  const preparations = items.filter((i) => i.preparationText);

  const submit = async () => {
    setSaving(true);
    setError(null);
    try {
      const res = await adminApi.post<{ sampleId: string; sampleCode: string }>(`/api/lab/orders/${order.id}/samples`, {
        idempotencyKey: key,
        itemIds: selected,
        notes: notes.trim() || null,
      });
      onDone(res.sampleCode);
    } catch (e) {
      setError(errorText(e, "Namunani saqlab bo‘lmadi"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <AModal
      title={`${items[0].sampleType} namunasini olish`}
      onClose={onClose}
      footer={
        <>
          <AButton variant="ghost" onClick={onClose}>Bekor qilish</AButton>
          <AButton onClick={submit} loading={saving} disabled={selected.length === 0}>Namuna olindi</AButton>
        </>
      }
    >
      {error && <AError message={error} />}
      <p className="text-sm text-foreground">
        <span className="font-semibold">{order.patient.fullName ?? "—"}</span> · {dob(order.patient.dateOfBirth)}
      </p>
      <p className="text-xs text-ink-muted">Bemorning ismi va tug‘ilgan sanasini so‘rab tasdiqlang.</p>
      <div className="flex flex-col gap-1">
        {items.map((i) => (
          <label key={i.id} className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={selected.includes(i.id)}
              onChange={() => setSelected((s) => (s.includes(i.id) ? s.filter((x) => x !== i.id) : [...s, i.id]))}
            />
            {i.testName} <span className="font-numeric text-xs text-ink-muted">{i.testCode}</span>
          </label>
        ))}
      </div>
      {preparations.length > 0 && (
        <div className="rounded-xl bg-sand p-3 text-sm">
          <p className="mb-1 font-medium text-foreground">Tayyorgarlik</p>
          <ul className="list-disc pl-5 text-ink-muted">
            {preparations.map((i) => (
              <li key={i.id}><span className="text-foreground">{i.testName}:</span> {i.preparationText}</li>
            ))}
          </ul>
        </div>
      )}
      <ATextArea value={notes} onChange={setNotes} rows={2} placeholder="Izoh (ixtiyoriy, masalan: ikkinchi urinish)" aria-label="Izoh" />
      <p className="text-xs text-ink-muted">Namuna kodi tizim tomonidan beriladi.</p>
    </AModal>
  );
}

function RejectDialog({ sample, onClose, onDone }: { sample: Sample; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setSaving(true);
    setError(null);
    try {
      await adminApi.post(`/api/lab/samples/${sample.id}`, { action: "reject", reason: reason.trim() });
      onDone();
    } catch (e) {
      setError(errorText(e, "Namunani rad etib bo‘lmadi"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <AModal
      title={`${sample.code} namunasini rad etish`}
      onClose={onClose}
      footer={
        <>
          <AButton variant="ghost" onClick={onClose}>Bekor qilish</AButton>
          <AButton variant="danger" onClick={submit} loading={saving} disabled={!reason.trim()}>Rad etish</AButton>
        </>
      }
    >
      {error && <AError message={error} />}
      <p className="text-sm text-foreground">Tahlillar qayta namuna olish uchun navbatga qaytadi.</p>
      <ATextArea value={reason} onChange={setReason} rows={2} placeholder="Sabab (masalan: gemoliz, hajmi yetarli emas)" aria-label="Rad etish sababi" />
    </AModal>
  );
}

function PatientPicker({ onClose, onPick }: { onClose: () => void; onPick: (p: PatientMatch) => void }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<PatientMatch[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const text = query.trim();
    if (text.length < 2) return;
    const handle = setTimeout(() => {
      adminApi
        .get<{ patients: PatientMatch[] }>(`/api/lab/patients?q=${encodeURIComponent(text)}`)
        .then((res) => setResults(res.patients))
        .catch((e) => setError(errorText(e, "Bemorlarni qidirib bo‘lmadi")));
    }, 250);
    return () => clearTimeout(handle);
  }, [query]);

  const shown = query.trim().length < 2 ? null : results;

  return (
    <AModal title="Bemorni tanlang" onClose={onClose} footer={<AButton variant="ghost" onClick={onClose}>Bekor qilish</AButton>}>
      {error && <AError message={error} />}
      <AInput value={query} onChange={setQuery} placeholder="Ism yoki telefon raqami" aria-label="Bemor qidirish (ism yoki telefon)" />
      {shown && shown.length === 0 && <p className="text-sm text-ink-muted">Bemor topilmadi. Yangi bemorni qabulxona ro‘yxatga oladi.</p>}
      {shown && shown.length > 0 && (
        <ul className="flex flex-col gap-1">
          {shown.map((p) => (
            <li key={p.id}>
              <button type="button" className="w-full rounded-lg px-2 py-1.5 text-left text-sm hover:bg-sand" onClick={() => onPick(p)}>
                <span className="font-medium text-foreground">{p.fullName ?? "—"}</span>
                <span className="block text-xs text-ink-muted">
                  {dob(p.dateOfBirth)}
                  {p.phoneTail ? ` · tel. …${p.phoneTail}` : ""}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </AModal>
  );
}

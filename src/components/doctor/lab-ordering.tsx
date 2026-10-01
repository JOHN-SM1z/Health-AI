"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { FlaskConical } from "lucide-react";
import { ABadge, AButton, AError, AInput, ASelect, ATextArea, AModal, Card, LoadingRow } from "@/components/admin/ui";
import { adminApi, AdminApiError, formatDateTime, formatPrice } from "@/lib/admin/client";
import { newIdempotencyKey } from "@/lib/idempotency-key";
import type { CatalogPanel, CatalogTest, PatientLabOrder, SimilarTestNotice } from "@/lib/labs/ordering";

const ORDER_STATUS_LABELS: Record<string, string> = {
  ordered: "Buyurtma berildi",
  awaiting_payment: "To‘lov kutilmoqda",
  paid: "To‘langan",
  collection_pending: "Namuna kutilmoqda",
  collected: "Namuna olindi",
  in_progress: "Jarayonda",
  completed: "Yakunlandi",
  cancelled: "Bekor qilingan",
};
const RESULT_LABELS: Record<string, { label: string; tone: "neutral" | "amber" | "green" }> = {
  none: { label: "Natija yo‘q", tone: "neutral" },
  draft: { label: "Kiritilmoqda", tone: "amber" },
  pending_verification: { label: "Tasdiq kutilmoqda", tone: "amber" },
  verified: { label: "Tasdiqlangan", tone: "green" },
};

/**
 * A doctor's laboratory orders for one patient: the patient's earlier orders (every doctor's, read-only
 * history) and, while the doctor has a consultation under way with the patient (or names a finished one
 * of their own), a search → select → review → send flow. The server decides everything that matters (the
 * doctor's access, the consultation, the catalog's prices, the clinic); this component only collects
 * the doctor's choices. Result values are not shown here (they are part of the result screens).
 */
export function LabOrdering({ patientId, appointmentId }: { patientId: string; appointmentId: string | null }) {
  const [orders, setOrders] = useState<PatientLabOrder[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [sent, setSent] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await adminApi.get<{ orders: PatientLabOrder[] }>(`/api/doctor/patients/${patientId}/lab`);
      setOrders(res.orders);
      setError(null);
    } catch (e) {
      setOrders([]);
      setError(e instanceof AdminApiError ? e.message : "Tahlillarni yuklab bo‘lmadi");
    }
  }, [patientId]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="flex flex-col gap-3">
      <Card>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-ink-muted">
            {appointmentId
              ? "Joriy qabul doirasida tahlil buyurishingiz mumkin."
              : "Tahlil buyurish uchun avval bemor bilan qabulni boshlang."}
          </p>
          <AButton disabled={!appointmentId} onClick={() => { setSent(null); setCreating(true); }}>
            <FlaskConical className="mr-1.5 h-4 w-4" aria-hidden /> Tahlil buyurish
          </AButton>
        </div>
        {sent && <p className="mt-2 text-sm text-pine-deep" role="status">{sent}</p>}
      </Card>

      {error && <AError message={error} />}
      {orders === null ? (
        <LoadingRow />
      ) : orders.length === 0 ? (
        <p className="text-sm text-ink-muted">Bu bemorga tahlil buyurilmagan.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {orders.map((o) => (
            <li key={o.id}>
              <Card>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm font-medium text-foreground">
                    {formatDateTime(o.createdAt)}
                    {o.orderedBy ? ` · ${o.orderedBy}` : ""}
                    {o.isOwn ? " (siz)" : ""}
                  </p>
                  <div className="flex items-center gap-2">
                    {o.priority === "urgent" && <ABadge tone="red">Shoshilinch</ABadge>}
                    <ABadge tone={o.status === "cancelled" ? "gray" : "blue"}>{ORDER_STATUS_LABELS[o.status] ?? o.status}</ABadge>
                  </div>
                </div>
                <ul className="mt-2 divide-y divide-hairline/70">
                  {o.items.map((i) => (
                    <li key={i.id} className="flex flex-wrap items-center justify-between gap-2 py-1.5 text-sm">
                      <span className="text-foreground">{i.name}</span>
                      <ABadge tone={RESULT_LABELS[i.resultStatus]?.tone ?? "neutral"}>{RESULT_LABELS[i.resultStatus]?.label ?? i.resultStatus}</ABadge>
                    </li>
                  ))}
                </ul>
                {o.notes && <p className="mt-2 whitespace-pre-wrap text-sm text-ink-muted">{o.notes}</p>}
              </Card>
            </li>
          ))}
        </ul>
      )}

      {creating && appointmentId && (
        <OrderDialog
          patientId={patientId}
          appointmentId={appointmentId}
          onClose={() => setCreating(false)}
          onCreated={(message) => {
            setCreating(false);
            setSent(message);
            void load();
          }}
        />
      )}
    </div>
  );
}

type Selection = { tests: Map<string, CatalogTest>; panels: Map<string, CatalogPanel> };

function OrderDialog({
  patientId,
  appointmentId,
  onClose,
  onCreated,
}: {
  patientId: string;
  appointmentId: string;
  onClose: () => void;
  onCreated: (message: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [catalog, setCatalog] = useState<{ tests: CatalogTest[]; panels: CatalogPanel[] } | null>(null);
  const [selection, setSelection] = useState<Selection>({ tests: new Map(), panels: new Map() });
  const [priority, setPriority] = useState<"routine" | "urgent">("routine");
  const [notes, setNotes] = useState("");
  const [notices, setNotices] = useState<SimilarTestNotice[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // One idempotency key per intended order, set when the review opens: a double click or a retry after a
  // lost response cannot order twice. Going back to edit drops it.
  const [review, setReview] = useState<{ idempotencyKey: string } | null>(null);
  const inFlight = useRef(false);

  useEffect(() => {
    const handle = setTimeout(() => {
      adminApi
        .get<{ tests: CatalogTest[]; panels: CatalogPanel[] }>(`/api/doctor/lab/catalog?q=${encodeURIComponent(query.trim())}`)
        .then(setCatalog)
        .catch((e) => {
          setCatalog({ tests: [], panels: [] });
          setError(e instanceof AdminApiError ? e.message : "Katalogni yuklab bo‘lmadi");
        });
    }, 250);
    return () => clearTimeout(handle);
  }, [query]);

  const count = selection.tests.size + selection.panels.size;
  const selectedIds = {
    testIds: [...selection.tests.keys()],
    panelIds: [...selection.panels.keys()],
  };
  // Indicative only: a test chosen directly and through a panel is one item, priced once by the server.
  const indicativeTotal =
    [...selection.tests.values()].reduce((s, t) => s + t.price, 0) + [...selection.panels.values()].reduce((s, p) => s + p.price, 0);

  const toggle = <K extends "tests" | "panels">(kind: K, item: CatalogTest | CatalogPanel) => {
    setSelection((cur) => {
      const next: Selection = { tests: new Map(cur.tests), panels: new Map(cur.panels) };
      const map = (kind === "tests" ? next.tests : next.panels) as Map<string, CatalogTest | CatalogPanel>;
      if (map.has(item.id)) map.delete(item.id);
      else map.set(item.id, item);
      return next;
    });
    setReview(null);
  };

  const openReview = async () => {
    setError(null);
    try {
      // Advisory only: a similar recent test is shown, never a reason to refuse.
      const res = await adminApi.post<{ notices: SimilarTestNotice[] }>("/api/doctor/lab/comparable", { patientId, ...selectedIds });
      setNotices(res.notices);
    } catch {
      setNotices([]);
    }
    setReview({ idempotencyKey: newIdempotencyKey() });
  };

  const submit = async () => {
    if (!review || count === 0 || inFlight.current) return;
    inFlight.current = true;
    setSubmitting(true);
    setError(null);
    try {
      const res = await adminApi.post<{ order: { total: number; items: unknown[] } }>("/api/doctor/lab/orders", {
        idempotencyKey: review.idempotencyKey,
        patientId,
        appointmentId,
        ...selectedIds,
        priority,
        notes: notes.trim() || null,
      });
      onCreated(`Buyurtma yuborildi: ${res.order.items.length} ta tahlil.`);
    } catch (e) {
      // The same key is kept, so sending again after a network error is safe.
      setError(e instanceof AdminApiError ? e.message : "Buyurtmani yuborib bo‘lmadi");
      setSubmitting(false);
    } finally {
      inFlight.current = false;
    }
  };

  const rows = (
    <>
      {catalog === null ? (
        <LoadingRow />
      ) : catalog.tests.length === 0 && catalog.panels.length === 0 ? (
        <p className="py-3 text-sm text-ink-muted">Hech narsa topilmadi.</p>
      ) : (
        <ul className="max-h-72 divide-y divide-hairline/70 overflow-y-auto rounded-lg border border-hairline">
          {catalog.panels.map((p) => (
            <li key={`p-${p.id}`}>
              <label className={`flex items-start gap-3 px-3 py-2 text-sm ${p.unavailable.length ? "opacity-60" : "cursor-pointer"}`}>
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={selection.panels.has(p.id)}
                  disabled={p.unavailable.length > 0}
                  onChange={() => toggle("panels", p)}
                />
                <span className="flex-1">
                  <span className="font-medium text-foreground">{p.name}</span> <ABadge tone="purple">Paket</ABadge>
                  <span className="block text-xs text-ink-muted">{p.tests.map((t) => t.name).join(", ")}</span>
                  {p.unavailable.length > 0 && (
                    <span className="block text-xs text-danger">Paketda faol bo‘lmagan tahlil bor — buyurtma berib bo‘lmaydi.</span>
                  )}
                </span>
                <span className="whitespace-nowrap text-ink-muted">{formatPrice(p.price)}</span>
              </label>
            </li>
          ))}
          {catalog.tests.map((t) => (
            <li key={`t-${t.id}`}>
              <label className="flex cursor-pointer items-start gap-3 px-3 py-2 text-sm">
                <input type="checkbox" className="mt-1" checked={selection.tests.has(t.id)} onChange={() => toggle("tests", t)} />
                <span className="flex-1">
                  <span className="font-medium text-foreground">{t.name}</span> <span className="text-xs text-ink-muted">{t.code}</span>
                  <span className="block text-xs text-ink-muted">
                    {[t.category, t.sampleType, t.turnaroundMinutes ? `~${t.turnaroundMinutes} daqiqa` : null].filter(Boolean).join(" · ")}
                  </span>
                  {t.preparationText && <span className="block text-xs text-ink-muted">Tayyorgarlik: {t.preparationText}</span>}
                </span>
                <span className="whitespace-nowrap text-ink-muted">{formatPrice(t.price)}</span>
              </label>
            </li>
          ))}
        </ul>
      )}
    </>
  );

  return (
    <AModal
      title={review ? "Buyurtmani tekshiring" : "Tahlil buyurish"}
      onClose={onClose}
      maxWidth="max-w-2xl"
      footer={
        review ? (
          <>
            <AButton variant="ghost" onClick={() => setReview(null)} disabled={submitting}>
              Tahrirlash
            </AButton>
            <AButton loading={submitting} onClick={() => void submit()}>
              Buyurtmani yuborish
            </AButton>
          </>
        ) : (
          <>
            <AButton variant="ghost" onClick={onClose}>
              Bekor qilish
            </AButton>
            <AButton disabled={count === 0} onClick={() => void openReview()}>
              Ko‘rib chiqish ({count})
            </AButton>
          </>
        )
      }
    >
      {error && <AError message={error} />}
      {review ? (
        <div className="flex flex-col gap-3">
          {notices.length > 0 && (
            <div className="rounded-lg border border-clay/40 bg-clay-tint p-3 text-sm text-clay-deep" role="status">
              <p className="font-medium">Yaqinda xuddi shu tahlil buyurilgan</p>
              <ul className="mt-1 list-disc pl-5">
                {notices.map((n) => (
                  <li key={`${n.orderId}-${n.testId}`}>
                    {n.name}: {n.daysAgo === 0 ? "bugun" : `${n.daysAgo} kun oldin`}
                    {n.isOwn ? "" : " (boshqa shifokor)"}
                    {n.orderStatus === "cancelled" ? "" : n.resultAvailable ? " — tasdiqlangan natija bor" : " — natija hali yo‘q"}
                  </li>
                ))}
              </ul>
              <p className="mt-1 text-xs">Bu faqat eslatma: buyurtmani baribir yuborishingiz mumkin. Oldingi natijalarni tahlillar ro‘yxatidan ko‘ring.</p>
            </div>
          )}
          <ul className="divide-y divide-hairline/70 rounded-lg border border-hairline">
            {[...selection.panels.values()].map((p) => (
              <li key={p.id} className="flex justify-between px-3 py-2 text-sm">
                <span>{p.name} <ABadge tone="purple">Paket</ABadge></span>
                <span className="text-ink-muted">{formatPrice(p.price)}</span>
              </li>
            ))}
            {[...selection.tests.values()].map((t) => (
              <li key={t.id} className="flex justify-between px-3 py-2 text-sm">
                <span>{t.name}</span>
                <span className="text-ink-muted">{formatPrice(t.price)}</span>
              </li>
            ))}
          </ul>
          <p className="text-sm text-ink-muted">
            Taxminiy narx: <span className="font-medium text-foreground">{formatPrice(indicativeTotal)}</span> — yakuniy narxni tizim katalogdan
            hisoblaydi (agar tahlil paket orqali ham tanlangan bo‘lsa, bir marta hisoblanadi).
          </p>
          <div>
            <p className="mb-1 text-xs font-medium text-ink-muted">Ustuvorlik</p>
            <ASelect
              value={priority}
              onChange={(v) => setPriority(v as "routine" | "urgent")}
              options={[{ value: "routine", label: "Odatiy" }, { value: "urgent", label: "Shoshilinch" }]}
              aria-label="Ustuvorlik"
            />
          </div>
          <div>
            <p className="mb-1 text-xs font-medium text-ink-muted">Izoh (ixtiyoriy) — buyurtma tarixida shifokorlarga ko‘rinadi</p>
            <ATextArea value={notes} onChange={setNotes} rows={3} placeholder="Buyurtma izohi" aria-label="Izoh" />
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <AInput value={query} onChange={setQuery} placeholder="Tahlil, kod yoki bo‘lim bo‘yicha qidirish" aria-label="Qidirish" />
          {rows}
        </div>
      )}
    </AModal>
  );
}

"use client";

import { useEffect, useMemo, useState } from "react";
import { AButton, ABadge, AEmpty, AError, AInput, AModal } from "@/components/admin/ui";
import { adminApi, AdminApiError, formatDateTime, formatPrice } from "@/lib/admin/client";
import { newIdempotencyKey } from "@/lib/idempotency-key";
import { findRecentSimilar } from "@/lib/labs/recent";
import { FlaskConical } from "lucide-react";

/**
 * Doctor lab ordering in the patient workspace (Phase 5): the patient's lab
 * orders with each test's status, the ordering dialog (choose → review →
 * submit) with the recent-similar-test warning, and the verified result
 * viewer. The warning informs; it never blocks an order and never says a
 * test is unnecessary. Results are shown only against the clinic's
 * configured reference ranges — never interpreted.
 */

type OrderItem = { id: string; testId: string; testCode: string; testName: string; panelName: string | null; status: string; price: number };
type Order = {
  id: string;
  createdAt: string;
  status: string;
  source: string;
  orderedByName: string | null;
  orderingDoctorName: string | null;
  mine: boolean;
  items: OrderItem[];
};
type OrderableTest = {
  id: string;
  code: string;
  name: string;
  category: string | null;
  sampleType: string;
  preparationText: string | null;
  turnaroundHours: number | null;
  price: number;
};
type OrderablePanel = { id: string; code: string; name: string; price: number; testIds: string[] };
type ResultValue = { parameter: string; value: string; unit: string | null; rangeLabel: string | null; flag: string };
type Result = {
  itemId: string;
  testName: string;
  orderedAt: string;
  performedAt: string | null;
  verifiedAt: string;
  version: number;
  labComment: string | null;
  values: ResultValue[];
};

export const LAB_ITEM_STATUS: Record<string, { label: string; tone: "amber" | "blue" | "green" | "purple" | "neutral" | "gray" | "red" }> = {
  ordered: { label: "Buyurtma qilindi", tone: "neutral" },
  ready_for_collection: { label: "Namuna kutilmoqda", tone: "amber" },
  collected: { label: "Namuna olindi", tone: "blue" },
  processing: { label: "Jarayonda", tone: "purple" },
  resulted: { label: "Natija tekshiruvda", tone: "purple" },
  verified: { label: "Tasdiqlandi", tone: "green" },
  cancelled: { label: "Bekor qilindi", tone: "gray" },
};

/** Where a value sits against the CONFIGURED range — wording never implies a diagnosis. */
export const LAB_FLAG: Record<string, { label: string; tone: "green" | "amber" | "red" | "gray" | "neutral" }> = {
  normal: { label: "Me’yor oralig‘ida", tone: "green" },
  low: { label: "Me’yordan past", tone: "amber" },
  high: { label: "Me’yordan yuqori", tone: "amber" },
  critical_low: { label: "Kritik chegaradan past", tone: "red" },
  critical_high: { label: "Kritik chegaradan yuqori", tone: "red" },
  abnormal: { label: "Kutilgan qiymatdan farq qiladi", tone: "amber" },
  not_evaluated: { label: "Me’yor sozlanmagan", tone: "gray" },
};

const errorText = (e: unknown, fallback: string) => (e instanceof AdminApiError ? e.message : fallback);

export function LabOrdersSection({ patientId, appointmentId }: { patientId: string; appointmentId: string | null }) {
  const [orders, setOrders] = useState<Order[] | null>(null);
  const [recentDays, setRecentDays] = useState(30);
  const [error, setError] = useState<string | null>(null);
  const [ordering, setOrdering] = useState(false);
  const [viewing, setViewing] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = async () => {
    try {
      const res = await adminApi.get<{ orders: Order[]; recentTestDays: number }>(`/api/doctor/patients/${patientId}/lab-orders`);
      setOrders(res.orders);
      setRecentDays(res.recentTestDays);
    } catch (e) {
      setError(errorText(e, "Tahlil buyurtmalarini yuklab bo‘lmadi"));
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reload only when the patient changes
  }, [patientId]);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-ink-muted">
          {appointmentId ? "Buyurtma joriy qabulingizga bog‘lanadi." : "Qabul boshlanmagan — buyurtma qabulsiz (to‘g‘ridan-to‘g‘ri) beriladi."}
        </p>
        <AButton
          size="sm"
          onClick={() => {
            setNotice(null);
            setOrdering(true);
          }}
        >
          <FlaskConical className="h-4 w-4" /> Tahlil buyurtma qilish
        </AButton>
      </div>
      {error && <AError message={error} />}
      {notice && <p className="rounded-lg bg-pine-tint px-3 py-2 text-sm text-pine-deep">{notice}</p>}
      {orders === null ? (
        <div className="h-2 w-full animate-pulse rounded bg-hairline" />
      ) : orders.length === 0 ? (
        <AEmpty title="Tahlil buyurtmalari yo‘q" icon={<FlaskConical className="h-6 w-6" />} />
      ) : (
        <ul className="flex flex-col gap-2" aria-label="Tahlil buyurtmalari">
          {orders.map((o) => (
            <li key={o.id} className="rounded-xl border border-hairline p-3">
              <p className="text-xs text-ink-muted">
                {formatDateTime(o.createdAt)} · {o.orderingDoctorName ?? o.orderedByName ?? "—"}
                {o.mine ? " (siz)" : ""}
                {o.status === "cancelled" ? " · bekor qilingan" : ""}
              </p>
              <ul className="mt-2 flex flex-col gap-1">
                {o.items.map((i) => {
                  const status = LAB_ITEM_STATUS[i.status] ?? { label: i.status, tone: "neutral" as const };
                  return (
                    <li key={i.id} className="flex flex-wrap items-center gap-2 text-sm">
                      <span className="font-medium text-foreground">{i.testName}</span>
                      {i.panelName && <span className="text-xs text-ink-muted">({i.panelName})</span>}
                      <ABadge tone={status.tone}>{status.label}</ABadge>
                      {i.status === "verified" && (
                        <AButton size="sm" variant="ghost" onClick={() => setViewing(i.id)}>
                          Natijani ko‘rish
                        </AButton>
                      )}
                    </li>
                  );
                })}
              </ul>
            </li>
          ))}
        </ul>
      )}

      {ordering && orders && (
        <LabOrderDialog
          patientId={patientId}
          appointmentId={appointmentId}
          previous={orders}
          recentDays={recentDays}
          onViewResult={setViewing}
          onClose={() => setOrdering(false)}
          onOrdered={(count) => {
            setOrdering(false);
            setNotice(`${count} ta tahlil buyurtma qilindi.`);
            void load();
          }}
        />
      )}
      {viewing && <LabResultDialog patientId={patientId} itemId={viewing} onClose={() => setViewing(null)} />}
    </div>
  );
}

function LabOrderDialog({
  patientId,
  appointmentId,
  previous,
  recentDays,
  onViewResult,
  onClose,
  onOrdered,
}: {
  patientId: string;
  appointmentId: string | null;
  previous: Order[];
  recentDays: number;
  onViewResult: (itemId: string) => void;
  onClose: () => void;
  onOrdered: (count: number) => void;
}) {
  const [catalog, setCatalog] = useState<{ tests: OrderableTest[]; panels: OrderablePanel[] } | null>(null);
  const [query, setQuery] = useState("");
  const [testIds, setTestIds] = useState<string[]>([]);
  const [panelIds, setPanelIds] = useState<string[]>([]);
  const [step, setStep] = useState<"choose" | "review">("choose");
  const [dismissed, setDismissed] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // One key per dialog: a double tap or a retry after a lost response is the same order.
  const [key] = useState(newIdempotencyKey);
  // "Recent" is measured from when the dialog opened.
  const [now] = useState(() => Date.now());

  useEffect(() => {
    adminApi
      .get<{ tests: OrderableTest[]; panels: OrderablePanel[] }>("/api/doctor/lab/catalog")
      .then(setCatalog)
      .catch((e) => setError(errorText(e, "Tahlillar ro‘yxatini yuklab bo‘lmadi")));
  }, []);

  const testsById = useMemo(() => new Map((catalog?.tests ?? []).map((t) => [t.id, t])), [catalog]);
  const inPanels = useMemo(
    () => new Set((catalog?.panels ?? []).filter((p) => panelIds.includes(p.id)).flatMap((p) => p.testIds)),
    [catalog, panelIds],
  );
  const q = query.trim().toLowerCase();
  const matches = (name: string, code: string) => !q || name.toLowerCase().includes(q) || code.toLowerCase().includes(q);

  const selectedPanels = (catalog?.panels ?? []).filter((p) => panelIds.includes(p.id));
  const selectedTests = testIds.map((id) => testsById.get(id)).filter((t): t is OrderableTest => Boolean(t));
  const total = selectedTests.reduce((s, t) => s + t.price, 0) + selectedPanels.reduce((s, p) => s + p.price, 0);
  const everyTest = [...selectedTests, ...selectedPanels.flatMap((p) => p.testIds.map((id) => testsById.get(id)).filter((t): t is OrderableTest => Boolean(t)))];
  const preparations = everyTest.filter((t) => t.preparationText);

  // Recent orders of the same tests (not cancelled) — information only.
  const recent = findRecentSimilar(
    everyTest.map((t) => t.id),
    previous,
    recentDays,
    now,
  )
    .filter((m) => !dismissed.includes(m.testId))
    .map((m) => ({ ...m, test: testsById.get(m.testId)! }));

  const toggle = (list: string[], set: (v: string[]) => void, id: string) => set(list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);

  const submit = async () => {
    setSaving(true);
    setError(null);
    try {
      await adminApi.post(`/api/doctor/patients/${patientId}/lab-orders`, { idempotencyKey: key, appointmentId, testIds, panelIds });
      onOrdered(everyTest.length);
    } catch (e) {
      setError(errorText(e, "Buyurtmani saqlab bo‘lmadi"));
    } finally {
      setSaving(false);
    }
  };

  const nothing = testIds.length + panelIds.length === 0;

  return (
    <AModal
      title={step === "choose" ? "Tahlil buyurtma qilish" : "Buyurtmani tekshiring"}
      onClose={onClose}
      maxWidth="max-w-2xl"
      footer={
        step === "choose" ? (
          <>
            <AButton variant="ghost" onClick={onClose}>Bekor qilish</AButton>
            <AButton onClick={() => setStep("review")} disabled={nothing}>Ko‘rib chiqish</AButton>
          </>
        ) : (
          <>
            <AButton variant="ghost" onClick={() => setStep("choose")}>Orqaga</AButton>
            <AButton onClick={submit} loading={saving} disabled={nothing}>Buyurtma berish</AButton>
          </>
        )
      }
    >
      {error && <AError message={error} />}
      {catalog === null ? (
        <div className="h-2 w-full animate-pulse rounded bg-hairline" />
      ) : step === "choose" ? (
        <>
          <AInput value={query} onChange={setQuery} placeholder="Tahlil nomi yoki kodi bo‘yicha qidirish" aria-label="Tahlil qidirish" />
          {catalog.tests.length === 0 && catalog.panels.length === 0 && (
            <AEmpty title="Buyurtma qilinadigan tahlil yo‘q" subtitle="Klinika laboratoriya katalogini hali sozlamagan" />
          )}
          {catalog.panels.some((p) => matches(p.name, p.code)) && (
            <div>
              <p className="mb-1 text-xs font-medium uppercase tracking-wide text-ink-muted">Panellar</p>
              <div className="flex flex-col gap-1">
                {catalog.panels.filter((p) => matches(p.name, p.code)).map((p) => (
                  <label key={p.id} className="flex items-start gap-2 rounded-lg px-2 py-1.5 text-sm hover:bg-sand">
                    <input type="checkbox" className="mt-1" checked={panelIds.includes(p.id)} onChange={() => toggle(panelIds, setPanelIds, p.id)} />
                    <span className="flex-1">
                      <span className="font-medium text-foreground">{p.name}</span>
                      <span className="block text-xs text-ink-muted">{p.testIds.map((id) => testsById.get(id)?.name).filter(Boolean).join(", ")}</span>
                    </span>
                    <span className="font-numeric text-xs text-ink-muted">{formatPrice(p.price)}</span>
                  </label>
                ))}
              </div>
            </div>
          )}
          <div className="flex max-h-80 flex-col gap-1 overflow-y-auto">
            {catalog.tests.filter((t) => matches(t.name, t.code)).map((t) => {
              const covered = inPanels.has(t.id);
              return (
                <label key={t.id} className={`flex items-start gap-2 rounded-lg px-2 py-1.5 text-sm hover:bg-sand ${covered ? "opacity-50" : ""}`}>
                  <input
                    type="checkbox"
                    className="mt-1"
                    disabled={covered}
                    checked={testIds.includes(t.id)}
                    onChange={() => toggle(testIds, setTestIds, t.id)}
                  />
                  <span className="flex-1">
                    <span className="font-medium text-foreground">{t.name}</span> <span className="font-numeric text-xs text-ink-muted">{t.code}</span>
                    <span className="block text-xs text-ink-muted">
                      {[t.category, t.sampleType, t.turnaroundHours ? `~${t.turnaroundHours} soat` : null, covered ? "tanlangan panel ichida" : null]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                  </span>
                  <span className="font-numeric text-xs text-ink-muted">{formatPrice(t.price)}</span>
                </label>
              );
            })}
          </div>
        </>
      ) : (
        <>
          {recent.map((r) => (
            <div key={r.testId} className="rounded-xl border border-clay/40 bg-clay-tint p-3 text-sm" role="status">
              <p className="font-medium text-foreground">Shunga o‘xshash tahlil topildi:</p>
              <p className="text-foreground">
                {r.test.name} — {r.daysAgo === 0 ? "bugun" : `${r.daysAgo} kun oldin`} ({LAB_ITEM_STATUS[r.status]?.label ?? r.status})
              </p>
              <div className="mt-2 flex gap-2">
                {r.status === "verified" && (
                  <AButton size="sm" variant="outline" onClick={() => onViewResult(r.itemId)}>Natijani ko‘rish</AButton>
                )}
                <AButton size="sm" variant="ghost" onClick={() => setDismissed((d) => [...d, r.testId])}>Buyurtmani davom ettirish</AButton>
              </div>
            </div>
          ))}
          <ul className="flex flex-col gap-1 text-sm">
            {selectedPanels.map((p) => (
              <li key={p.id} className="flex justify-between gap-2">
                <span>{p.name} <span className="text-xs text-ink-muted">(panel)</span></span>
                <span className="font-numeric">{formatPrice(p.price)}</span>
              </li>
            ))}
            {selectedTests.map((t) => (
              <li key={t.id} className="flex justify-between gap-2">
                <span>{t.name}</span>
                <span className="font-numeric">{formatPrice(t.price)}</span>
              </li>
            ))}
            <li className="mt-1 flex justify-between gap-2 border-t border-hairline pt-1 font-semibold">
              <span>Jami</span>
              <span className="font-numeric">{formatPrice(total)}</span>
            </li>
          </ul>
          {preparations.length > 0 && (
            <div className="rounded-xl bg-sand p-3 text-sm">
              <p className="mb-1 font-medium text-foreground">Bemor uchun tayyorgarlik</p>
              <ul className="list-disc pl-5 text-ink-muted">
                {preparations.map((t) => (
                  <li key={t.id}>
                    <span className="text-foreground">{t.name}:</span> {t.preparationText}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <p className="text-xs text-ink-muted">Narxlar katalogdan olinadi va buyurtma paytida saqlanadi. To‘lov alohida, qabulxonada qayd etiladi.</p>
        </>
      )}
    </AModal>
  );
}

export function LabResultDialog({ patientId, itemId, onClose }: { patientId: string; itemId: string; onClose: () => void }) {
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    adminApi
      .get<{ result: Result }>(`/api/doctor/patients/${patientId}/lab-results/${itemId}`)
      .then((r) => setResult(r.result))
      .catch((e) => setError(errorText(e, "Natijani yuklab bo‘lmadi")));
  }, [patientId, itemId]);

  return (
    <AModal title={result?.testName ?? "Tahlil natijasi"} onClose={onClose} maxWidth="max-w-2xl" footer={<AButton variant="ghost" onClick={onClose}>Yopish</AButton>}>
      {error && <AError message={error} />}
      {!result && !error && <div className="h-2 w-full animate-pulse rounded bg-hairline" />}
      {result && (
        <>
          <p className="text-xs text-ink-muted">
            Buyurtma: {formatDateTime(result.orderedAt)} · Bajarilgan: {formatDateTime(result.performedAt)} · Tasdiqlangan: {formatDateTime(result.verifiedAt)}
            {result.version > 1 ? ` · tuzatilgan (${result.version}-versiya)` : ""}
          </p>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-ink-muted">
                <th className="py-1 pr-2">Ko‘rsatkich</th>
                <th className="py-1 pr-2">Natija</th>
                <th className="py-1 pr-2">Me’yor</th>
                <th className="py-1">Holat</th>
              </tr>
            </thead>
            <tbody>
              {result.values.map((v) => {
                const flag = LAB_FLAG[v.flag] ?? { label: v.flag, tone: "neutral" as const };
                return (
                  <tr key={v.parameter} className="border-t border-hairline">
                    <td className="py-1.5 pr-2 text-foreground">{v.parameter}</td>
                    <td className="font-numeric py-1.5 pr-2 font-semibold text-foreground">
                      {v.value}
                      {v.unit ? ` ${v.unit}` : ""}
                    </td>
                    <td className="font-numeric py-1.5 pr-2 text-ink-muted">{v.rangeLabel ?? "—"}</td>
                    <td className="py-1.5"><ABadge tone={flag.tone}>{flag.label}</ABadge></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {result.labComment && <p className="text-sm text-ink-muted">Laboratoriya izohi: {result.labComment}</p>}
          <p className="text-xs text-ink-muted">Holat klinikada sozlangan me’yorga nisbatan ko‘rsatiladi; bu tashxis emas.</p>
        </>
      )}
    </AModal>
  );
}

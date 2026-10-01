"use client";

import { useCallback, useEffect, useState } from "react";
import { ClipboardList } from "lucide-react";
import { PageHeader, Card, ABadge, AEmpty, AError, AButton, AModal, ATextArea, LoadingRow } from "@/components/admin/ui";
import { adminApi, AdminApiError, formatDateTime } from "@/lib/admin/client";
import type { WorklistOrder, WorklistSample } from "@/lib/labs/samples";

const SAMPLE_LABELS: Record<string, { label: string; tone: "neutral" | "amber" | "green" | "red" | "blue" }> = {
  awaiting_collection: { label: "Olinishi kutilmoqda", tone: "amber" },
  collected: { label: "Olindi", tone: "blue" },
  processing: { label: "Ishlovda", tone: "green" },
  rejected: { label: "Rad etildi", tone: "red" },
};

const PAYMENT_LABELS: Record<string, string> = {
  paid: "To‘langan",
  unpaid: "To‘lanmagan",
  pending: "To‘lov kutilmoqda",
  manual_review: "To‘lov tekshiruvda",
  failed: "To‘lov amalga oshmadi",
  refunded: "Qaytarilgan",
};

/**
 * The bench's worklist (phase 5): open orders, who they are for, the tests and sample types, whether payment
 * stands in the way of collection (the clinic's policy, decided by the server), and the samples with the
 * next step. Every button only asks; the server and the database decide, and a refusal is shown as it is.
 */
export default function LabWorklistPage() {
  const [data, setData] = useState<{ requiresPayment: boolean; orders: WorklistOrder[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState<WorklistSample | null>(null);
  const [reason, setReason] = useState("");

  const load = useCallback(async () => {
    try {
      setData(await adminApi.get("/api/lab/worklist"));
    } catch (e) {
      setError(e instanceof AdminApiError ? e.message : "Ish ro‘yxatini yuklab bo‘lmadi");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const run = async (key: string, call: () => Promise<unknown>) => {
    setBusy(key);
    setError(null);
    try {
      await call();
    } catch (e) {
      setError(e instanceof AdminApiError ? e.message : "Amalni bajarib bo‘lmadi");
    } finally {
      await load();
      setBusy(null);
    }
  };

  const prepare = (orderId: string) => run(`o-${orderId}`, () => adminApi.post(`/api/lab/orders/${orderId}/samples`));
  const step = (sampleId: string, body: Record<string, unknown>) => run(`s-${sampleId}`, () => adminApi.post(`/api/lab/samples/${sampleId}`, body));

  return (
    <div>
      <PageHeader title="Ish ro‘yxati" subtitle="Ochiq buyurtmalar: namuna tayyorlash va olish" />
      {error && <AError message={error} />}
      {data === null ? (
        <Card>
          <LoadingRow />
        </Card>
      ) : data.orders.length === 0 ? (
        <Card>
          <AEmpty title="Ochiq buyurtma yo‘q" subtitle="Shifokorlar tahlil buyurtma qilgach shu yerda ko‘rinadi" icon={<ClipboardList className="h-6 w-6" />} />
        </Card>
      ) : (
        <ul className="flex flex-col gap-3">
          {data.orders.map((o) => {
            const waiting = o.readiness === "awaiting_payment";
            const live = o.samples.filter((s) => s.status !== "rejected");
            return (
              <li key={o.orderId}>
                <Card>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <p className="text-sm font-bold text-foreground">{o.patient.fullName ?? "—"}</p>
                      <p className="text-xs text-ink-muted">
                        {formatDateTime(o.createdAt)}
                        {o.orderedBy ? ` · ${o.orderedBy}` : ""}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      {o.priority === "urgent" && <ABadge tone="red">Shoshilinch</ABadge>}
                      <ABadge tone={o.paymentStatus === "paid" ? "green" : "amber"}>{o.paymentStatus ? PAYMENT_LABELS[o.paymentStatus] ?? o.paymentStatus : "—"}</ABadge>
                    </div>
                  </div>
                  <p className="mt-2 text-sm text-foreground">{o.tests.map((t) => t.name).join(", ")}</p>
                  {waiting && (
                    <p className="mt-2 text-sm text-clay-deep" role="status">
                      Klinika namuna olishdan oldin to‘lovni talab qiladi — to‘lov hali qabul qilinmagan.
                    </p>
                  )}

                  {live.length === 0 ? (
                    <div className="mt-3">
                      <AButton size="sm" loading={busy === `o-${o.orderId}`} onClick={() => void prepare(o.orderId)}>
                        Namunalarni tayyorlash
                      </AButton>
                    </div>
                  ) : (
                    <ul className="mt-3 divide-y divide-hairline/70 rounded-lg border border-hairline">
                      {o.samples.map((s) => (
                        <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
                          <span>
                            <span className="font-numeric font-medium text-foreground">{s.code}</span>{" "}
                            <span className="text-ink-muted">· {s.sampleType} · {s.tests.join(", ")}</span>
                          </span>
                          <span className="flex items-center gap-2">
                            <ABadge tone={SAMPLE_LABELS[s.status]?.tone ?? "neutral"}>{SAMPLE_LABELS[s.status]?.label ?? s.status}</ABadge>
                            {s.status === "awaiting_collection" && (
                              <>
                                <AButton size="sm" disabled={waiting} loading={busy === `s-${s.id}`} onClick={() => void step(s.id, { action: "collect" })}>
                                  Namuna olindi
                                </AButton>
                                <AButton size="sm" variant="ghost" disabled={busy === `s-${s.id}`} onClick={() => void step(s.id, { action: "cancel" })}>
                                  Bekor qilish
                                </AButton>
                              </>
                            )}
                            {s.status === "collected" && (
                              <>
                                <AButton size="sm" loading={busy === `s-${s.id}`} onClick={() => void step(s.id, { action: "process" })}>
                                  Ishlovga olish
                                </AButton>
                                <AButton size="sm" variant="ghost" onClick={() => { setReason(""); setRejecting(s); }}>
                                  Rad etish
                                </AButton>
                              </>
                            )}
                            {s.status === "processing" && (
                              <AButton size="sm" variant="ghost" onClick={() => { setReason(""); setRejecting(s); }}>
                                Rad etish
                              </AButton>
                            )}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                  {live.length > 0 && o.samples.some((s) => s.status === "rejected") && (
                    <div className="mt-2">
                      <AButton size="sm" variant="outline" loading={busy === `o-${o.orderId}`} onClick={() => void prepare(o.orderId)}>
                        Rad etilgan namuna o‘rniga yangisini tayyorlash
                      </AButton>
                    </div>
                  )}
                </Card>
              </li>
            );
          })}
        </ul>
      )}

      {rejecting && (
        <AModal
          title="Namunani rad etish"
          onClose={() => setRejecting(null)}
          footer={
            <>
              <AButton variant="ghost" onClick={() => setRejecting(null)}>
                Bekor qilish
              </AButton>
              <AButton
                disabled={reason.trim().length < 3}
                onClick={() => {
                  const id = rejecting.id;
                  setRejecting(null);
                  void step(id, { action: "reject", reason: reason.trim() });
                }}
              >
                Rad etish
              </AButton>
            </>
          }
        >
          <p className="mb-2 text-sm text-ink-muted">Namuna {rejecting.code}: sababini qisqa yozing (masalan, “gemoliz”). Bemorning kasalligi haqida yozmang.</p>
          <ATextArea value={reason} onChange={setReason} rows={3} aria-label="Rad etish sababi" />
        </AModal>
      )}
    </div>
  );
}

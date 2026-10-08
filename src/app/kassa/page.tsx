"use client";

import { useState } from "react";
import { PageHeader, Card, ABadge, AEmpty, AError, AButton, AModal, AInput, ASelect } from "@/components/admin/ui";
import { adminApi, AdminApiError } from "@/lib/admin/client";
import { freshnessLabel, money, useLive, VISIT_STATUS } from "@/components/operations/use-live";
import { Wallet } from "lucide-react";

/**
 * Kassa (outpatient pilot). Each visit's itemized bill with what was
 * charged, received, paid back and is still due. Receiving money records it
 * once per method (a second printed receipt is not a second payment) and,
 * when the bill is settled, the database issues the queue number. Refunds
 * follow the clinic's rule: owner/manager, or a cashier with a manager's
 * grant. Nothing here is a fiscal receipt or a bank/terminal transaction,
 * and collected money is not profit.
 */

type Charge = { id: string; serviceName: string; amount: number; status: "active" | "voided"; voidReason: string | null; isLabTest: boolean };
type Balance = { charged: number; collected: number; refunded: number; outstanding: number; cashNet: number; terminalNet: number };
type Visit = {
  id: string;
  status: string;
  queueNumber: number | null;
  arrivedAt: string;
  kind: "doctor" | "lab";
  patient: { id: string; patientNumber: number; fullName: string | null };
  doctor: { id: string; name: string } | null;
  balance: Balance;
  charges: Charge[];
};
type KassaData = { open: Visit[]; closed: Visit[]; canRefund: boolean; canManageRefundGrants: boolean; currency: string };
type Totals = {
  scope: "mine" | "clinic";
  byMethod: Record<"cash" | "terminal", { collected: number; refunded: number; net: number }>;
  byStaff: Array<{ profileId: string; name: string | null; collected: number; refunded: number }>;
};
type Grants = { cashiers: Array<{ profileId: string; name: string | null; grant: { grantedAt: string } | null }> };

const newKey = () => crypto.randomUUID();
const toNum = (s: string) => (s.trim() === "" ? 0 : Number(s.replace(",", ".")));

export default function KassaPage() {
  const kassa = useLive<KassaData>("/api/operations/kassa", 10_000);
  const totals = useLive<Totals>("/api/operations/kassa/totals", 30_000);
  const grants = useLive<Grants>(kassa.data?.canManageRefundGrants ? "/api/operations/refund-grants" : null, 60_000);
  const currency = kassa.data?.currency ?? "UZS";
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Payment modal
  const [paying, setPaying] = useState<Visit | null>(null);
  const [cash, setCash] = useState("");
  const [terminal, setTerminal] = useState("");
  const [payKey, setPayKey] = useState(newKey);
  const [busy, setBusy] = useState(false);

  // Refund modal
  const [refunding, setRefunding] = useState<Visit | null>(null);
  const [refundMethod, setRefundMethod] = useState<"cash" | "terminal">("cash");
  const [refundAmount, setRefundAmount] = useState("");
  const [refundReason, setRefundReason] = useState("");
  const [refundKey, setRefundKey] = useState(newKey);

  // Void a wrong line
  const [voiding, setVoiding] = useState<Charge | null>(null);
  const [voidReason, setVoidReason] = useState("");

  const refreshAll = async () => {
    await Promise.all([kassa.reload(), totals.reload()]);
  };

  const openPay = (v: Visit) => {
    setPaying(v);
    setCash(String(v.balance.outstanding));
    setTerminal("");
    setPayKey(newKey());
    setError(null);
  };

  const pay = async () => {
    if (!paying) return;
    setBusy(true);
    setError(null);
    const lines = [
      { method: "cash" as const, amount: toNum(cash) },
      { method: "terminal" as const, amount: toNum(terminal) },
    ].filter((l) => l.amount > 0);
    try {
      const r = await adminApi.post<{ queueNumber: number | null }>(`/api/operations/kassa/${paying.id}/pay`, {
        key: payKey,
        expectedOutstanding: paying.balance.outstanding,
        lines,
      });
      setNotice(
        r.queueNumber
          ? `To‘lov qabul qilindi. Navbat raqami: ${r.queueNumber} — bemorga ayting (Telegram bo‘lsa, unga ham yuboriladi).`
          : "To‘lov qabul qilindi.",
      );
      setPaying(null);
      await refreshAll();
    } catch (e) {
      if (e instanceof AdminApiError) {
        setError(e.message);
        if (e.status < 500) setPayKey(newKey());
      } else {
        // Unknown outcome: keep the key so pressing again cannot record it twice.
        setError("Aloqa uzildi — to‘lov saqlanganmi, noma’lum. Qayta bosing: takroriy yozuv yaratilmaydi.");
      }
    } finally {
      setBusy(false);
    }
  };

  const refund = async () => {
    if (!refunding) return;
    setBusy(true);
    setError(null);
    try {
      await adminApi.post(`/api/operations/kassa/${refunding.id}/refund`, {
        key: refundKey,
        method: refundMethod,
        amount: toNum(refundAmount),
        reason: refundReason,
      });
      setNotice("Qaytarish qayd etildi. Pulni bemorga bering (naqd) yoki terminal orqali qaytaring.");
      setRefunding(null);
      await refreshAll();
    } catch (e) {
      if (e instanceof AdminApiError) {
        setError(e.message);
        if (e.status < 500) setRefundKey(newKey());
      } else {
        setError("Aloqa uzildi — qaytarish saqlanganmi, noma’lum. Qayta bosing: takroriy yozuv yaratilmaydi.");
      }
    } finally {
      setBusy(false);
    }
  };

  const voidCharge = async () => {
    if (!voiding) return;
    setError(null);
    try {
      await adminApi.post(`/api/operations/charges/${voiding.id}/void`, { reason: voidReason });
      setVoiding(null);
      setVoidReason("");
      await refreshAll();
    } catch (e) {
      setError(e instanceof AdminApiError ? e.message : "Qatorni olib tashlab bo‘lmadi");
    }
  };

  const setGrant = async (cashierId: string, give: boolean) => {
    setError(null);
    try {
      if (give) await adminApi.post("/api/operations/refund-grants", { cashierId });
      else {
        const reason = window.prompt("Ruxsatni olish sababi")?.trim() ?? "";
        if (reason.length < 3) return;
        await fetch("/api/operations/refund-grants", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ cashierId, reason }),
        }).then(async (r) => {
          if (!r.ok) throw new AdminApiError(r.status, (await r.json().catch(() => ({})))?.error ?? "Xatolik");
        });
      }
      await grants.reload();
    } catch (e) {
      setError(e instanceof AdminApiError ? e.message : "Ruxsatni o‘zgartirib bo‘lmadi");
    }
  };

  const payTotal = toNum(cash) + toNum(terminal);

  const visitCard = (v: Visit, mode: "due" | "other") => (
    <Card key={v.id}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="font-semibold">{v.patient.fullName}</p>
          <p className="text-xs text-ink-muted">
            Karta № {v.patient.patientNumber} · {v.kind === "lab" ? "Laboratoriya" : v.doctor?.name}
            {v.queueNumber ? ` · navbat № ${v.queueNumber}` : ""}
          </p>
        </div>
        <ABadge tone={VISIT_STATUS[v.status]?.tone}>{VISIT_STATUS[v.status]?.label ?? v.status}</ABadge>
      </div>
      <ul className="mt-3 divide-y divide-hairline text-sm" aria-label="Xizmatlar">
        {v.charges.map((c) => (
          <li key={c.id} className="flex items-center justify-between gap-2 py-1.5">
            <span className={c.status === "voided" ? "text-ink-muted line-through" : ""}>
              {c.serviceName}
              {c.status === "voided" && c.voidReason ? <span className="ml-1 text-xs no-underline">({c.voidReason})</span> : null}
            </span>
            <span className="flex items-center gap-2">
              <span className="font-numeric">{money(c.amount, currency)}</span>
              {c.status === "active" && mode === "due" && !c.isLabTest && (
                <AButton size="sm" variant="ghost" onClick={() => setVoiding(c)}>
                  Olib tashlash
                </AButton>
              )}
              {c.status === "active" && c.isLabTest && <span className="text-[11px] text-ink-muted">tahlil — laboratoriyada bekor qilinadi</span>}
            </span>
          </li>
        ))}
      </ul>
      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-4">
        <div>
          <dt className="text-xs text-ink-muted">Hisoblangan</dt>
          <dd className="font-numeric">{money(v.balance.charged, currency)}</dd>
        </div>
        <div>
          <dt className="text-xs text-ink-muted">To‘langan</dt>
          <dd className="font-numeric">{money(v.balance.collected, currency)}</dd>
        </div>
        <div>
          <dt className="text-xs text-ink-muted">Qaytarilgan</dt>
          <dd className="font-numeric">{money(v.balance.refunded, currency)}</dd>
        </div>
        <div>
          <dt className="text-xs text-ink-muted">{v.balance.outstanding < 0 ? "Qaytarilishi kerak" : "Qarz"}</dt>
          <dd className={`font-numeric font-semibold ${v.balance.outstanding < 0 ? "text-danger" : ""}`}>{money(Math.abs(v.balance.outstanding), currency)}</dd>
        </div>
      </dl>
      <div className="mt-3 flex flex-wrap justify-end gap-2">
        {v.balance.outstanding > 0 && v.status !== "cancelled" && <AButton onClick={() => openPay(v)}>To‘lov qabul qilish</AButton>}
        {kassa.data?.canRefund && v.balance.collected - v.balance.refunded > 0 && (
          <AButton
            variant="outline"
            onClick={() => {
              setRefunding(v);
              setRefundMethod(v.balance.cashNet > 0 ? "cash" : "terminal");
              setRefundAmount("");
              setRefundReason("");
              setRefundKey(newKey());
              setError(null);
            }}
          >
            Qaytarish
          </AButton>
        )}
      </div>
    </Card>
  );

  // A finished consultation can still owe for tests the doctor ordered in it.
  const all = [...(kassa.data?.open ?? []), ...(kassa.data?.closed ?? [])];
  const isDue = (v: Visit) => v.balance.outstanding > 0 && v.status !== "cancelled";
  const due = all.filter(isDue);
  const others = all.filter((v) => !isDue(v));

  return (
    <div className="flex flex-col gap-5">
      <PageHeader title="Kassa" subtitle="Xizmatlar to‘lovi. Navbat raqami to‘liq to‘lovdan so‘ng beriladi." />
      <p className={`-mt-3 text-xs ${kassa.stale ? "font-semibold text-danger" : "text-ink-muted"}`}>{freshnessLabel(kassa.updatedAt, kassa.stale)}</p>
      {error && <AError message={error} />}
      {notice && (
        <div role="status" className="rounded-xl border border-pine/25 bg-pine-tint px-4 py-3 text-sm font-medium text-pine-deep">
          {notice}
        </div>
      )}

      <section aria-label="To‘lov kutilmoqda" className="flex flex-col gap-3">
        <p className="text-xs font-semibold uppercase tracking-wide text-ink-muted">To‘lov kutilmoqda</p>
        {!kassa.data ? (
          <p className="text-sm text-ink-muted">{kassa.error ?? "Yuklanmoqda…"}</p>
        ) : due.length === 0 ? (
          <Card>
            <AEmpty title="To‘lov kutayotgan bemor yo‘q" icon={<Wallet className="h-6 w-6" />} />
          </Card>
        ) : (
          due.map((v) => visitCard(v, "due"))
        )}
      </section>

      {others.length > 0 && (
        <section aria-label="Bugungi tashriflar" className="flex flex-col gap-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-ink-muted">Bugungi tashriflar</p>
          {others.map((v) => visitCard(v, "other"))}
        </section>
      )}

      <section aria-label="Kassa hisoboti">
        <Card>
          <p className="font-display text-sm font-bold">
            Bugun kassaga tushgan pul {totals.data?.scope === "mine" ? "(siz qabul qilgan)" : "(klinika bo‘yicha)"}
          </p>
          <p className="mb-3 text-xs text-ink-muted">Qabul qilingan va qaytarilgan pul — daromad yoki foyda emas. Kassadagi naqd va terminal hisobotiga solishtiring.</p>
          {totals.data ? (
            <div className="grid gap-3 sm:grid-cols-2">
              {(["cash", "terminal"] as const).map((m) => (
                <div key={m} className="rounded-xl border border-hairline p-3 text-sm">
                  <p className="font-semibold">{m === "cash" ? "Naqd" : "Karta terminali"}</p>
                  <p>Qabul qilingan: <span className="font-numeric">{money(totals.data!.byMethod[m].collected, currency)}</span></p>
                  <p>Qaytarilgan: <span className="font-numeric">{money(totals.data!.byMethod[m].refunded, currency)}</span></p>
                  <p className="font-semibold">Sof: <span className="font-numeric">{money(totals.data!.byMethod[m].net, currency)}</span></p>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-ink-muted">{totals.error ?? "Yuklanmoqda…"}</p>
          )}
          {totals.data?.scope === "clinic" && totals.data.byStaff.length > 0 && (
            <ul className="mt-3 text-sm">
              {totals.data.byStaff.map((s) => (
                <li key={s.profileId}>
                  {s.name ?? s.profileId.slice(0, 8)}: qabul {money(s.collected, currency)}, qaytarish {money(s.refunded, currency)}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </section>

      {grants.data && (
        <section aria-label="Qaytarish ruxsatlari">
          <Card>
            <p className="font-display text-sm font-bold">Kassirlarga qaytarish ruxsati</p>
            <p className="mb-3 text-xs text-ink-muted">Kassir pulni faqat siz bergan ruxsat bilan qaytara oladi. Kim ruxsat bergani va kim qaytargani saqlanadi.</p>
            {grants.data.cashiers.length === 0 ? (
              <p className="text-sm text-ink-muted">Kassir yo‘q.</p>
            ) : (
              grants.data.cashiers.map((c) => (
                <div key={c.profileId} className="flex items-center justify-between gap-2 border-t border-hairline py-2 text-sm">
                  <span>
                    {c.name ?? c.profileId.slice(0, 8)} {c.grant ? <ABadge tone="green">Ruxsat bor</ABadge> : <ABadge tone="gray">Ruxsat yo‘q</ABadge>}
                  </span>
                  <AButton size="sm" variant={c.grant ? "outline" : "secondary"} onClick={() => setGrant(c.profileId, !c.grant)}>
                    {c.grant ? "Ruxsatni olish" : "Ruxsat berish"}
                  </AButton>
                </div>
              ))
            )}
          </Card>
        </section>
      )}

      {paying && (
        <AModal
          title="To‘lov qabul qilish"
          onClose={() => setPaying(null)}
          footer={
            <>
              <AButton variant="outline" onClick={() => setPaying(null)}>
                Yopish
              </AButton>
              <AButton onClick={pay} loading={busy} disabled={payTotal !== paying.balance.outstanding}>
                Qabul qilish
              </AButton>
            </>
          }
        >
          <p className="text-sm">
            {paying.patient.fullName} — to‘lanadigan summa: <span className="font-numeric font-semibold">{money(paying.balance.outstanding, currency)}</span>
          </p>
          <label className="text-xs font-medium">
            Naqd
            <AInput value={cash} onChange={setCash} aria-label="Naqd summa" />
          </label>
          <label className="text-xs font-medium">
            Karta terminali
            <AInput value={terminal} onChange={setTerminal} aria-label="Terminal summa" />
          </label>
          <p className={`text-xs ${payTotal === paying.balance.outstanding ? "text-ink-muted" : "font-semibold text-danger"}`}>
            Jami: {money(payTotal, currency)} {payTotal === paying.balance.outstanding ? "" : "— summa qarzga teng bo‘lishi kerak"}
          </p>
          <p className="text-[11px] text-ink-muted">Terminal chekining ikkinchi nusxasi alohida to‘lov emas — bir marta kiriting.</p>
        </AModal>
      )}

      {refunding && (
        <AModal
          title="Pulni qaytarish"
          onClose={() => setRefunding(null)}
          footer={
            <>
              <AButton variant="outline" onClick={() => setRefunding(null)}>
                Yopish
              </AButton>
              <AButton variant="danger" onClick={refund} loading={busy} disabled={toNum(refundAmount) <= 0 || refundReason.trim().length < 3}>
                Qaytarishni qayd etish
              </AButton>
            </>
          }
        >
          <p className="text-sm">
            {refunding.patient.fullName}. Naqd: {money(refunding.balance.cashNet, currency)} · Terminal: {money(refunding.balance.terminalNet, currency)}
          </p>
          <ASelect
            value={refundMethod}
            onChange={(v) => setRefundMethod(v as "cash" | "terminal")}
            aria-label="Qaytarish usuli"
            options={[
              { value: "cash", label: "Naqd" },
              { value: "terminal", label: "Karta terminali" },
            ]}
          />
          <AInput value={refundAmount} onChange={setRefundAmount} placeholder="Summa" aria-label="Qaytarish summasi" />
          <AInput value={refundReason} onChange={setRefundReason} placeholder="Sabab" aria-label="Qaytarish sababi" />
        </AModal>
      )}

      {voiding && (
        <AModal
          title="Xizmatni olib tashlash"
          onClose={() => setVoiding(null)}
          footer={
            <>
              <AButton variant="outline" onClick={() => setVoiding(null)}>
                Yopish
              </AButton>
              <AButton variant="danger" onClick={voidCharge} disabled={voidReason.trim().length < 3}>
                Olib tashlash
              </AButton>
            </>
          }
        >
          <p className="text-sm">
            {voiding.serviceName} — {money(voiding.amount, currency)}. Qator o‘chirilmaydi: sababi bilan bekor qilingan deb belgilanadi.
          </p>
          <AInput value={voidReason} onChange={setVoidReason} placeholder="Sabab (masalan: noto‘g‘ri xizmat)" aria-label="Olib tashlash sababi" />
        </AModal>
      )}
    </div>
  );
}

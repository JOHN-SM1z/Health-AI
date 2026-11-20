"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { CreditCard, Check, Printer } from "lucide-react";
import { PageHeader, Card, ABadge, ATable, AError, AButton, ASelect, LoadingRow } from "@/components/admin/ui";
import { adminApi, AdminApiError } from "@/lib/admin/client";
import { formatUzs, STATUS_LABEL, type Plan, type SubscriptionView } from "@/lib/billing/status";

type Invoice = { id: string; number: string; amountUzs: number; months: number; status: "issued" | "paid" | "void"; issuedAt: string; dueAt: string; paidAt: string | null; planName: string };
type Payee = { legalName: string; tin: string; bankName: string; bankAccount: string; mfo: string; contactPhone: string };
type Overview = { subscription: SubscriptionView | null; invoices: Invoice[]; payee: Payee; plans: Plan[] };

const date = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("uz-UZ", { day: "2-digit", month: "2-digit", year: "numeric" }) : "—");
const INVOICE_STATUS: Record<Invoice["status"], { label: string; tone: "amber" | "green" | "neutral" }> = {
  issued: { label: "To‘lanmagan", tone: "amber" },
  paid: { label: "To‘langan", tone: "green" },
  void: { label: "Bekor qilingan", tone: "neutral" },
};

/**
 * The clinic owner's subscription: current plan and status, the open invoice with the bank details to transfer to,
 * and plan changes. A payment counts once the platform confirms the transfer arrived — this page never marks
 * anything paid.
 */
export default function BillingPage() {
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [months, setMonths] = useState("1");
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await adminApi.get<Overview>("/api/admin/billing"));
    } catch (e) {
      setError(e instanceof AdminApiError && e.status === 403 ? "Obunani faqat klinika egasi boshqaradi." : "Obuna ma’lumotlarini yuklab bo‘lmadi");
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const post = async (key: string, body: unknown) => {
    setBusy(key);
    setError(null);
    try {
      await adminApi.post("/api/admin/billing", body);
      await load();
    } catch (e) {
      setError(e instanceof AdminApiError ? e.message : "Amalni bajarib bo‘lmadi");
    } finally {
      setBusy(null);
    }
  };

  const sub = data?.subscription ?? null;
  const open = data?.invoices.find((i) => i.status === "issued") ?? null;
  const payeeReady = !!data && !!data.payee.bankAccount && !!data.payee.tin;

  return (
    <div>
      <PageHeader title="Obuna" subtitle="Tarif, to‘lov va hisob-fakturalar" />
      {error && <AError message={error} />}
      {!data ? (
        <Card>
          <LoadingRow />
        </Card>
      ) : (
        <div className="flex flex-col gap-4">
          <Card className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <p className="font-numeric text-[11px] uppercase tracking-[0.16em] text-ink-muted">Joriy tarif</p>
              <p className="font-display mt-1 text-2xl font-bold text-foreground">{sub ? sub.plan.name : "Pilot"}</p>
              {sub && (
                <p className="mt-1 text-sm text-ink-muted">
                  {sub.status === "trialing" && `Bepul sinov davri ${date(sub.trialEndsAt)} gacha (${sub.daysLeft} kun qoldi)`}
                  {sub.status === "trial_ended" && `Sinov davri ${date(sub.trialEndsAt)} da tugadi — to‘lovdan so‘ng ish davom etadi`}
                  {sub.status === "active" && (sub.currentPeriodEnd ? `To‘langan: ${date(sub.currentPeriodEnd)} gacha` : "Muddatsiz (pilot)")}
                  {sub.status === "past_due" && `To‘lov muddati ${date(sub.currentPeriodEnd)} da o‘tdi`}
                </p>
              )}
            </div>
            {sub && (
              <ABadge tone={sub.status === "active" ? "green" : sub.status === "trialing" ? "blue" : "red"}>{STATUS_LABEL[sub.status]}</ABadge>
            )}
          </Card>

          {sub && (
            <Card className="flex flex-col gap-3">
              <p className="text-sm font-bold text-foreground">To‘lov</p>
              {open ? (
                <div className="grid gap-4 md:grid-cols-2">
                  <div className="rounded-xl bg-sand p-4">
                    <p className="text-xs text-ink-muted">Hisob-faktura</p>
                    <p className="font-numeric text-lg font-semibold">{open.number}</p>
                    <p className="font-display mt-2 text-2xl font-bold text-pine-deep">{formatUzs(open.amountUzs)}</p>
                    <p className="text-xs text-ink-muted">
                      {open.planName}, {open.months} oy · to‘lov muddati {date(open.dueAt)}
                    </p>
                    <Link href={`/admin/billing/invoice/${open.id}`} target="_blank" className="mt-3 inline-flex items-center gap-1.5 text-sm font-semibold text-pine hover:underline">
                      <Printer className="h-4 w-4" /> Chop etish / PDF
                    </Link>
                  </div>
                  <div className="text-sm">
                    {payeeReady ? (
                      <dl className="grid grid-cols-[8rem_1fr] gap-x-3 gap-y-1.5">
                        <dt className="text-ink-muted">Oluvchi</dt>
                        <dd className="font-medium">{data.payee.legalName}</dd>
                        <dt className="text-ink-muted">STIR</dt>
                        <dd className="font-numeric">{data.payee.tin}</dd>
                        <dt className="text-ink-muted">Bank</dt>
                        <dd>{data.payee.bankName}</dd>
                        <dt className="text-ink-muted">Hisob raqam</dt>
                        <dd className="font-numeric break-all">{data.payee.bankAccount}</dd>
                        <dt className="text-ink-muted">MFO</dt>
                        <dd className="font-numeric">{data.payee.mfo}</dd>
                        <dt className="text-ink-muted">To‘lov maqsadi</dt>
                        <dd>Health AI obunasi, hisob-faktura {open.number}</dd>
                      </dl>
                    ) : (
                      <p className="text-ink-muted">Bank rekvizitlari tez orada shu yerda ko‘rinadi. Hozircha {data.payee.contactPhone || "Health AI jamoasi"} bilan bog‘laning.</p>
                    )}
                    <p className="mt-3 text-xs leading-relaxed text-ink-muted">
                      Bank o‘tkazmasi kelib tushgach, Health AI uni tasdiqlaydi va obuna avtomatik faollashadi (odatda 1 ish kuni).
                    </p>
                  </div>
                </div>
              ) : (
                <p className="text-sm text-ink-muted">Ochiq hisob-faktura yo‘q.</p>
              )}
              <div className="flex flex-wrap items-center gap-2 border-t border-hairline pt-3">
                <span className="text-sm text-ink-muted">Necha oyga to‘laysiz?</span>
                <div className="w-32">
                  <ASelect
                    value={months}
                    onChange={setMonths}
                    options={[1, 3, 6, 12].map((m) => ({ value: String(m), label: `${m} oy` }))}
                    aria-label="Necha oyga"
                  />
                </div>
                <AButton size="sm" variant="outline" loading={busy === "invoice"} onClick={() => void post("invoice", { months: Number(months) })}>
                  Hisob-faktura olish
                </AButton>
              </div>
            </Card>
          )}

          {sub && (
            <div className="grid gap-3 md:grid-cols-3">
              {data.plans.map((p) => {
                const current = p.code === sub.plan.code;
                return (
                  <Card key={p.code} className={current ? "border-pine/50" : ""}>
                    <p className="font-display text-lg font-bold">{p.name}</p>
                    <p className="text-xs text-ink-muted">{p.tagline}</p>
                    <p className="font-display mt-3 text-xl font-bold text-pine-deep">
                      {formatUzs(p.monthlyPriceUzs)} <span className="text-sm font-normal text-ink-muted">/ oy</span>
                    </p>
                    <p className="mt-1 text-xs text-ink-muted">
                      {p.maxStaff ? `${p.maxStaff} tagacha xodim` : "Cheksiz xodim"} · {p.maxDoctors ? `${p.maxDoctors} tagacha shifokor` : "cheksiz shifokor"}
                    </p>
                    <ul className="mt-3 flex flex-col gap-1 text-sm">
                      {p.features.map((f) => (
                        <li key={f} className="flex gap-1.5">
                          <Check className="mt-0.5 h-4 w-4 shrink-0 text-pine" /> {f}
                        </li>
                      ))}
                    </ul>
                    <div className="mt-4">
                      {current ? (
                        <ABadge tone="pine">Joriy tarif</ABadge>
                      ) : (
                        <AButton size="sm" variant="outline" loading={busy === p.code} onClick={() => void post(p.code, { planCode: p.code })}>
                          Shu tarifga o‘tish
                        </AButton>
                      )}
                    </div>
                  </Card>
                );
              })}
            </div>
          )}

          <div>
            <p className="mb-2 flex items-center gap-2 text-sm font-bold text-foreground">
              <CreditCard className="h-4 w-4" /> Hisob-fakturalar tarixi
            </p>
            {data.invoices.length === 0 ? (
              <Card>
                <p className="text-sm text-ink-muted">Hali hisob-faktura yo‘q.</p>
              </Card>
            ) : (
              <ATable headers={["Raqam", "Tarif", "Summa", "Holat", "Sana"]}>
                {data.invoices.map((i) => (
                  <tr key={i.id}>
                    <td className="px-4 py-3 font-numeric">
                      <Link href={`/admin/billing/invoice/${i.id}`} target="_blank" className="hover:underline">
                        {i.number}
                      </Link>
                    </td>
                    <td className="px-4 py-3">
                      {i.planName}, {i.months} oy
                    </td>
                    <td className="px-4 py-3 font-numeric">{formatUzs(i.amountUzs)}</td>
                    <td className="px-4 py-3">
                      <ABadge tone={INVOICE_STATUS[i.status].tone}>{INVOICE_STATUS[i.status].label}</ABadge>
                    </td>
                    <td className="px-4 py-3 text-ink-muted">{i.status === "paid" ? date(i.paidAt) : date(i.issuedAt)}</td>
                  </tr>
                ))}
              </ATable>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

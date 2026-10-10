"use client";

import { useCallback, useEffect, useState } from "react";
import { Building2, ReceiptText, Tags, Landmark } from "lucide-react";
import { Card, AButton, ABadge, AInput, ATable, AError, LoadingRow } from "@/components/admin/ui";
import { formatUzs, STATUS_LABEL, type EffectiveStatus, type Plan } from "@/lib/billing/status";

type ClinicRow = {
  id: string;
  name: string;
  slug: string | null;
  city: string | null;
  phone: string | null;
  isActive: boolean;
  createdAt: string;
  staff: number;
  plan: string | null;
  status: EffectiveStatus | null;
  daysLeft: number | null;
  periodEnd: string | null;
  bot: string | null;
  botStatus: string | null;
};
type InvoiceRow = {
  id: string;
  number: string;
  amountUzs: number;
  months: number;
  status: "issued" | "paid" | "void";
  issuedAt: string;
  dueAt: string;
  paidAt: string | null;
  reference: string | null;
  clinicName: string;
  planName: string;
};
type Payee = { legalName: string; tin: string; bankName: string; bankAccount: string; mfo: string; contactPhone: string };
type Overview = { clinics: ClinicRow[]; invoices: InvoiceRow[]; plans: Plan[]; payee: Payee };

const date = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("uz-UZ", { day: "2-digit", month: "2-digit", year: "numeric" }) : "—");

async function call<T>(path: string, method: string, body?: unknown): Promise<T> {
  const res = await fetch(path, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const json = (await res.json().catch(() => null)) as { ok?: boolean; data?: T; error?: string } | null;
  if (!res.ok || !json?.ok) throw new Error(json?.error ?? "So‘rov bajarilmadi");
  return json.data as T;
}

const TABS = [
  { key: "clinics", label: "Klinikalar", icon: Building2 },
  { key: "invoices", label: "To‘lovlar", icon: ReceiptText },
  { key: "plans", label: "Tariflar", icon: Tags },
  { key: "payee", label: "Rekvizitlar", icon: Landmark },
] as const;

/**
 * The Health AI platform console: every clinic with its subscription, bank transfers to confirm, plan prices, and the
 * payee details printed on invoices. Health AI staff only (requirePlatformAdmin on every route).
 */
export function PlatformConsole() {
  const [tab, setTab] = useState<(typeof TABS)[number]["key"]>("clinics");
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [refs, setRefs] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    try {
      setData(await call<Overview>("/api/platform/overview", "GET"));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Yuklab bo‘lmadi");
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const act = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    setError(null);
    try {
      await fn();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Amal bajarilmadi");
    } finally {
      setBusy(null);
    }
  };

  const open = data?.invoices.filter((i) => i.status === "issued") ?? [];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap gap-2">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            className={`inline-flex items-center gap-2 rounded-xl px-3.5 py-2 text-sm font-semibold transition ${
              tab === t.key ? "bg-pine text-white" : "bg-surface text-ink-muted hover:text-foreground"
            }`}
          >
            <t.icon className="h-4 w-4" /> {t.label}
            {t.key === "invoices" && open.length > 0 && <span className="rounded-full bg-clay px-1.5 text-[11px] text-white">{open.length}</span>}
          </button>
        ))}
      </div>
      {error && <AError message={error} />}
      {!data ? (
        <Card>
          <LoadingRow />
        </Card>
      ) : tab === "clinics" ? (
        <ATable headers={["Klinika", "Tarif va holat", "Xodimlar", "Telegram bot", "Kirish"]}>
          {data.clinics.map((c) => (
            <tr key={c.id}>
              <td className="px-4 py-3">
                <p className="font-medium">{c.name}</p>
                <p className="text-xs text-ink-muted">
                  {[c.city, c.phone].filter(Boolean).join(" · ")} · {date(c.createdAt)}
                </p>
              </td>
              <td className="px-4 py-3">
                <p className="text-sm">{c.plan ?? "—"}</p>
                {c.status && (
                  <ABadge tone={c.status === "active" ? "green" : c.status === "trialing" ? "blue" : "red"}>
                    {STATUS_LABEL[c.status]}
                    {c.periodEnd ? ` · ${date(c.periodEnd)}` : ""}
                  </ABadge>
                )}
              </td>
              <td className="px-4 py-3 font-numeric">{c.staff}</td>
              <td className="px-4 py-3 text-sm">{c.bot ? `@${c.bot} (${c.botStatus})` : <span className="text-ink-muted">ulanmagan</span>}</td>
              <td className="px-4 py-3">
                <AButton
                  size="sm"
                  variant={c.isActive ? "outline" : "primary"}
                  loading={busy === c.id}
                  onClick={() => void act(c.id, () => call(`/api/platform/clinics?id=${encodeURIComponent(c.id)}`, "PATCH", { isActive: !c.isActive }))}
                >
                  {c.isActive ? "O‘chirish" : "Yoqish"}
                </AButton>
              </td>
            </tr>
          ))}
        </ATable>
      ) : tab === "invoices" ? (
        <ATable headers={["Hisob-faktura", "Klinika", "Summa", "Holat", "Tasdiqlash"]}>
          {data.invoices.map((i) => (
            <tr key={i.id}>
              <td className="px-4 py-3">
                <p className="font-numeric">{i.number}</p>
                <p className="text-xs text-ink-muted">
                  {date(i.issuedAt)} · muddat {date(i.dueAt)}
                </p>
              </td>
              <td className="px-4 py-3">
                <p>{i.clinicName}</p>
                <p className="text-xs text-ink-muted">
                  {i.planName}, {i.months} oy
                </p>
              </td>
              <td className="px-4 py-3 font-numeric">{formatUzs(i.amountUzs)}</td>
              <td className="px-4 py-3">
                <ABadge tone={i.status === "paid" ? "green" : i.status === "issued" ? "amber" : "neutral"}>
                  {i.status === "paid" ? `To‘langan ${date(i.paidAt)}` : i.status === "issued" ? "Kutilmoqda" : "Bekor"}
                </ABadge>
                {i.reference && <p className="mt-1 text-xs text-ink-muted">№ {i.reference}</p>}
              </td>
              <td className="px-4 py-3">
                {i.status === "issued" ? (
                  <div className="flex gap-1.5">
                    <div className="w-40">
                      <AInput value={refs[i.id] ?? ""} onChange={(v) => setRefs((r) => ({ ...r, [i.id]: v }))} placeholder="To‘lov topshiriqnomasi №" aria-label={`${i.number} to‘lov raqami`} />
                    </div>
                    <AButton size="sm" loading={busy === i.id} onClick={() => void act(i.id, () => call("/api/platform/invoices", "POST", { invoiceId: i.id, reference: refs[i.id] ?? "" }))}>
                      Pul tushdi
                    </AButton>
                  </div>
                ) : (
                  <span className="text-xs text-ink-muted">—</span>
                )}
              </td>
            </tr>
          ))}
        </ATable>
      ) : tab === "plans" ? (
        <div className="grid gap-3 md:grid-cols-2">
          {data.plans.map((p) => (
            <PlanEditor key={p.code} plan={p} busy={busy === p.code} onSave={(body) => void act(p.code, () => call("/api/platform/plans", "PATCH", body))} />
          ))}
        </div>
      ) : (
        <PayeeEditor payee={data.payee} busy={busy === "payee"} onSave={(body) => void act("payee", () => call("/api/platform/billing", "PUT", body))} />
      )}
    </div>
  );
}

function PlanEditor({ plan, busy, onSave }: { plan: Plan; busy: boolean; onSave: (body: unknown) => void }) {
  const [name, setName] = useState(plan.name);
  const [tagline, setTagline] = useState(plan.tagline);
  const [price, setPrice] = useState(String(plan.monthlyPriceUzs));
  const [maxStaff, setMaxStaff] = useState(plan.maxStaff ? String(plan.maxStaff) : "");
  const [maxDoctors, setMaxDoctors] = useState(plan.maxDoctors ? String(plan.maxDoctors) : "");
  const [features, setFeatures] = useState(plan.features.join("\n"));
  const [isPublic, setIsPublic] = useState(plan.isPublic);
  const num = (v: string) => (v.trim() ? Number(v.replace(/\s/g, "")) : null);

  return (
    <Card className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <p className="font-numeric text-xs uppercase tracking-[0.16em] text-ink-muted">{plan.code}</p>
        {plan.priceIsDraft && <ABadge tone="amber">Narx tasdiqlanmagan</ABadge>}
      </div>
      <AInput value={name} onChange={setName} aria-label={`${plan.code} nomi`} placeholder="Nomi" />
      <AInput value={tagline} onChange={setTagline} aria-label={`${plan.code} tavsifi`} placeholder="Qisqa tavsif" />
      <label className="text-xs text-ink-muted">
        Oylik narx (so‘m)
        <AInput value={price} onChange={setPrice} aria-label={`${plan.code} narxi`} />
      </label>
      <div className="grid grid-cols-2 gap-2">
        <label className="text-xs text-ink-muted">
          Xodimlar chegarasi (bo‘sh = cheksiz)
          <AInput value={maxStaff} onChange={setMaxStaff} aria-label={`${plan.code} xodimlar chegarasi`} />
        </label>
        <label className="text-xs text-ink-muted">
          Shifokorlar chegarasi
          <AInput value={maxDoctors} onChange={setMaxDoctors} aria-label={`${plan.code} shifokorlar chegarasi`} />
        </label>
      </div>
      <label className="text-xs text-ink-muted">
        Imkoniyatlar (har qatorda bittadan)
        <textarea
          value={features}
          onChange={(e) => setFeatures(e.target.value)}
          rows={5}
          className="mt-1 w-full rounded-lg border border-hairline bg-surface px-3 py-2 text-sm text-foreground"
          aria-label={`${plan.code} imkoniyatlari`}
        />
      </label>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={isPublic} onChange={(e) => setIsPublic(e.target.checked)} /> Saytda ko‘rsatish
      </label>
      <div>
        <AButton
          size="sm"
          loading={busy}
          onClick={() =>
            onSave({
              code: plan.code,
              name: name.trim(),
              tagline: tagline.trim(),
              monthlyPriceUzs: num(price) ?? 0,
              maxStaff: num(maxStaff),
              maxDoctors: num(maxDoctors),
              features: features.split("\n").map((f) => f.trim()).filter(Boolean),
              isPublic,
            })
          }
        >
          Saqlash
        </AButton>
      </div>
    </Card>
  );
}

function PayeeEditor({ payee, busy, onSave }: { payee: Payee; busy: boolean; onSave: (body: Payee) => void }) {
  const [p, setP] = useState(payee);
  const set = (k: keyof Payee) => (v: string) => setP((prev) => ({ ...prev, [k]: v }));
  return (
    <Card className="flex max-w-xl flex-col gap-2">
      <p className="text-sm text-ink-muted">Har bir hisob-fakturada chiqadigan Health AI yuridik shaxsi va bank hisobi.</p>
      <AInput value={p.legalName} onChange={set("legalName")} placeholder="Yuridik nom (MCHJ)" aria-label="Yuridik nom" />
      <AInput value={p.tin} onChange={set("tin")} placeholder="STIR (9 raqam)" aria-label="STIR" />
      <AInput value={p.bankName} onChange={set("bankName")} placeholder="Bank nomi" aria-label="Bank nomi" />
      <AInput value={p.bankAccount} onChange={set("bankAccount")} placeholder="Hisob raqam (20 raqam)" aria-label="Hisob raqam" />
      <AInput value={p.mfo} onChange={set("mfo")} placeholder="MFO (5 raqam)" aria-label="MFO" />
      <AInput value={p.contactPhone} onChange={set("contactPhone")} placeholder="Aloqa telefoni" aria-label="Aloqa telefoni" />
      <div>
        <AButton size="sm" loading={busy} onClick={() => onSave(p)}>
          Saqlash
        </AButton>
      </div>
    </Card>
  );
}

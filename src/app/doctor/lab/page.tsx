"use client";

import Link from "next/link";
import { FlaskConical } from "lucide-react";
import { PageHeader, Card, ABadge, AEmpty, AButton, StatCard } from "@/components/admin/ui";
import { DashboardState, SectionTitle, useDashboard } from "@/components/lab/dashboard-ui";
import { LAB_ITEM_STATUS } from "@/components/doctor/lab-orders";
import { LAB_FLAG_LABELS } from "@/lib/labs/flag-labels";
import { formatDay } from "@/lib/labs/format-day";

type Dashboard = {
  windowDays: number;
  myOrders: Array<{ orderId: string; createdAt: string; status: string; patientId: string; patientName: string | null; tests: Array<{ name: string; status: string }> }>;
  pending: Array<{ itemId: string; testName: string; status: string; orderedAt: string; patientId: string; patientName: string | null }>;
  pendingCount: number;
  recentResults: Array<{
    resultId: string;
    patientId: string;
    patientName: string | null;
    testName: string;
    verifiedAt: string;
    corrected: boolean;
    outOfRange: number;
    critical: boolean;
    previousVerifiedAt: string | null;
  }>;
  abnormal: Array<{ resultId: string; patientId: string; patientName: string | null; testName: string; verifiedAt: string; parameter: string; value: string; unit: string | null; range: string | null; flag: string }>;
};

const ORDER_STATUS: Record<string, { label: string; tone: "blue" | "green" | "gray" }> = {
  active: { label: "Faol", tone: "blue" },
  completed: { label: "Yakunlangan", tone: "green" },
  cancelled: { label: "Bekor qilingan", tone: "gray" },
};

const patientHref = (id: string) => `/doctor/patients/${id}`;
const name = (n: string | null) => n?.trim() || "Ismi ko‘rsatilmagan";
const daysBetween = (a: string, b: string) => Math.max(0, Math.round((Date.parse(a) - Date.parse(b)) / 86_400_000));

/**
 * The doctor's laboratory dashboard: their orders, pending tests, recent
 * verified results of their patients, values outside the configured range and
 * repeated tests. Only patients the doctor may see (own or active referral).
 */
export default function DoctorLabPage() {
  const { load, reload } = useDashboard<Dashboard>("/api/doctor/lab/dashboard");
  return (
    <div>
      <PageHeader
        title="Laboratoriya"
        subtitle="Buyurtmalaringiz va bemorlaringizning natijalari"
        action={<AButton variant="secondary" onClick={reload}>Yangilash</AButton>}
      />
      <DashboardState load={load}>{(d) => <DoctorLab d={d} />}</DashboardState>
    </div>
  );
}

function DoctorLab({ d }: { d: Dashboard }) {
  const comparable = d.recentResults.filter((r) => r.previousVerifiedAt);
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label={`Buyurtmalarim (${d.windowDays} kun)`} value={d.myOrders.length} tone="info" />
        <StatCard label="Natija kutilmoqda" value={d.pendingCount} />
        <StatCard label="Yangi natijalar" value={d.recentResults.length} tone="pine" />
        <StatCard label="Me’yordan tashqari" value={d.abnormal.length} tone={d.abnormal.length ? "clay" : "neutral"} />
      </div>

      <Card>
        <SectionTitle hint="Sozlangan me’yor oralig‘idan tashqaridagi qiymatlar, kritiklari birinchi. Bu faqat joylashuv — xulosa emas.">
          Me’yordan tashqari qiymatlar
        </SectionTitle>
        {d.abnormal.length === 0 ? (
          <AEmpty title="Me’yordan tashqari qiymat yo‘q" subtitle={`Oxirgi ${d.windowDays} kundagi tasdiqlangan natijalarda.`} />
        ) : (
          <ul className="divide-y divide-hairline/70" aria-label="Me’yordan tashqari qiymatlar">
            {d.abnormal.map((a, i) => {
              const flag = LAB_FLAG_LABELS[a.flag] ?? { label: a.flag, tone: "gray" as const };
              return (
                <li key={`${a.resultId}-${i}`} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
                  <div className="min-w-0">
                    <Link href={patientHref(a.patientId)} className="text-sm font-semibold text-foreground hover:underline">{name(a.patientName)}</Link>
                    <p className="text-xs text-ink-muted">
                      {a.testName} · {a.parameter}: <span className="font-numeric font-medium text-foreground">{a.value}</span>
                      {a.unit ? ` ${a.unit}` : ""}
                      {a.range ? ` (me’yor: ${a.range})` : ""} · {formatDay(a.verifiedAt)}
                    </p>
                  </div>
                  <ABadge tone={flag.tone}>{flag.label}</ABadge>
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <SectionTitle hint={`Oxirgi ${d.windowDays} kunda tasdiqlangan, bemorlaringiz bo‘yicha`}>So‘nggi natijalar</SectionTitle>
          {d.recentResults.length === 0 ? (
            <AEmpty icon={<FlaskConical className="h-7 w-7" />} title="Yangi natija yo‘q" />
          ) : (
            <ul className="divide-y divide-hairline/70" aria-label="So‘nggi natijalar">
              {d.recentResults.map((r) => (
                <li key={r.resultId} className="py-2.5">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <Link href={patientHref(r.patientId)} className="text-sm font-semibold text-foreground hover:underline">{name(r.patientName)}</Link>
                    <div className="flex gap-1.5">
                      {r.critical && <ABadge tone="red">Kritik qiymat</ABadge>}
                      {!r.critical && r.outOfRange > 0 && <ABadge tone="amber">{r.outOfRange} ta me’yordan tashqari</ABadge>}
                      {r.outOfRange === 0 && <ABadge tone="green">Me’yor oralig‘ida</ABadge>}
                      {r.corrected && <ABadge tone="purple">Tuzatilgan</ABadge>}
                    </div>
                  </div>
                  <p className="text-xs text-ink-muted">{r.testName} · {formatDay(r.verifiedAt)}</p>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card>
          <SectionTitle hint="Xuddi shu tahlil shu bemorda avval ham qilingan — dinamikasi bemor sahifasida">Taqqoslanadigan tahlillar</SectionTitle>
          {comparable.length === 0 ? (
            <AEmpty title="Takroriy tahlil yo‘q" />
          ) : (
            <ul className="divide-y divide-hairline/70" aria-label="Taqqoslanadigan tahlillar">
              {comparable.map((r) => (
                <li key={r.resultId} className="py-2.5">
                  <Link href={patientHref(r.patientId)} className="text-sm font-semibold text-foreground hover:underline">{name(r.patientName)}</Link>
                  <p className="text-xs text-ink-muted">
                    {r.testName}: {formatDay(r.verifiedAt)}, avvalgisi {formatDay(r.previousVerifiedAt!)} ({daysBetween(r.verifiedAt, r.previousVerifiedAt!)} kun oldin)
                  </p>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <SectionTitle hint="Siz buyurtma qilgan, hali tasdiqlanmagan tahlillar">Natija kutilmoqda</SectionTitle>
          {d.pending.length === 0 ? (
            <AEmpty title="Kutilayotgan tahlil yo‘q" />
          ) : (
            <ul className="divide-y divide-hairline/70" aria-label="Natija kutilmoqda">
              {d.pending.map((p) => {
                const s = LAB_ITEM_STATUS[p.status] ?? { label: p.status, tone: "neutral" as const };
                return (
                  <li key={p.itemId} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
                    <div className="min-w-0">
                      <Link href={patientHref(p.patientId)} className="text-sm font-semibold text-foreground hover:underline">{name(p.patientName)}</Link>
                      <p className="text-xs text-ink-muted">{p.testName} · {formatDay(p.orderedAt)}</p>
                    </div>
                    <ABadge tone={s.tone}>{s.label}</ABadge>
                  </li>
                );
              })}
            </ul>
          )}
          {d.pendingCount > d.pending.length && <p className="mt-2 text-xs text-ink-muted">Yana {d.pendingCount - d.pending.length} ta.</p>}
        </Card>

        <Card>
          <SectionTitle hint={`Oxirgi ${d.windowDays} kun`}>Buyurtmalarim</SectionTitle>
          {d.myOrders.length === 0 ? (
            <AEmpty title="Buyurtma yo‘q" subtitle="Tahlilni bemor sahifasidan buyurtma qilishingiz mumkin." />
          ) : (
            <ul className="divide-y divide-hairline/70" aria-label="Buyurtmalarim">
              {d.myOrders.map((o) => {
                const s = ORDER_STATUS[o.status] ?? { label: o.status, tone: "gray" as const };
                return (
                  <li key={o.orderId} className="py-2.5">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <Link href={patientHref(o.patientId)} className="text-sm font-semibold text-foreground hover:underline">{name(o.patientName)}</Link>
                      <ABadge tone={s.tone}>{s.label}</ABadge>
                    </div>
                    <p className="text-xs text-ink-muted">
                      {formatDay(o.createdAt)} · {o.tests.map((t) => `${t.name} (${(LAB_ITEM_STATUS[t.status]?.label ?? t.status).toLowerCase()})`).join(", ")}
                    </p>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}

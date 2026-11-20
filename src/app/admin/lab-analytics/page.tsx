"use client";

import { useMemo, useState } from "react";
import { Lock } from "lucide-react";
import { PageHeader, Card, AEmpty, AInput, ASelect, StatCard, ATable, AError } from "@/components/admin/ui";
import { formatPrice } from "@/lib/admin/client";
import { Bars, DashboardState, SectionTitle, formatHours, useDashboard } from "@/components/lab/dashboard-ui";
import { WorkloadPanel, type WorkloadData } from "@/components/lab/workload-panel";
import { LAB_ITEM_STATUS } from "@/components/doctor/lab-orders";

type Duration = { count: number; medianHours: number | null; p90Hours: number | null };
type LabAnalytics = {
  range: number;
  truncated: boolean;
  can_view_payment_dynamics: boolean;
  orders: number;
  tests: number;
  bySource: Array<[string, number]>;
  byItemStatus: Array<[string, number]>;
  byTest: Array<{ name: string; count: number }>;
  byCategory: Array<{ name: string; count: number }>;
  volumeTrend: Array<{ date: string; tests: number }>;
  cancelledOrders: number;
  cancelledTests: number;
  cancellationRate: number;
  cancelReasons: Array<{ reason: string; count: number }>;
  turnaround: { orderToVerified: Duration; collectedToVerified: Duration; onTime: number; late: number; byTest: Array<{ name: string } & Duration> };
  repeats: { repeatedTests: number; rate: number; windowDays: number; byTest: Array<{ name: string; count: number }> };
  workload: WorkloadData;
  finance: null | {
    paidTotal: number;
    recognized: number;
    prepaidInProgress: number;
    toRefund: number;
    refunded: number;
    unpaid: number;
    pending: number;
    paidOrders: number;
    averagePaidOrder: number;
    revenueByTest: Array<{ name: string; revenue: number; count: number }>;
    revenueByCategory: Array<{ name: string; revenue: number }>;
    revenueTrend: Array<{ date: string; revenue: number }>;
    revenueByWeek: Array<{ key: string; revenue: number }>;
    revenueByMonth: Array<{ key: string; revenue: number }>;
  };
};

const RANGES = [
  { value: "7", label: "Oxirgi 7 kun" },
  { value: "30", label: "Oxirgi 30 kun" },
  { value: "90", label: "Oxirgi 90 kun" },
  { value: "custom", label: "Boshqa davr…" },
];
const SOURCE_LABELS: Record<string, string> = { consultation: "Shifokor qabulida", walk_in: "Kassada / to‘g‘ridan-to‘g‘ri" };

/**
 * Laboratory management analytics: test volume, workload, turnaround,
 * cancellations, repeat-test patterns and — for the payment roles only —
 * laboratory revenue from the payment records.
 */
export default function LabAnalyticsPage() {
  const [range, setRange] = useState("30");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const isCustom = range === "custom";
  const customInvalid = isCustom && Boolean(fromDate) && Boolean(toDate) && fromDate > toDate;
  const customReady = isCustom && Boolean(fromDate) && Boolean(toDate) && !customInvalid;

  // An incomplete custom range waits — it never falls back to another period.
  const url = isCustom
    ? customReady
      ? `/api/admin/analytics/lab?${new URLSearchParams({ from: fromDate, to: toDate })}`
      : null
    : `/api/admin/analytics/lab?${new URLSearchParams({ range })}`;
  const { load } = useDashboard<LabAnalytics>(url, 0);

  return (
    <div>
      <PageHeader
        title="Laboratoriya tahlili"
        subtitle="Tahlillar soni, ish yuki, bajarilish muddati va bekor qilishlar"
        action={
          <div className="flex flex-wrap items-end gap-2">
            <ASelect aria-label="Davr" value={range} onChange={setRange} options={RANGES} />
            {isCustom && (
              <>
                <AInput aria-label="Boshlanish sanasi" type="date" value={fromDate} onChange={setFromDate} />
                <AInput aria-label="Tugash sanasi" type="date" value={toDate} onChange={setToDate} />
              </>
            )}
          </div>
        }
      />
      {customInvalid && <AError message="Boshlanish sanasi tugash sanasidan keyin bo‘lishi mumkin emas" />}
      {isCustom && !customReady ? (
        <Card>
          <AEmpty title="Davrni tanlang" subtitle="Boshlanish va tugash sanalarini kiriting." />
        </Card>
      ) : (
        <DashboardState load={load}>{(d) => <Analytics d={d} />}</DashboardState>
      )}
    </div>
  );
}

function Analytics({ d }: { d: LabAnalytics }) {
  return (
    <div className="space-y-6">
      {d.truncated && <AError message="Davrda buyurtmalar juda ko‘p: ko‘rsatkichlar birinchi 20 000 ta buyurtma bo‘yicha. Qisqaroq davr tanlang." />}

      <section>
        <SectionTitle>Hozirgi ish</SectionTitle>
        <WorkloadPanel workload={d.workload} />
      </section>

      <section className="space-y-4">
        <SectionTitle hint="Tanlangan davrda buyurtma qilingan (eski tizimdan import qilinganlar hisobga olinmaydi)">Tahlillar soni</SectionTitle>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatCard label="Buyurtmalar" value={d.orders} tone="info" />
          <StatCard label="Tahlillar" value={d.tests} />
          <StatCard label="Bekor qilingan tahlillar" value={d.cancelledTests} tone={d.cancelledTests ? "clay" : "neutral"} />
          <StatCard label="Bekor qilish ulushi" value={`${d.cancellationRate}%`} />
        </div>
        {d.tests === 0 ? (
          <Card>
            <AEmpty title="Bu davrda tahlil buyurtma qilinmagan" />
          </Card>
        ) : (
          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <SectionTitle>Eng ko‘p buyurtma qilingan tahlillar</SectionTitle>
              <Bars rows={d.byTest.map((t) => ({ label: t.name, value: t.count }))} />
            </Card>
            <Card>
              <SectionTitle>Bo‘limlar bo‘yicha</SectionTitle>
              <Bars rows={d.byCategory.map((c) => ({ label: c.name, value: c.count }))} />
            </Card>
            <Card>
              <SectionTitle>Kunlar bo‘yicha</SectionTitle>
              <Bars rows={d.volumeTrend.map((t) => ({ label: t.date, value: t.tests }))} />
            </Card>
            <Card>
              <SectionTitle>Holat va manba</SectionTitle>
              <Bars rows={d.byItemStatus.map(([s, n]) => ({ label: LAB_ITEM_STATUS[s]?.label ?? s, value: n }))} />
              <div className="mt-5">
                <Bars rows={d.bySource.map(([s, n]) => ({ label: SOURCE_LABELS[s] ?? s, value: n }))} />
              </div>
            </Card>
          </div>
        )}
      </section>

      <section className="space-y-4">
        <SectionTitle hint="Tasdiqlangan tahlillar bo‘yicha: mediana va 90-persentil">Bajarilish muddati</SectionTitle>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatCard label="Buyurtmadan tasdiqgacha (mediana)" value={formatHours(d.turnaround.orderToVerified.medianHours)} tone="info" />
          <StatCard label="Namunadan tasdiqgacha (mediana)" value={formatHours(d.turnaround.collectedToVerified.medianHours)} />
          <StatCard label="Namunadan tasdiqgacha (90%)" value={formatHours(d.turnaround.collectedToVerified.p90Hours)} />
          <StatCard label="Belgilangan muddatda / kech" value={`${d.turnaround.onTime} / ${d.turnaround.late}`} tone={d.turnaround.late ? "clay" : "pine"} />
        </div>
        {d.turnaround.byTest.length > 0 && (
          <ATable headers={["Tahlil", "Soni", "Mediana", "90%"]}>
            {d.turnaround.byTest.map((t) => (
              <tr key={t.name}>
                <td className="px-4 py-2.5">{t.name}</td>
                <td className="font-numeric px-4 py-2.5">{t.count}</td>
                <td className="font-numeric px-4 py-2.5">{formatHours(t.medianHours)}</td>
                <td className="font-numeric px-4 py-2.5">{formatHours(t.p90Hours)}</td>
              </tr>
            ))}
          </ATable>
        )}
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <SectionTitle hint={`Bekor qilingan buyurtmalar: ${d.cancelledOrders}`}>Bekor qilish sabablari</SectionTitle>
          {d.cancelReasons.length === 0 ? (
            <AEmpty title="Bekor qilingan buyurtma yo‘q" />
          ) : (
            <Bars rows={d.cancelReasons.map((r) => ({ label: r.reason, value: r.count }))} />
          )}
        </Card>
        <Card>
          <SectionTitle hint={`Bir bemorda bir xil tahlil ${d.repeats.windowDays} kun ichida qayta buyurtma qilingan`}>
            Takroriy tahlillar: {d.repeats.repeatedTests} ({d.repeats.rate}%)
          </SectionTitle>
          {d.repeats.byTest.length === 0 ? (
            <AEmpty title="Takroriy tahlil yo‘q" />
          ) : (
            <Bars rows={d.repeats.byTest.map((r) => ({ label: r.name, value: r.count }))} />
          )}
        </Card>
      </div>

      <FinanceSection finance={d.finance} />
    </div>
  );
}

function FinanceSection({ finance }: { finance: LabAnalytics["finance"] }) {
  const [bucket, setBucket] = useState<"day" | "week" | "month">("day");
  const trend = useMemo(() => {
    if (!finance) return [];
    if (bucket === "week") return finance.revenueByWeek.map((r) => ({ label: r.key, value: r.revenue }));
    if (bucket === "month") return finance.revenueByMonth.map((r) => ({ label: r.key, value: r.revenue }));
    return finance.revenueTrend.map((r) => ({ label: r.date, value: r.revenue }));
  }, [finance, bucket]);

  if (!finance) {
    return (
      <Card>
        <AEmpty
          icon={<Lock className="h-7 w-7" />}
          title="Moliyaviy ko‘rsatkichlar yopiq"
          subtitle="Laboratoriya daromadi faqat klinika egasi va administratorga ko‘rinadi."
        />
      </Card>
    );
  }
  return (
    <section className="space-y-4" aria-label="Laboratoriya daromadi">
      <SectionTitle hint="To‘lov yozuvlaridan: to‘langan va bajarilgan (tasdiqlangan) tahlillar. Katalog narxlari ishlatilmaydi.">
        Laboratoriya daromadi
      </SectionTitle>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Daromad (bajarilgan)" value={formatPrice(finance.recognized)} tone="pine" />
        <StatCard label="To‘langan, bajarilmoqda" value={formatPrice(finance.prepaidInProgress)} tone="info" />
        <StatCard label="Qaytarilishi kerak" value={formatPrice(finance.toRefund)} tone={finance.toRefund ? "clay" : "neutral"} />
        <StatCard label="O‘rtacha to‘lov" value={formatPrice(finance.averagePaidOrder)} />
        <StatCard label="To‘lanmagan" value={formatPrice(finance.unpaid)} />
        <StatCard label="Kutilmoqda" value={formatPrice(finance.pending)} />
        <StatCard label="Qaytarilgan" value={formatPrice(finance.refunded)} />
        <StatCard label="Jami to‘langan" value={formatPrice(finance.paidTotal)} />
      </div>
      {finance.recognized === 0 ? (
        <Card>
          <AEmpty title="Bu davrda tan olingan daromad yo‘q" subtitle="Daromad to‘lov qabul qilingan va natijasi tasdiqlangan tahlillardan hisoblanadi." />
        </Card>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <SectionTitle>Tahlillar bo‘yicha daromad</SectionTitle>
            <Bars rows={finance.revenueByTest.map((r) => ({ label: `${r.name} (${r.count})`, value: r.revenue }))} format={formatPrice} />
          </Card>
          <Card>
            <SectionTitle>Bo‘limlar bo‘yicha daromad</SectionTitle>
            <Bars rows={finance.revenueByCategory.map((r) => ({ label: r.name, value: r.revenue }))} format={formatPrice} />
          </Card>
          <Card className="lg:col-span-2">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <SectionTitle>Daromad dinamikasi</SectionTitle>
              <div className="flex gap-1" role="group" aria-label="Davr bo‘limi">
                {(["day", "week", "month"] as const).map((b) => (
                  <button
                    key={b}
                    type="button"
                    onClick={() => setBucket(b)}
                    aria-pressed={bucket === b}
                    className={`rounded-lg px-3 py-1 text-xs font-semibold ${bucket === b ? "bg-pine text-white" : "bg-sand text-ink-muted"}`}
                  >
                    {b === "day" ? "Kun" : b === "week" ? "Hafta" : "Oy"}
                  </button>
                ))}
              </div>
            </div>
            <Bars rows={trend} format={formatPrice} />
          </Card>
        </div>
      )}
    </section>
  );
}

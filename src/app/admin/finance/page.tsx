"use client";

import { useEffect, useState } from "react";
import { PageHeader, Card, StatCard, AEmpty, AError, ASelect, ATable, ABadge, LoadingRow } from "@/components/admin/ui";
import { TrendingDown, Receipt, Landmark, ShieldAlert } from "lucide-react";
import {
  adminApi,
  AdminApiError,
  formatPrice,
  formatDateTime,
  PAYMENT_STATUS_LABELS,
  PAYMENT_STATUS_TONES,
  PROVIDER_LABELS,
  PROVIDER_TONES,
} from "@/lib/admin/client";
import { RevenueTrendChart, trendRowsFor, type TrendBucket } from "@/components/admin/revenue-trend-chart";

type LedgerEntry = {
  id: string;
  date: string;
  patientName: string;
  serviceName: string;
  doctorName: string;
  amount: number;
  status: string;
  provider: string;
};

type FinanceAnalytics = {
  can_view_payment_dynamics: boolean;
  total_revenue: number | null;
  by_payment_status: [string, number][];
  revenue_trend: { date: string; revenue: number }[];
  revenue_by_week: { key: string; revenue: number }[];
  revenue_by_month: { key: string; revenue: number }[];
  unpaid_total: number | null;
  pending_total: number | null;
  refunded_total: number | null;
  average_ticket: number | null;
  recent_payments: LedgerEntry[];
};

const RANGES = [
  { value: "7", label: "Oxirgi 7 kun" },
  { value: "30", label: "Oxirgi 30 kun" },
  { value: "90", label: "Oxirgi 90 kun" },
];

/**
 * Owner/admin-only cash-flow view. Reuses the exact same analytics endpoint
 * and aggregation as /admin/analytics — this page changes only what's shown
 * and how: a finance-first read (cash in, money owed, money paid back, a
 * per-transaction ledger) rather than an appointment-operations read.
 *
 * No new tables, no new writes — every figure here already existed in
 * aggregateAppointments(); this page only surfaces it differently. The
 * server, not this component, is the actual authorization boundary:
 * can_view_payment_dynamics comes back false (with every money field
 * nulled) for any role the API itself doesn't trust with payment data,
 * regardless of whether the nav link happens to be visible.
 */
export default function FinancePage() {
  const [range, setRange] = useState("30");
  const [trendBucket, setTrendBucket] = useState<TrendBucket>("week");
  const [data, setData] = useState<FinanceAnalytics | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    adminApi
      .get<FinanceAnalytics>(`/api/admin/analytics?range=${range}`)
      .then((d) => setData(d))
      .catch((e) => setError(e instanceof AdminApiError ? e.message : "Moliyaviy ma'lumotlarni yuklab bo‘lmadi"));
  }, [range]);

  const maxPaymentStatus = data?.by_payment_status[0]?.[1] ?? 1;

  return (
    <div>
      <PageHeader
        title="Moliya"
        subtitle="Pul oqimi, kutilayotgan to‘lovlar va so‘nggi operatsiyalar"
        action={
          <div className="w-44">
            <ASelect value={range} onChange={setRange} options={RANGES} aria-label="Davr" />
          </div>
        }
      />
      {error && <AError message={error} />}

      {data !== null && !data.can_view_payment_dynamics ? (
        <Card>
          <AEmpty
            title="Ruxsat yo‘q"
            subtitle="Moliyaviy ma'lumotlarni faqat klinika egasi yoki administrator ko‘ra oladi"
            icon={<ShieldAlert className="h-5 w-5" />}
          />
        </Card>
      ) : (
        <>
          <div className="mb-6 grid grid-cols-1 gap-3 sm:grid-cols-4">
            <StatCard
              label="Jami tushum"
              value={data === null ? "—" : formatPrice(data.total_revenue)}
              tone="pine"
            />
            <StatCard
              label="To‘lanmagan"
              value={data === null ? "—" : formatPrice(data.unpaid_total)}
              tone="clay"
            />
            <StatCard
              label="Qaytarilgan"
              value={data === null ? "—" : formatPrice(data.refunded_total)}
              tone="clay"
            />
            <StatCard
              label="O‘rtacha chek"
              value={data === null ? "—" : formatPrice(data.average_ticket)}
              tone="info"
            />
          </div>

          <div className="mb-6 grid grid-cols-1 gap-4 lg:grid-cols-2">
            <RevenueTrendChart
              title="Naqd pul oqimi"
              loading={data === null}
              rows={trendRowsFor(trendBucket, data)}
              bucket={trendBucket}
              onBucketChange={setTrendBucket}
            />

            <Card>
              <div className="mb-4 flex items-center gap-2">
                <Landmark className="h-4 w-4 text-ink-muted" />
                <p className="text-sm font-bold text-foreground">To‘lov holatlari</p>
              </div>
              {data === null ? (
                <LoadingRow />
              ) : data.by_payment_status.length === 0 ? (
                <AEmpty title="Ma'lumot yo‘q" subtitle="Bu davrda to‘lovlar yo‘q" icon={<Landmark className="h-5 w-5" />} />
              ) : (
                <div className="space-y-3.5">
                  {data.by_payment_status.map(([status, count]) => (
                    <div key={status}>
                      <div className="mb-1.5 flex items-center justify-between text-sm">
                        <ABadge tone={PAYMENT_STATUS_TONES[status] ?? "neutral"}>
                          {PAYMENT_STATUS_LABELS[status] ?? status}
                        </ABadge>
                        <span className="font-numeric font-medium text-foreground">{count.toLocaleString("uz-UZ")}</span>
                      </div>
                      <div className="h-1.5 overflow-hidden rounded-full bg-sand">
                        <div
                          className="h-full rounded-full bg-gradient-to-r from-pine to-mint transition-[width] duration-500"
                          style={{ width: `${Math.max((count / maxPaymentStatus) * 100, 4)}%` }}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </Card>
          </div>

          <Card>
            <div className="mb-4 flex items-center gap-2">
              <Receipt className="h-4 w-4 text-ink-muted" />
              <p className="text-sm font-bold text-foreground">So‘nggi operatsiyalar</p>
            </div>
            {data === null ? (
              <LoadingRow />
            ) : data.recent_payments.length === 0 ? (
              <AEmpty
                title="Operatsiyalar yo‘q"
                subtitle="Tanlangan davrda to‘lov yozuvlari topilmadi"
                icon={<TrendingDown className="h-5 w-5" />}
              />
            ) : (
              <ATable headers={["Sana", "Bemor", "Xizmat", "Shifokor", "Summasi", "To‘lov turi", "Holati"]}>
                {data.recent_payments.map((p) => (
                  <tr key={p.id}>
                    <td className="px-4 py-3 font-numeric text-sm text-ink-muted">{formatDateTime(p.date)}</td>
                    <td className="px-4 py-3 text-sm text-foreground">{p.patientName}</td>
                    <td className="px-4 py-3 text-sm text-ink-muted">{p.serviceName}</td>
                    <td className="px-4 py-3 text-sm text-ink-muted">{p.doctorName}</td>
                    <td className="px-4 py-3 font-numeric text-sm font-medium text-foreground">{formatPrice(p.amount)}</td>
                    <td className="px-4 py-3">
                      <ABadge tone={PROVIDER_TONES[p.provider] ?? "neutral"}>{PROVIDER_LABELS[p.provider] ?? p.provider}</ABadge>
                    </td>
                    <td className="px-4 py-3">
                      <ABadge tone={PAYMENT_STATUS_TONES[p.status] ?? "neutral"}>
                        {PAYMENT_STATUS_LABELS[p.status] ?? p.status}
                      </ABadge>
                    </td>
                  </tr>
                ))}
              </ATable>
            )}
          </Card>
        </>
      )}
    </div>
  );
}

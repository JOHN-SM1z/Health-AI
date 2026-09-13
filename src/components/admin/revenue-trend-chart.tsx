import { TrendingUp } from "lucide-react";
import { Card, ASelect, AEmpty, LoadingRow } from "@/components/admin/ui";
import { formatPrice } from "@/lib/admin/client";

export type TrendBucket = "day" | "week" | "month";
export type TrendRow = { key: string; revenue: number };

export const TREND_BUCKETS: Array<{ value: TrendBucket; label: string }> = [
  { value: "week", label: "Hafta" },
  { value: "day", label: "Kun" },
  { value: "month", label: "Oy" },
];

/**
 * Shared revenue-over-time bar chart (day/week/month bucketing), used by
 * both the Moliya page and the Owner dashboard's revenue section — same
 * data shape (revenue_trend/revenue_by_week/revenue_by_month from
 * /api/admin/analytics), same rendering, so the two never drift apart.
 */
export function RevenueTrendChart({
  title = "Tushum",
  loading,
  rows,
  bucket,
  onBucketChange,
}: {
  title?: string;
  loading: boolean;
  rows: TrendRow[];
  bucket: TrendBucket;
  onBucketChange: (bucket: TrendBucket) => void;
}) {
  const periodTotal = rows.reduce((sum, r) => sum + r.revenue, 0);
  const maxTrend = rows[0]?.revenue ?? 1;

  return (
    <Card>
      <div className="mb-4 flex items-center gap-2">
        <TrendingUp className="h-4 w-4 text-ink-muted" />
        <p className="text-sm font-bold text-foreground">{title}</p>
        <span className="ml-auto font-numeric text-xs text-ink-muted">
          {loading ? "" : `Jami: ${formatPrice(periodTotal)}`}
        </span>
        <div className="w-32">
          <ASelect
            value={bucket}
            onChange={(v) => onBucketChange(v as TrendBucket)}
            options={TREND_BUCKETS}
            aria-label="Guruhlash"
          />
        </div>
      </div>
      {loading ? (
        <LoadingRow />
      ) : rows.length === 0 ? (
        <AEmpty title="Ma’lumot yo‘q" subtitle="Bu davrda to‘langan qabullar yo‘q" icon={<TrendingUp className="h-5 w-5" />} />
      ) : (
        <div className="flex h-40 items-end gap-1.5">
          {rows.map((d) => (
            <div key={d.key} className="group flex flex-1 flex-col items-center gap-1">
              <span className="font-numeric text-[10px] text-ink-muted opacity-0 transition-opacity group-hover:opacity-100">
                {d.revenue.toLocaleString("uz-UZ")}
              </span>
              <div
                className="w-full rounded-t-md bg-gradient-to-t from-pine to-mint transition-[height] duration-500"
                style={{ height: `${Math.max((d.revenue / maxTrend) * 100, 6)}%` }}
                title={`${d.key}: ${d.revenue.toLocaleString("uz-UZ")} so‘m`}
              />
              <span className="font-numeric text-[10px] text-ink-muted">{d.key.slice(-5)}</span>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

/** Picks the right pre-bucketed array out of an analytics response for the given bucket. */
export function trendRowsFor(
  bucket: TrendBucket,
  data: { revenue_trend: Array<{ date: string; revenue: number }>; revenue_by_week: Array<{ key: string; revenue: number }>; revenue_by_month: Array<{ key: string; revenue: number }> } | null,
): TrendRow[] {
  if (!data) return [];
  const src = bucket === "week" ? data.revenue_by_week : bucket === "month" ? data.revenue_by_month : data.revenue_trend;
  return (src ?? []).map((d) => ({ key: "date" in d ? d.date : d.key, revenue: d.revenue }));
}

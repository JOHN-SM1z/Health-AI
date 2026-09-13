"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Wallet, Receipt, Landmark, Stethoscope, ShieldAlert, ClipboardList, Send } from "lucide-react";
import { PageHeader, Card, StatCard, ASelect, ATable, ABadge, AEmpty, AError, LoadingRow } from "@/components/admin/ui";
import { RevenueTrendChart, trendRowsFor, type TrendBucket } from "@/components/admin/revenue-trend-chart";
import { adminApi, AdminApiError, formatPrice, formatDateTime, PAYMENT_STATUS_LABELS, PAYMENT_STATUS_TONES, PROVIDER_LABELS, PROVIDER_TONES } from "@/lib/admin/client";
import { RANGE_PRESETS, resolveDateRange, percentChange, daySpan, type RangePreset } from "@/lib/admin/date-range";
import type { DashboardSnapshot } from "@/lib/admin/dashboard-types";
import { createClient } from "@/lib/supabase/browser";
import { localDayWindowForDate } from "@/lib/time/local";

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

type AnalyticsSnapshot = {
  total: number;
  cancelled: number;
  no_shows: number;
  cancellation_rate: number;
  by_source: [string, number][];
  by_status: [string, number][];
  total_revenue: number | null;
  revenue_trend: { date: string; revenue: number }[];
  revenue_by_week: { key: string; revenue: number }[];
  revenue_by_month: { key: string; revenue: number }[];
  revenue_by_provider: { provider: string; revenue: number }[];
  by_payment_status: [string, number][];
  unpaid_total: number | null;
  average_ticket: number | null;
  recent_payments: LedgerEntry[];
  top_doctors: Array<{ name: string; count: number; completed_count: number; completion_rate: number; revenue: number | null }>;
};

// Booking source enum values grouped into the three buckets the owner
// actually cares about (see appointment_source in database.types.ts — these
// five are the only real values; nothing here is invented).
const SOURCE_GROUPS: Array<{ label: string; sources: string[] }> = [
  { label: "Telegram", sources: ["telegram_mini_app", "telegram_chat"] },
  { label: "Veb-sayt", sources: ["web"] },
  { label: "Qabulxona", sources: ["admin", "walk_in"] },
];

// Heuristic thresholds for surfacing an alert — deliberately conservative
// (small samples produce noisy rates) and named here so they're easy to
// tune without hunting through JSX.
const HIGH_CANCELLATION_RATE = 20;
const HIGH_CANCELLATION_MIN_SAMPLE = 5;
const UNCONFIRMED_BACKLOG_THRESHOLD = 5;

async function fetchNewPatientCount(tz: string, from: string, to: string): Promise<number> {
  const supabase = createClient();
  const start = localDayWindowForDate(tz, from).start;
  const end = localDayWindowForDate(tz, to).end;
  const { count } = await supabase.from("patients").select("id", { count: "exact", head: true }).gte("created_at", start).lt("created_at", end);
  return count ?? 0;
}

export function OwnerDashboard({ clinicTimezone }: { clinicTimezone: string }) {
  const [preset, setPreset] = useState<RangePreset>("today");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [trendBucket, setTrendBucket] = useState<TrendBucket>("week");

  const [current, setCurrent] = useState<AnalyticsSnapshot | null>(null);
  const [newPatients, setNewPatients] = useState<{ current: number; previous: number } | null>(null);
  const [previousRevenue, setPreviousRevenue] = useState<Pick<AnalyticsSnapshot, "total_revenue" | "unpaid_total" | "average_ticket" | "total" | "cancelled" | "no_shows"> | null>(null);
  const [today, setToday] = useState<DashboardSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);

  const range = useMemo(() => {
    if (preset === "custom" && (!customFrom || !customTo || customFrom > customTo)) return null;
    try {
      return resolveDateRange(preset, clinicTimezone, preset === "custom" ? { from: customFrom, to: customTo } : undefined);
    } catch {
      return null;
    }
  }, [preset, customFrom, customTo, clinicTimezone]);

  useEffect(() => {
    adminApi
      .get<DashboardSnapshot>("/api/admin/dashboard")
      .then(setToday)
      .catch(() => setToday(null));
  }, []);

  useEffect(() => {
    if (!range) return;
    setError(null);
    Promise.all([
      adminApi.get<AnalyticsSnapshot>(`/api/admin/analytics?from=${range.from}&to=${range.to}`),
      adminApi.get<AnalyticsSnapshot>(`/api/admin/analytics?from=${range.previousFrom}&to=${range.previousTo}`),
      fetchNewPatientCount(clinicTimezone, range.from, range.to),
      fetchNewPatientCount(clinicTimezone, range.previousFrom, range.previousTo),
    ])
      .then(([cur, prev, newCur, newPrev]) => {
        setCurrent(cur);
        setPreviousRevenue(prev);
        setNewPatients({ current: newCur, previous: newPrev });
      })
      .catch((e) => setError(e instanceof AdminApiError ? e.message : "Ma’lumotlarni yuklab bo‘lmadi"));
  }, [range, clinicTimezone]);

  const periodLabel = RANGE_PRESETS.find((p) => p.value === preset)?.label ?? "";
  const daysInRange = range ? daySpan(range.from, range.to) : 1;
  const hasData = current !== null && current.total > 0;

  const pendingCount = current?.by_status.find(([s]) => s === "pending")?.[1] ?? 0;
  const unpaidCount = current?.by_payment_status.find(([s]) => s === "unpaid")?.[1] ?? 0;

  const alerts = useMemo(() => {
    if (!current) return [];
    const list: Array<{ text: string; href: string }> = [];
    if ((current.unpaid_total ?? 0) > 0) {
      list.push({ text: `${unpaidCount} ta qabulda ${formatPrice(current.unpaid_total)} to‘lanmagan`, href: "/admin/finance" });
    }
    if (current.total >= HIGH_CANCELLATION_MIN_SAMPLE && current.cancellation_rate >= HIGH_CANCELLATION_RATE) {
      list.push({ text: `Bekor qilish darajasi yuqori: ${current.cancellation_rate}%`, href: "/admin/analytics" });
    }
    if (pendingCount >= UNCONFIRMED_BACKLOG_THRESHOLD) {
      list.push({ text: `${pendingCount} ta tasdiqlanmagan qabul kutmoqda`, href: "/admin/appointments" });
    }
    return list;
  }, [current, pendingCount, unpaidCount]);

  return (
    <div>
      <PageHeader
        title="Klinika boshqaruvi"
        subtitle={periodLabel}
        action={
          <div className="flex flex-wrap items-center gap-2">
            <div className="w-44">
              <ASelect value={preset} onChange={(v) => setPreset(v as RangePreset)} options={RANGE_PRESETS} aria-label="Davr" />
            </div>
            {preset === "custom" && (
              <>
                <input type="date" value={customFrom} onChange={(e) => setCustomFrom(e.target.value)} className="rounded-lg border border-hairline bg-surface px-3 py-2 text-sm text-foreground outline-none focus:border-pine" aria-label="Boshlanish sanasi" />
                <input type="date" value={customTo} onChange={(e) => setCustomTo(e.target.value)} className="rounded-lg border border-hairline bg-surface px-3 py-2 text-sm text-foreground outline-none focus:border-pine" aria-label="Tugash sanasi" />
              </>
            )}
          </div>
        }
      />

      {error && <AError message={error} />}
      {preset === "custom" && !range && <AError message="Sana oralig‘ini tanlang (boshlanish tugashdan oldin bo‘lishi kerak)" />}

      {alerts.length > 0 && (
        <Card className="mb-6 border-clay/30 bg-clay-tint/40">
          <div className="mb-3 flex items-center gap-2">
            <ShieldAlert className="h-4 w-4 text-clay-deep" />
            <p className="text-sm font-bold text-clay-deep">Diqqat</p>
          </div>
          <div className="space-y-2">
            {alerts.map((a) => (
              <Link key={a.text} href={a.href} className="block rounded-lg px-2.5 py-1.5 text-sm font-medium text-foreground hover:bg-surface">
                {a.text} →
              </Link>
            ))}
          </div>
        </Card>
      )}

      <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
        <StatCard
          label="Jami tushum"
          value={current ? formatPrice(current.total_revenue) : "—"}
          tone="pine"
          sublabel={periodLabel}
          delta={percentChange(current?.total_revenue, previousRevenue?.total_revenue)}
        />
        <StatCard
          label="To‘lanmagan"
          value={current ? formatPrice(current.unpaid_total) : "—"}
          tone="clay"
          delta={percentChange(current?.unpaid_total, previousRevenue?.unpaid_total)}
        />
        <StatCard
          label="O‘rtacha chek"
          value={current ? formatPrice(current.average_ticket) : "—"}
          tone="info"
          delta={percentChange(current?.average_ticket, previousRevenue?.average_ticket)}
        />
        <StatCard
          label="Qabullar"
          value={current ? current.total.toLocaleString("uz-UZ") : "—"}
          tone="neutral"
          delta={percentChange(current?.total, previousRevenue?.total)}
        />
        <StatCard
          label="Yangi bemorlar"
          value={newPatients ? newPatients.current.toLocaleString("uz-UZ") : "—"}
          tone="info"
          delta={newPatients ? percentChange(newPatients.current, newPatients.previous) : null}
        />
        <StatCard
          label="Kelmagan / Bekor qilingan"
          value={current ? `${current.no_shows} / ${current.cancelled}` : "—"}
          tone="clay"
        />
      </div>

      {current !== null && !hasData ? (
        <Card className="mb-6">
          <AEmpty
            title="Hozircha moliyaviy ma’lumot yo‘q"
            subtitle="To‘lovlar qayd etilgach, bu yerda tushum va moliyaviy ko‘rsatkichlar ko‘rsatiladi."
            icon={<Wallet className="h-6 w-6" />}
          />
        </Card>
      ) : (
        <>
          <div className="mb-6 grid grid-cols-1 gap-4 lg:grid-cols-2">
            <RevenueTrendChart
              title="Tushum"
              loading={current === null}
              rows={trendRowsFor(trendBucket, current)}
              bucket={trendBucket}
              onBucketChange={setTrendBucket}
            />
            <Card>
              <div className="mb-4 flex items-center gap-2">
                <Landmark className="h-4 w-4 text-ink-muted" />
                <p className="text-sm font-bold text-foreground">To‘lov usullari</p>
              </div>
              {current === null ? (
                <LoadingRow />
              ) : current.revenue_by_provider.length === 0 ? (
                <AEmpty title="Ma’lumot yo‘q" icon={<Landmark className="h-5 w-5" />} />
              ) : (
                <div className="space-y-3">
                  {current.revenue_by_provider.map((p) => (
                    <div key={p.provider} className="flex items-center justify-between text-sm">
                      <ABadge tone={PROVIDER_TONES[p.provider] ?? "neutral"}>{PROVIDER_LABELS[p.provider] ?? p.provider}</ABadge>
                      <span className="font-numeric font-medium text-foreground">{formatPrice(p.revenue)}</span>
                    </div>
                  ))}
                </div>
              )}
            </Card>
          </div>

          <div className="mb-6 grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Link href="/admin/finance">
              <Card className="h-full transition-shadow hover:shadow-[var(--shadow-pop)]">
                <div className="mb-3 flex items-center gap-2">
                  <Wallet className="h-4 w-4 text-clay-deep" />
                  <p className="text-sm font-bold text-foreground">To‘lanmagan to‘lovlar</p>
                </div>
                <p className="font-numeric text-2xl font-bold text-clay-deep">{current ? formatPrice(current.unpaid_total) : "—"}</p>
                <p className="mt-1 text-xs text-ink-muted">{unpaidCount} ta qabul · Barchasini ko‘rish →</p>
              </Card>
            </Link>

            <Card>
              <div className="mb-3 flex items-center gap-2">
                <ClipboardList className="h-4 w-4 text-ink-muted" />
                <p className="text-sm font-bold text-foreground">Operatsion holat (bugun)</p>
              </div>
              {today === null ? (
                <LoadingRow />
              ) : (
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                  <MiniStat label="Qabullar" value={today.counts.total ?? 0} />
                  <MiniStat label="Yakunlangan" value={today.counts.completed ?? 0} />
                  <MiniStat label="Bekor qilingan" value={today.counts.cancelled ?? 0} />
                  <MiniStat label="Kelmagan" value={today.counts.no_show ?? 0} />
                  <div className="col-span-2 sm:col-span-4">
                    <p className="text-[11px] uppercase tracking-wide text-ink-muted">Yakunlash darajasi</p>
                    <p className="font-numeric text-lg font-bold text-pine-deep">
                      {(today.counts.total ?? 0) > 0 ? `${Math.round(((today.counts.completed ?? 0) / today.counts.total) * 100)}%` : "—"}
                    </p>
                  </div>
                </div>
              )}
            </Card>
          </div>

          <div className="mb-6 grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Card>
              <div className="mb-4 flex items-center gap-2">
                <Stethoscope className="h-4 w-4 text-ink-muted" />
                <p className="text-sm font-bold text-foreground">Shifokorlar samaradorligi</p>
              </div>
              {current === null ? (
                <LoadingRow />
              ) : current.top_doctors.length === 0 ? (
                <AEmpty title="Ma’lumot yo‘q" icon={<Stethoscope className="h-5 w-5" />} />
              ) : (
                <div className="space-y-3">
                  {current.top_doctors.map((d) => (
                    <div key={d.name} className="flex items-center justify-between gap-2 text-sm">
                      <div className="min-w-0">
                        <p className="truncate font-medium text-foreground">{d.name}</p>
                        <p className="text-xs text-ink-muted">
                          {d.completed_count}/{d.count} yakunlangan ({d.completion_rate}%) · kuniga {(d.count / daysInRange).toFixed(1)} ta
                        </p>
                      </div>
                      {d.revenue != null && <span className="font-numeric shrink-0 font-semibold text-pine-deep">{formatPrice(d.revenue)}</span>}
                    </div>
                  ))}
                </div>
              )}
            </Card>

            <Card>
              <div className="mb-4 flex items-center gap-2">
                <Send className="h-4 w-4 text-ink-muted" />
                <p className="text-sm font-bold text-foreground">Booking manbalari</p>
              </div>
              {current === null ? (
                <LoadingRow />
              ) : current.total === 0 ? (
                <AEmpty title="Ma’lumot yo‘q" icon={<Send className="h-5 w-5" />} />
              ) : (
                <div className="space-y-3.5">
                  {SOURCE_GROUPS.map((group) => {
                    const count = current.by_source.filter(([s]) => group.sources.includes(s)).reduce((sum, [, c]) => sum + c, 0);
                    const share = current.total > 0 ? Math.round((count / current.total) * 100) : 0;
                    return (
                      <div key={group.label}>
                        <div className="mb-1.5 flex items-center justify-between text-sm">
                          <span className="font-medium text-foreground">{group.label}</span>
                          <span className="font-numeric text-ink-muted">{count.toLocaleString("uz-UZ")} ({share}%)</span>
                        </div>
                        <div className="h-1.5 overflow-hidden rounded-full bg-sand">
                          <div className="h-full rounded-full bg-gradient-to-r from-pine to-mint" style={{ width: `${Math.max(share, 2)}%` }} />
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </Card>
          </div>

          <Card>
            <div className="mb-4 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Receipt className="h-4 w-4 text-ink-muted" />
                <p className="text-sm font-bold text-foreground">So‘nggi operatsiyalar</p>
              </div>
              <Link href="/admin/finance" className="text-xs font-medium text-pine hover:underline">
                Barchasini ko‘rish →
              </Link>
            </div>
            {current === null ? (
              <LoadingRow />
            ) : current.recent_payments.length === 0 ? (
              <AEmpty title="Operatsiyalar yo‘q" icon={<Receipt className="h-5 w-5" />} />
            ) : (
              <ATable headers={["Sana", "Bemor", "Xizmat", "Shifokor", "Summa", "To‘lov turi", "Holati"]}>
                {current.recent_payments.slice(0, 5).map((p) => (
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
                      <ABadge tone={PAYMENT_STATUS_TONES[p.status] ?? "neutral"}>{PAYMENT_STATUS_LABELS[p.status] ?? p.status}</ABadge>
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

function MiniStat({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <p className="text-[11px] uppercase tracking-wide text-ink-muted">{label}</p>
      <p className="font-numeric text-lg font-bold text-foreground">{value.toLocaleString("uz-UZ")}</p>
    </div>
  );
}

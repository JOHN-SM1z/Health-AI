"use client";

import { useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/browser";
import { PageHeader, Card, AEmpty, AError, ASelect, StatCard, LoadingRow } from "@/components/admin/ui";
import { BarChart3, Users, CalendarX2, TrendingUp, Stethoscope, Scissors, UserX } from "lucide-react";
import { adminApi, AdminApiError, SOURCE_LABELS, STATUS_LABELS } from "@/lib/admin/client";

type AnalyticsRow = {
  event_type: string;
  created_at: string;
  patient_id: string | null;
};

type AppointmentAnalytics = {
  range: number;
  total: number;
  cancelled: number;
  no_shows: number;
  completed: number;
  by_source: [string, number][];
  by_status: [string, number][];
  cancel_reasons: { reason: string; count: number }[];
  no_show_reasons: { reason: string; count: number }[];
  revenue_trend: { date: string; revenue: number }[];
  revenue_by_week: { key: string; revenue: number }[];
  revenue_by_month: { key: string; revenue: number }[];
  top_services: { name: string; count: number; revenue: number }[];
  top_doctors: { name: string; count: number; revenue: number }[];
};

const RANGES = [
  { value: "7", label: "Oxirgi 7 kun" },
  { value: "30", label: "Oxirgi 30 kun" },
  { value: "90", label: "Oxirgi 90 kun" },
];

const TREND_BUCKETS = [
  { value: "day", label: "Kun" },
  { value: "week", label: "Hafta" },
  { value: "month", label: "Oy" },
] as const;

export default function AnalyticsPage() {
  const [range, setRange] = useState("30");
  const [trendBucket, setTrendBucket] = useState<"day" | "week" | "month">("day");
  const [rows, setRows] = useState<AnalyticsRow[] | null>(null);
  const [appointments, setAppointments] = useState<AppointmentAnalytics | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const supabase = createClient();
    const since = new Date(Date.now() - Number(range) * 86400000).toISOString();
    void supabase
      .from("analytics_events")
      .select("event_type, created_at, patient_id")
      .gte("created_at", since)
      .then(({ data, error: err }) => {
        if (err) {
          setError("Tahlil ma'lumotlarini yuklab bo‘lmadi");
          return;
        }
        setRows(data ?? []);
      });

    adminApi
      .get<AppointmentAnalytics>(`/api/admin/analytics?range=${range}`)
      .then((d) => setAppointments(d))
      .catch((e) => setError(e instanceof AdminApiError ? e.message : "Tahlil ma'lumotlarini yuklab bo‘lmadi"));
  }, [range]);

  const stats = useMemo(() => {
    const s = {
      total: 0,
      uniquePatients: new Set<string>(),
      byType: new Map<string, number>(),
    };
    for (const r of rows ?? []) {
      s.total += 1;
      if (r.patient_id) s.uniquePatients.add(r.patient_id);
      s.byType.set(r.event_type, (s.byType.get(r.event_type) ?? 0) + 1);
    }
    const sorted = [...s.byType.entries()].sort((a, b) => b[1] - a[1]);
    return { ...s, sorted };
  }, [rows]);

  const maxCount = stats.sorted[0]?.[1] ?? 1;
  const maxSource = appointments?.by_source[0]?.[1] ?? 1;
  const maxReason = appointments?.cancel_reasons[0]?.count ?? 1;
  const maxNoShowReason = appointments?.no_show_reasons[0]?.count ?? 1;
  const maxStatus = appointments?.by_status[0]?.[1] ?? 1;
  const maxTrend = useMemo(() => {
    const src =
      trendBucket === "week"
        ? appointments?.revenue_by_week
        : trendBucket === "month"
          ? appointments?.revenue_by_month
          : appointments?.revenue_trend;
    return src?.[0]?.revenue ?? 1;
  }, [trendBucket, appointments]);
  const maxService = appointments?.top_services[0]?.count ?? 1;
  const maxDoctor = appointments?.top_doctors[0]?.count ?? 1;

  const trendRows = useMemo(() => {
    const src =
      trendBucket === "week"
        ? appointments?.revenue_by_week
        : trendBucket === "month"
          ? appointments?.revenue_by_month
          : appointments?.revenue_trend;
    return (src ?? []).map((d) => ({ date: "date" in d ? d.date : d.key, revenue: d.revenue }));
  }, [trendBucket, appointments]);

  const completionRate = appointments
    ? appointments.total > 0
      ? Math.round((appointments.completed / appointments.total) * 100)
      : 0
    : null;

  const conversionRate = useMemo(() => {
    const started = stats.byType.get("booking_started") ?? 0;
    const succeeded = stats.byType.get("booking_success") ?? 0;
    if (started === 0) return null;
    return Math.round((succeeded / started) * 100);
  }, [stats.byType]);

  const bars = (entries: [string, number][], max: number) => (
    <div className="space-y-3.5">
      {entries.map(([key, count]) => (
        <div key={key}>
          <div className="mb-1.5 flex justify-between text-sm">
            <span className="text-ink-muted">{key}</span>
            <span className="font-numeric font-medium text-foreground">{count.toLocaleString("uz-UZ")}</span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-sand">
            <div
              className="h-full rounded-full bg-gradient-to-r from-pine to-mint transition-[width] duration-500"
              style={{ width: `${Math.max((count / max) * 100, 4)}%` }}
            />
          </div>
        </div>
      ))}
    </div>
  );

  return (
    <div>
      <PageHeader
        title="Tahlillar"
        subtitle="Qabul manbalari, bekor qilish sabablari va hodisalar"
        action={
          <div className="w-44">
            <ASelect value={range} onChange={setRange} options={RANGES} aria-label="Davr" />
          </div>
        }
      />
      {error && <AError message={error} />}

      <div className="mb-6 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <StatCard label="Jami hodisalar" value={stats.total.toLocaleString("uz-UZ")} tone="neutral" />
        <StatCard label="Faol bemorlar" value={stats.uniquePatients.size.toLocaleString("uz-UZ")} tone="pine" />
        <StatCard label="Turli hodisalar" value={stats.sorted.length.toLocaleString("uz-UZ")} tone="info" />
      </div>

      <div className="mb-6 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <StatCard
          label="Bajarilish darajasi"
          value={completionRate === null ? "—" : `${completionRate}%`}
          tone="pine"
        />
        <StatCard
          label="Bron → qabul konversiya"
          value={conversionRate === null ? "—" : `${conversionRate}%`}
          tone="info"
        />
        <StatCard
          label="Yakunlangan qabullar"
          value={(appointments?.completed ?? 0).toLocaleString("uz-UZ")}
          tone="neutral"
        />
      </div>

      <div className="mb-6 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <div className="mb-4 flex items-center gap-2">
            <TrendingUp className="h-4 w-4 text-ink-muted" />
            <p className="text-sm font-bold text-foreground">Tushum dinamikasi</p>
            <div className="ml-auto w-36">
              <ASelect
                value={trendBucket}
                onChange={(v) => setTrendBucket(v as "day" | "week" | "month")}
                options={[...TREND_BUCKETS]}
                aria-label="Guruhlash"
              />
            </div>
          </div>
          {appointments === null ? (
            <LoadingRow />
          ) : trendRows.length === 0 ? (
            <AEmpty title="Ma'lumot yo‘q" subtitle="Bu davrda to‘langan qabullar yo‘q" icon={<TrendingUp className="h-5 w-5" />} />
          ) : (
            <div className="flex h-40 items-end gap-1.5">
              {trendRows.map((d) => (
                <div key={d.date} className="group flex flex-1 flex-col items-center gap-1">
                  <span className="font-numeric text-[10px] text-ink-muted opacity-0 transition-opacity group-hover:opacity-100">
                    {d.revenue.toLocaleString("uz-UZ")}
                  </span>
                  <div
                    className="w-full rounded-t-md bg-gradient-to-t from-pine to-mint transition-[height] duration-500"
                    style={{ height: `${Math.max((d.revenue / maxTrend) * 100, 6)}%` }}
                    title={`${d.date}: ${d.revenue.toLocaleString("uz-UZ")} so‘m`}
                  />
                  <span className="font-numeric text-[10px] text-ink-muted">{d.date.slice(-5)}</span>
                </div>
              ))}
            </div>
          )}
        </Card>

        <Card>
          <div className="mb-4 flex items-center gap-2">
            <Stethoscope className="h-4 w-4 text-ink-muted" />
            <p className="text-sm font-bold text-foreground">Eng ko‘p shifokorlar</p>
          </div>
          {appointments === null ? (
            <LoadingRow />
          ) : appointments.top_doctors.length === 0 ? (
            <AEmpty title="Ma'lumot yo‘q" subtitle="Bu davrda qabullar yo‘q" icon={<Stethoscope className="h-5 w-5" />} />
          ) : (
            bars(appointments.top_doctors.map((d) => [`${d.name} (${d.count})`, d.count]), maxDoctor)
          )}
        </Card>
      </div>

      <div className="mb-6 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <div className="mb-4 flex items-center gap-2">
            <Scissors className="h-4 w-4 text-ink-muted" />
            <p className="text-sm font-bold text-foreground">Eng ko‘p xizmatlar</p>
          </div>
          {appointments === null ? (
            <LoadingRow />
          ) : appointments.top_services.length === 0 ? (
            <AEmpty title="Ma'lumot yo‘q" subtitle="Bu davrda qabullar yo‘q" icon={<Scissors className="h-5 w-5" />} />
          ) : (
            <div className="space-y-3.5">
              {appointments.top_services.map((s) => (
                <div key={s.name}>
                  <div className="mb-1.5 flex justify-between text-sm">
                    <span className="text-ink-muted">{s.name}</span>
                    <span className="font-numeric font-medium text-foreground">
                      {s.count.toLocaleString("uz-UZ")} · {s.revenue.toLocaleString("uz-UZ")} so‘m
                    </span>
                  </div>
                  <div className="h-1.5 overflow-hidden rounded-full bg-sand">
                    <div
                      className="h-full rounded-full bg-gradient-to-r from-pine to-mint transition-[width] duration-500"
                      style={{ width: `${Math.max((s.count / maxService) * 100, 4)}%` }}
                    />
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>

        <Card>
          <div className="mb-4 flex items-center gap-2">
            <Users className="h-4 w-4 text-ink-muted" />
            <p className="text-sm font-bold text-foreground">Qabul manbalari</p>
            {appointments !== null && (
              <span className="ml-auto font-numeric text-xs text-ink-muted">
                Jami {appointments.total.toLocaleString("uz-UZ")}
              </span>
            )}
          </div>
          {appointments === null ? (
            <LoadingRow />
          ) : appointments.by_source.length === 0 ? (
            <AEmpty title="Ma'lumot yo‘q" subtitle="Bu davrda qabullar yo‘q" icon={<Users className="h-5 w-5" />} />
          ) : (
            bars(
              appointments.by_source.map(([s, c]) => [SOURCE_LABELS[s] ?? s, c]),
              maxSource,
            )
          )}
        </Card>

        <Card>
          <div className="mb-4 flex items-center gap-2">
            <CalendarX2 className="h-4 w-4 text-ink-muted" />
            <p className="text-sm font-bold text-foreground">Bekor qilish sabablari</p>
            {appointments !== null && (
              <span className="ml-auto font-numeric text-xs text-ink-muted">
                Bekor: {appointments.cancelled.toLocaleString("uz-UZ")}
              </span>
            )}
          </div>
          {appointments === null ? (
            <LoadingRow />
          ) : appointments.cancel_reasons.length === 0 ? (
            <AEmpty
              title="Bekor qilishlar yo‘q"
              subtitle="Bu davrda bekor qilingan qabullar qayd etilmagan"
              icon={<CalendarX2 className="h-5 w-5" />}
            />
          ) : (
            bars(appointments.cancel_reasons.map((r) => [r.reason, r.count]), maxReason)
          )}
        </Card>

        <Card>
          <div className="mb-4 flex items-center gap-2">
            <UserX className="h-4 w-4 text-ink-muted" />
            <p className="text-sm font-bold text-foreground">Kelmaslik sabablari</p>
            {appointments !== null && (
              <span className="ml-auto font-numeric text-xs text-ink-muted">
                Kelmagandi: {appointments.no_shows.toLocaleString("uz-UZ")}
              </span>
            )}
          </div>
          {appointments === null ? (
            <LoadingRow />
          ) : appointments.no_show_reasons.length === 0 ? (
            <AEmpty
              title="Kelmasliklar yo‘q"
              subtitle="Bu davrda kelmaslik sabablari qayd etilmagan"
              icon={<UserX className="h-5 w-5" />}
            />
          ) : (
            bars(appointments.no_show_reasons.map((r) => [r.reason, r.count]), maxNoShowReason)
          )}
        </Card>
      </div>

      <div className="mb-6 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <div className="mb-4 flex items-center gap-2">
            <BarChart3 className="h-4 w-4 text-ink-muted" />
            <p className="text-sm font-bold text-foreground">Holatlar bo‘yicha qabullar</p>
          </div>
          {appointments === null ? (
            <LoadingRow />
          ) : appointments.by_status.length === 0 ? (
            <AEmpty title="Ma'lumot yo‘q" subtitle="Bu davrda qabullar yo‘q" icon={<BarChart3 className="h-5 w-5" />} />
          ) : (
            bars(appointments.by_status.map(([s, c]) => [STATUS_LABELS[s] ?? s, c]), maxStatus)
          )}
        </Card>
      </div>

      {rows === null ? (
        <Card><LoadingRow /></Card>
      ) : stats.sorted.length === 0 ? (
        <Card>
          <AEmpty
            title="Ma'lumot yo‘q"
            subtitle="Tanlangan davrda hodisalar qayd etilmagan"
            icon={<BarChart3 className="h-6 w-6" />}
          />
        </Card>
      ) : (
        <Card>
          <p className="mb-4 text-sm font-bold text-foreground">Hodisalar bo‘yicha</p>
          {bars(stats.sorted, maxCount)}
        </Card>
      )}
    </div>
  );
}
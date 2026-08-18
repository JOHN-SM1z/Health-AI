"use client";

import { useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/browser";
import { PageHeader, Card, AEmpty, AError, ASelect, StatCard, LoadingRow } from "@/components/admin/ui";
import { BarChart3, Users, CalendarX2 } from "lucide-react";
import { adminApi, AdminApiError, SOURCE_LABELS } from "@/lib/admin/client";

type AnalyticsRow = {
  event_type: string;
  created_at: string;
  patient_id: string | null;
};

type AppointmentAnalytics = {
  range: number;
  total: number;
  cancelled: number;
  by_source: [string, number][];
  by_status: [string, number][];
  cancel_reasons: { reason: string; count: number }[];
};

const RANGES = [
  { value: "7", label: "Oxirgi 7 kun" },
  { value: "30", label: "Oxirgi 30 kun" },
  { value: "90", label: "Oxirgi 90 kun" },
];

export default function AnalyticsPage() {
  const [range, setRange] = useState("30");
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

      <div className="mb-6 grid grid-cols-1 gap-4 lg:grid-cols-2">
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
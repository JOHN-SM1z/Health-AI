"use client";

import { useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/browser";
import { PageHeader, Card, AEmpty, AError, ASelect } from "@/components/admin/ui";

type AnalyticsRow = {
  event_type: string;
  created_at: string;
  patient_id: string | null;
};

const RANGES = [
  { value: "7", label: "Oxirgi 7 kun" },
  { value: "30", label: "Oxirgi 30 kun" },
  { value: "90", label: "Oxirgi 90 kun" },
];

export default function AnalyticsPage() {
  const [range, setRange] = useState("30");
  const [rows, setRows] = useState<AnalyticsRow[] | null>(null);
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

  return (
    <div>
      <PageHeader
        title="Tahlillar"
        subtitle="Asosiy ko‘rsatkichlar va hodisalar"
        action={
          <div className="w-44">
            <ASelect value={range} onChange={setRange} options={RANGES} aria-label="Davr" />
          </div>
        }
      />
      {error && <AError message={error} />}

      <div className="mb-6 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Card>
          <p className="text-xs uppercase tracking-wide text-slate-400">Jami hodisalar</p>
          <p className="mt-1 text-2xl font-bold text-slate-900">{stats.total.toLocaleString("uz-UZ")}</p>
        </Card>
        <Card>
          <p className="text-xs uppercase tracking-wide text-slate-400">Faol bemorlar</p>
          <p className="mt-1 text-2xl font-bold text-slate-900">{stats.uniquePatients.size.toLocaleString("uz-UZ")}</p>
        </Card>
        <Card>
          <p className="text-xs uppercase tracking-wide text-slate-400">Turli hodisalar</p>
          <p className="mt-1 text-2xl font-bold text-slate-900">{stats.sorted.length}</p>
        </Card>
      </div>

      {rows === null ? (
        <Card><div className="h-2 w-full animate-pulse rounded bg-slate-200" /></Card>
      ) : stats.sorted.length === 0 ? (
        <Card><AEmpty title="Ma'lumot yo‘q" subtitle="Tanlangan davrda hodisalar qayd etilmagan" /></Card>
      ) : (
        <Card>
          <p className="mb-4 text-sm font-bold text-slate-900">Hodisalar bo‘yicha</p>
          <div className="space-y-3">
            {stats.sorted.map(([type, count]) => (
              <div key={type}>
                <div className="mb-1 flex justify-between text-sm">
                  <span className="text-slate-700">{type}</span>
                  <span className="font-medium text-slate-900">{count.toLocaleString("uz-UZ")}</span>
                </div>
                <div className="h-2 rounded-full bg-slate-100">
                  <div className="h-2 rounded-full bg-emerald-500" style={{ width: `${(count / maxCount) * 100}%` }} />
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}
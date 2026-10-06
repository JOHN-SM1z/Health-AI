"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { PageHeader, Card, AError, StatCard, LoadingRow } from "@/components/admin/ui";
import { CalendarDays, MessagesSquare, BarChart3, Stethoscope } from "lucide-react";
import { adminApi, AdminApiError } from "@/lib/admin/client";
import type { DashboardData } from "./types";
import { TodayTable } from "./today-table";

const WEEKDAYS = ["yakshanba", "dushanba", "seshanba", "chorshanba", "payshanba", "juma", "shanba"];
const MONTHS = ["yanvar", "fevral", "mart", "aprel", "may", "iyun", "iyul", "avgust", "sentabr", "oktabr", "noyabr", "dekabr"];

/**
 * Manager home: day-to-day operations — workload, doctor availability and
 * conversation oversight. Financial detail stays in Tahlillar.
 */
export function ManagerOverview() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [todayLabel, setTodayLabel] = useState("");

  useEffect(() => {
    const now = new Date();
    setTodayLabel(`${WEEKDAYS[now.getDay()]}, ${now.getDate()}-${MONTHS[now.getMonth()]} ${now.getFullYear()}`);
  }, []);

  const loadDashboard = () => {
    adminApi
      .get<DashboardData>("/api/admin/dashboard")
      .then(setData)
      .catch((e) => setError(e instanceof AdminApiError ? e.message : "Ma'lumotlarni yuklab bo‘lmadi"));
  };

  useEffect(() => {
    loadDashboard();
  }, []);

  return (
    <div>
      <PageHeader title="Operatsiyalar" subtitle={todayLabel} />

      {error && <AError message={error} />}

      <div className="mb-6 flex flex-wrap gap-2">
        <Link href="/admin/calendar" className="inline-flex items-center gap-1.5 rounded-xl border border-hairline bg-surface px-3.5 py-2 text-sm font-medium text-foreground shadow-[var(--shadow-card)] transition-colors hover:bg-pine-tint">
          <span className="text-pine"><CalendarDays className="h-4 w-4" /></span>
          Kalendar
        </Link>
        <Link href="/admin/doctors" className="inline-flex items-center gap-1.5 rounded-xl border border-hairline bg-surface px-3.5 py-2 text-sm font-medium text-foreground shadow-[var(--shadow-card)] transition-colors hover:bg-pine-tint">
          <span className="text-pine"><Stethoscope className="h-4 w-4" /></span>
          Shifokorlar
        </Link>
        <Link href="/admin/conversations" className="inline-flex items-center gap-1.5 rounded-xl border border-hairline bg-surface px-3.5 py-2 text-sm font-medium text-foreground shadow-[var(--shadow-card)] transition-colors hover:bg-pine-tint">
          <span className="text-pine"><MessagesSquare className="h-4 w-4" /></span>
          Suhbatlar
        </Link>
        <Link href="/admin/analytics" className="inline-flex items-center gap-1.5 rounded-xl border border-hairline bg-surface px-3.5 py-2 text-sm font-medium text-foreground shadow-[var(--shadow-card)] transition-colors hover:bg-pine-tint">
          <span className="text-pine"><BarChart3 className="h-4 w-4" /></span>
          Tahlillar
        </Link>
      </div>

      {data === null && !error ? (
        <Card>
          <LoadingRow />
        </Card>
      ) : (
        <>
          <div className="mb-3 grid grid-cols-2 gap-3 md:grid-cols-4">
            <StatCard label="Yangi bemorlar (bugun)" value={(data?.new_patients_today ?? 0).toLocaleString("uz-UZ")} tone="info" />
            <StatCard
              label="Shifokorlar qabulda"
              value={`${data?.doctors_today ?? 0} / ${data?.doctors_active ?? 0}`}
              tone="neutral"
            />
            <Link href="/admin/conversations">
              <StatCard label="Faol suhbatlar" value={(data?.active_conversations ?? 0).toLocaleString("uz-UZ")} tone="info" />
            </Link>
            <Link href="/admin/conversations">
              <StatCard label="Diqqat talab suhbatlar" value={(data?.attention_conversations ?? 0).toLocaleString("uz-UZ")} tone="clay" />
            </Link>
          </div>

          {data?.upcoming_reminders !== null && data?.upcoming_reminders !== undefined && (
            <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-4">
              <StatCard label="Eslatmalar (24 soat)" value={data.upcoming_reminders.toLocaleString("uz-UZ")} tone="neutral" />
            </div>
          )}
        </>
      )}

      <TodayTable onChanged={loadDashboard} />
    </div>
  );
}

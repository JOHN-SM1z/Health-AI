"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { PageHeader, Card, AError, StatCard, LoadingRow } from "@/components/admin/ui";
import { CalendarDays, MessagesSquare, Users, AlertTriangle } from "lucide-react";
import { adminApi, AdminApiError } from "@/lib/admin/client";
import type { DashboardData } from "./types";
import { TodayTable } from "./today-table";

const WEEKDAYS = ["yakshanba", "dushanba", "seshanba", "chorshanba", "payshanba", "juma", "shanba"];
const MONTHS = ["yanvar", "fevral", "mart", "aprel", "may", "iyun", "iyul", "avgust", "sentabr", "oktabr", "noyabr", "dekabr"];

/**
 * Receptionist home: real-time patient operations. No business analytics,
 * no financials — just the live queue and the chats that need a human.
 */
export function ReceptionOverview() {
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

  const counts = data?.counts ?? {};

  return (
    <div>
      <PageHeader title="Qabulxona" subtitle={todayLabel} />

      {error && <AError message={error} />}

      <div className="mb-6 flex flex-wrap gap-2">
        <Link href="/admin/patients" className="inline-flex items-center gap-1.5 rounded-xl border border-hairline bg-surface px-3.5 py-2 text-sm font-medium text-foreground shadow-[var(--shadow-card)] transition-colors hover:bg-pine-tint">
          <span className="text-pine"><Users className="h-4 w-4" /></span>
          Bemor topish
        </Link>
        <Link href="/admin/calendar" className="inline-flex items-center gap-1.5 rounded-xl border border-hairline bg-surface px-3.5 py-2 text-sm font-medium text-foreground shadow-[var(--shadow-card)] transition-colors hover:bg-pine-tint">
          <span className="text-pine"><CalendarDays className="h-4 w-4" /></span>
          Bugungi kalendar
        </Link>
        <Link href="/admin/conversations" className="inline-flex items-center gap-1.5 rounded-xl border border-hairline bg-surface px-3.5 py-2 text-sm font-medium text-foreground shadow-[var(--shadow-card)] transition-colors hover:bg-pine-tint">
          <span className="text-pine"><MessagesSquare className="h-4 w-4" /></span>
          Suhbatlar
        </Link>
      </div>

      {data === null && !error ? (
        <Card>
          <LoadingRow />
        </Card>
      ) : (
        <>
          {/* Attention-needed chats are the receptionist's #1 signal */}
          <Link href="/admin/conversations" className="mb-6 block">
            <Card className="border-clay/30 bg-clay-tint/50 transition-colors hover:bg-clay-tint">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                  <AlertTriangle className="h-5 w-5 text-clay-deep" />
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-wide text-clay-deep">Diqqat talab suhbatlar</p>
                    <p className="text-sm text-ink-muted">Bemor operator kutmoqda — javob bering</p>
                  </div>
                </div>
                <p className="font-numeric text-3xl font-bold text-clay-deep">{data?.attention_conversations ?? 0}</p>
              </div>
            </Card>
          </Link>

          <div className="mb-3 grid grid-cols-2 gap-3 md:grid-cols-4">
            <StatCard label="Keldi (kutmoqda)" value={(counts.checked_in ?? 0).toLocaleString("uz-UZ")} tone="pine" />
            <StatCard label="Jarayonda" value={(counts.in_progress ?? 0).toLocaleString("uz-UZ")} tone="info" />
            <StatCard label="Yakunlangan" value={(counts.completed ?? 0).toLocaleString("uz-UZ")} tone="neutral" />
            <StatCard label="Faol suhbatlar" value={(data?.active_conversations ?? 0).toLocaleString("uz-UZ")} tone="info" />
          </div>

          <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-4">
            <StatCard label="Kutilmoqda" value={(counts.pending ?? 0).toLocaleString("uz-UZ")} tone="neutral" />
            <StatCard label="Tasdiqlangan" value={(counts.confirmed ?? 0).toLocaleString("uz-UZ")} tone="neutral" />
            <StatCard label="Bekor qilingan" value={(counts.cancelled ?? 0).toLocaleString("uz-UZ")} tone="clay" />
            <StatCard label="Kelmaganlar" value={(counts.no_show ?? 0).toLocaleString("uz-UZ")} tone="clay" />
          </div>
        </>
      )}

      <TodayTable onChanged={loadDashboard} />
    </div>
  );
}

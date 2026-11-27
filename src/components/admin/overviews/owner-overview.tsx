"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { PageHeader, Card, ABadge, AEmpty, AError, StatCard, LoadingRow } from "@/components/admin/ui";
import { BarChart3, CalendarDays, MessagesSquare, Scissors, Settings, Stethoscope, UsersRound, ClipboardList } from "lucide-react";
import { STATUS_LABELS, STATUS_TONES, SOURCE_LABELS, formatTime, formatPrice, adminApi, AdminApiError } from "@/lib/admin/client";
import type { DashboardData } from "./types";

const WEEKDAYS = ["yakshanba", "dushanba", "seshanba", "chorshanba", "payshanba", "juma", "shanba"];
const MONTHS = ["yanvar", "fevral", "mart", "aprel", "may", "iyun", "iyul", "avgust", "sentabr", "oktabr", "noyabr", "dekabr"];

/**
 * Clinic-owner home: business and financial visibility. Operational queues
 * live one click away (Qabullar) instead of dominating the screen.
 */
export function OwnerOverview() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [todayLabel, setTodayLabel] = useState("");

  useEffect(() => {
    const now = new Date();
    setTodayLabel(`${WEEKDAYS[now.getDay()]}, ${now.getDate()}-${MONTHS[now.getMonth()]} ${now.getFullYear()}`);
  }, []);

  useEffect(() => {
    adminApi
      .get<DashboardData>("/api/admin/dashboard")
      .then(setData)
      .catch((e) => setError(e instanceof AdminApiError ? e.message : "Ma'lumotlarni yuklab bo‘lmadi"));
  }, []);

  const counts = data?.counts ?? {};
  const sources = Object.entries(data?.source_distribution ?? {}).sort((a, b) => b[1] - a[1]);
  const maxSource = sources[0]?.[1] ?? 1;

  const quickActions = [
    { href: "/admin/doctors", label: "Shifokor qo‘shish", icon: <Stethoscope className="h-4 w-4" /> },
    { href: "/admin/services", label: "Xizmat qo‘shish", icon: <Scissors className="h-4 w-4" /> },
    { href: "/admin/staff", label: "Xodim qo‘shish", icon: <UsersRound className="h-4 w-4" /> },
    { href: "/admin/settings", label: "Telegram bot", icon: <Settings className="h-4 w-4" /> },
    { href: "/admin/appointments", label: "Qabullar", icon: <ClipboardList className="h-4 w-4" /> },
    { href: "/admin/conversations", label: "Suhbatlar", icon: <MessagesSquare className="h-4 w-4" /> },
    { href: "/admin/analytics", label: "Tahlillar", icon: <BarChart3 className="h-4 w-4" /> },
  ];

  return (
    <div>
      <PageHeader title="Klinika bugun" subtitle={todayLabel} />

      {error && <AError message={error} />}

      {/* Quick actions */}
      <div className="mb-6 flex flex-wrap gap-2">
        {quickActions.map((a) => (
          <Link
            key={a.href}
            href={a.href}
            className="inline-flex items-center gap-1.5 rounded-xl border border-hairline bg-surface px-3.5 py-2 text-sm font-medium text-foreground shadow-[var(--shadow-card)] transition-colors hover:bg-pine-tint"
          >
            <span className="text-pine">{a.icon}</span>
            {a.label}
          </Link>
        ))}
      </div>

      {data === null && !error ? (
        <Card>
          <LoadingRow />
        </Card>
      ) : (
        <>
          {/* Business KPIs */}
          <div className="mb-3 grid grid-cols-2 gap-3 md:grid-cols-4">
            <StatCard label="Bugungi qabullar" value={(counts.total ?? 0).toLocaleString("uz-UZ")} tone="info" />
            <StatCard label="Yakunlangan" value={(counts.completed ?? 0).toLocaleString("uz-UZ")} tone="pine" />
            <StatCard label="Bekor qilingan" value={(counts.cancelled ?? 0).toLocaleString("uz-UZ")} tone="clay" />
            <StatCard label="Kelmaganlar" value={(counts.no_show ?? 0).toLocaleString("uz-UZ")} tone="neutral" />
          </div>

          {data?.can_view_payment_dynamics && (
            <div className="mb-3 grid grid-cols-2 gap-3 md:grid-cols-4">
              <StatCard label="Tushum (bugun)" value={formatPrice(data.revenue)} tone="pine" />
              <StatCard label="Tushum (7 kun)" value={formatPrice(data.revenue_week)} tone="pine" />
              <StatCard label="Tushum (oy bo‘yi)" value={formatPrice(data.revenue_month)} tone="pine" />
              <StatCard label="Qarzdorlik (bugun)" value={formatPrice(data.outstanding)} tone="clay" />
            </div>
          )}

          <div className="mb-3 grid grid-cols-2 gap-3 md:grid-cols-4">
            <StatCard label="Yangi bemorlar (bugun)" value={(data?.new_patients_today ?? 0).toLocaleString("uz-UZ")} tone="info" />
            {data?.total_patients !== null && data?.total_patients !== undefined && (
              <StatCard label="Bemorlar (jami)" value={data.total_patients.toLocaleString("uz-UZ")} tone="neutral" />
            )}
            {data?.upcoming_reminders !== null && data?.upcoming_reminders !== undefined && (
              <StatCard label="Eslatmalar (24 soat)" value={data.upcoming_reminders.toLocaleString("uz-UZ")} tone="neutral" />
            )}
          </div>

          {/* AI / Telegram performance */}
          <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-4">
            <Link href="/admin/conversations">
              <StatCard label="Faol suhbatlar" value={(data?.active_conversations ?? 0).toLocaleString("uz-UZ")} tone="info" />
            </Link>
            <Link href="/admin/conversations">
              <StatCard label="AI yuritayotgani" value={(data?.ai_conversations ?? 0).toLocaleString("uz-UZ")} tone="neutral" />
            </Link>
            <Link href="/admin/conversations">
              <StatCard label="Odam olgani" value={(data?.takeover_conversations ?? 0).toLocaleString("uz-UZ")} tone="clay" />
            </Link>
            <Link href="/admin/conversations">
              <StatCard label="Diqqat talab" value={(data?.attention_conversations ?? 0).toLocaleString("uz-UZ")} tone="clay" />
            </Link>
          </div>

          <div className="grid gap-6 lg:grid-cols-2">
            {/* Booking sources (30 days) */}
            <Card>
              <p className="font-display mb-3 text-sm font-bold uppercase tracking-wide text-ink-muted">
                Manbalar bo‘yicha yozuvlar (30 kun)
              </p>
              {sources.length === 0 ? (
                <AEmpty title="Hozircha yo‘q" subtitle="So‘nggi 30 kunda yozuvlar yo‘q" icon={<BarChart3 className="h-5 w-5" />} />
              ) : (
                <div className="flex flex-col gap-2.5">
                  {sources.map(([source, count]) => (
                    <div key={source} className="flex items-center gap-3">
                      <span className="w-28 shrink-0 truncate text-xs font-medium text-ink-muted">
                        {SOURCE_LABELS[source] ?? source}
                      </span>
                      <div className="h-2.5 flex-1 overflow-hidden rounded-full bg-sand">
                        <div className="h-full rounded-full bg-pine" style={{ width: `${Math.max(8, Math.round((count / maxSource) * 100))}%` }} />
                      </div>
                      <span className="font-numeric w-10 shrink-0 text-right text-sm font-bold text-foreground">{count}</span>
                    </div>
                  ))}
                </div>
              )}
            </Card>

            {/* Recent activity */}
            <Card>
              <p className="font-display mb-3 text-sm font-bold uppercase tracking-wide text-ink-muted">So‘nggi harakatlar</p>
              {!data?.recent_activity || data.recent_activity.length === 0 ? (
                <AEmpty title="Harakat yo‘q" icon={<CalendarDays className="h-5 w-5" />} />
              ) : (
                <ul className="divide-y divide-hairline/70">
                  {data.recent_activity.map((a) => (
                    <li key={a.id} className="flex items-center justify-between gap-3 py-2.5">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-foreground">
                          {a.patients?.full_name ?? "—"}
                          <span className="ml-1.5 text-xs font-normal text-ink-muted">{a.services?.name ?? ""}</span>
                        </p>
                        <p className="text-xs text-ink-muted">
                          {formatTime(a.start_at)} · {SOURCE_LABELS[a.source] ?? a.source} · {a.doctors?.name ?? "—"}
                        </p>
                      </div>
                      <ABadge tone={STATUS_TONES[a.status]}>{STATUS_LABELS[a.status] ?? a.status}</ABadge>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>
        </>
      )}
    </div>
  );
}

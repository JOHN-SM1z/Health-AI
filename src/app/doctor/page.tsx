"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ChevronLeft, ChevronRight, Stethoscope, CalendarDays } from "lucide-react";
import { createClient } from "@/lib/supabase/browser";
import type { Database } from "@/lib/supabase/database.types";
import { getCurrentDoctor, type CurrentDoctor } from "@/lib/doctor/current-doctor";
import { PageHeader, Card, ABadge, AEmpty, AError, AButton, StatCard, LoadingRow } from "@/components/admin/ui";
import { STATUS_LABELS, STATUS_TONES, formatTime, formatDateTime, formatPrice, adminApi } from "@/lib/admin/client";
import { addDays } from "@/lib/admin/date-range";
import { clinicDateKey, localDayWindowForDate } from "@/lib/time/local";
import { doctorDayCounts } from "@/lib/admin/today-aggregate";
import { ConsultationModal } from "@/components/admin/consultation-modal";
import { nextConsultationStep } from "@/lib/doctor/consultation-flow";

const WEEKDAYS = ["yakshanba", "dushanba", "seshanba", "chorshanba", "payshanba", "juma", "shanba"];
const MONTHS = ["yanvar", "fevral", "mart", "aprel", "may", "iyun", "iyul", "avgust", "sentabr", "oktabr", "noyabr", "dekabr"];

type Row = {
  id: string;
  start_at: string;
  status: Database["public"]["Enums"]["appointment_status"];
  notes: string | null;
  patients: { id: string; full_name: string | null; phone: string | null } | null;
  services: { name: string; price: number } | null;
};

type WorkingHour = { weekday: number };

// Pure date-label helpers built off a "YYYY-MM-DD" clinic-local key (never
// `new Date()` + Intl directly) so the server-rendered and client-rendered
// strings always match regardless of the browser's own locale/timezone data
// — see the same concern noted in src/lib/time/local.ts.
function isoWeekdayOf(ymd: string): number {
  const [y, m, d] = ymd.split("-").map(Number);
  const jsDay = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return jsDay === 0 ? 7 : jsDay;
}

function formatYmdLabel(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const jsDay = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return `${WEEKDAYS[jsDay]}, ${d}-${MONTHS[m - 1]}`;
}

export default function DoctorDashboardPage() {
  const [doctor, setDoctor] = useState<CurrentDoctor | null | undefined>(undefined);
  const [clinicTimezone, setClinicTimezone] = useState<string | null>(null);
  const [todayKey, setTodayKey] = useState<string | null>(null);
  const [dateKey, setDateKey] = useState<string | null>(null);
  const [workingHours, setWorkingHours] = useState<WorkingHour[] | null>(null);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [upcoming, setUpcoming] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [modalTarget, setModalTarget] = useState<Row | null>(null);

  // Resolve the signed-in doctor and the clinic's own timezone once.
  useEffect(() => {
    const supabase = createClient();
    void (async () => {
      const d = await getCurrentDoctor(supabase);
      setDoctor(d);
      if (!d) return;

      let tz = "Asia/Tashkent";
      try {
        const me = await adminApi.get<{ clinicTimezone: string }>("/api/admin/me");
        tz = me.clinicTimezone;
      } catch {
        // Best-effort only — a doctor's device may not match the clinic's
        // timezone, but the dashboard shouldn't block on this call failing.
      }
      setClinicTimezone(tz);
      const key = clinicDateKey(tz, new Date());
      setTodayKey(key);
      setDateKey(key);

      const { data: wh } = await supabase.from("doctor_working_hours").select("weekday").eq("doctor_id", d.id);
      setWorkingHours(wh ?? []);
    })();
  }, []);

  const loadDay = async () => {
    if (!doctor || !clinicTimezone || !dateKey) return;
    const supabase = createClient();
    const { start, end } = localDayWindowForDate(clinicTimezone, dateKey);
    const { data, error: err } = await supabase
      .from("appointments")
      .select("id, start_at, status, notes, patients(id, full_name, phone), services(name, price)")
      .eq("doctor_id", doctor.id)
      .gte("start_at", start)
      .lt("start_at", end)
      .not("status", "in", '("cancelled","no_show")')
      .order("start_at", { ascending: true });
    if (err) {
      setError("Qabullarni yuklab bo‘lmadi");
      return;
    }
    const dayRows = (data as Row[] | null) ?? [];
    setRows(dayRows);
    setError(null);

    // Only worth fetching for today's empty state — a navigated-to day with
    // no appointments doesn't need "what's coming up" prompting.
    if (dayRows.length === 0 && dateKey === todayKey) {
      const { data: soon } = await supabase
        .from("appointments")
        .select("id, start_at, status, notes, patients(id, full_name, phone), services(name, price)")
        .eq("doctor_id", doctor.id)
        .gt("start_at", end)
        .not("status", "in", '("cancelled","no_show")')
        .order("start_at", { ascending: true })
        .limit(3);
      setUpcoming((soon as Row[] | null) ?? []);
    } else {
      setUpcoming(null);
    }
  };

  useEffect(() => {
    void loadDay();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doctor, clinicTimezone, dateKey]);

  // An active consultation always takes priority over anyone still waiting —
  // it's the doctor's actual CURRENT patient, not just the next one up.
  const nextPatient = useMemo(() => {
    if (!rows) return null;
    return (
      rows.find((r) => r.status === "in_progress") ??
      rows.find((r) => r.status === "checked_in") ??
      rows.find((r) => r.status === "confirmed") ??
      rows.find((r) => r.status === "pending") ??
      null
    );
  }, [rows]);

  const counts = useMemo(() => doctorDayCounts(rows ?? []), [rows]);

  const nextWorkingDayLabel = useMemo(() => {
    if (!workingHours || workingHours.length === 0 || !dateKey) return null;
    const workWeekdays = new Set(workingHours.map((h) => h.weekday));
    for (let delta = 1; delta <= 7; delta++) {
      const ymd = addDays(dateKey, delta);
      if (workWeekdays.has(isoWeekdayOf(ymd))) return formatYmdLabel(ymd);
    }
    return null;
  }, [workingHours, dateKey]);

  if (doctor === undefined) {
    return (
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        {[0, 1, 2, 3, 4].map((i) => (
          <Card key={i}>
            <LoadingRow />
          </Card>
        ))}
      </div>
    );
  }

  if (doctor === null) {
    return (
      <div>
        <PageHeader eyebrow="Health AI — Shifokor" title="Bugungi qabullar" />
        <Card>
          <AEmpty
            title="Shifokor hisobi ulanmagan"
            subtitle="Admin panelda shifokor kartasiga profilingizni bog‘lang (Shifokorlar → Boshqarish)."
            icon={<Stethoscope className="h-6 w-6" />}
          />
        </Card>
      </div>
    );
  }

  const isToday = dateKey === todayKey;

  return (
    <div>
      <PageHeader
        eyebrow="Health AI — Shifokor"
        title="Bugungi qabullar"
        subtitle={dateKey ? formatYmdLabel(dateKey) : undefined}
        action={
          dateKey && (
            <div className="flex items-center gap-1.5">
              <AButton variant="outline" size="sm" onClick={() => setDateKey(addDays(dateKey, -1))}>
                <ChevronLeft className="h-4 w-4" />
                <span className="sr-only">Oldingi kun</span>
              </AButton>
              {!isToday && todayKey && (
                <AButton variant="secondary" size="sm" onClick={() => setDateKey(todayKey)}>
                  Bugun
                </AButton>
              )}
              <AButton variant="outline" size="sm" onClick={() => setDateKey(addDays(dateKey, 1))}>
                <ChevronRight className="h-4 w-4" />
                <span className="sr-only">Keyingi kun</span>
              </AButton>
            </div>
          )
        }
      />

      {error && <AError message={error} />}

      {rows === null ? (
        <Card>
          <LoadingRow />
        </Card>
      ) : rows.length === 0 ? (
        <Card>
          <AEmpty
            title={isToday ? "Bugun qabul rejalashtirilmagan" : "Bu kunga qabul yo‘q"}
            subtitle={isToday ? undefined : "Boshqa kunni tanlang yoki bugungi kunga qayting."}
            icon={<CalendarDays className="h-6 w-6" />}
          />
          {isToday && (nextWorkingDayLabel || (upcoming && upcoming.length > 0)) && (
            <div className="mt-2 space-y-3 border-t border-hairline pt-4">
              {nextWorkingDayLabel && (
                <p className="text-sm text-ink-muted">
                  Keyingi ish kuni: <span className="font-medium text-foreground">{nextWorkingDayLabel}</span>
                </p>
              )}
              {upcoming && upcoming.length > 0 && (
                <div>
                  <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-ink-muted">Yaqin kunlardagi qabullar</p>
                  <ul className="space-y-1">
                    {upcoming.map((r) => (
                      <li key={r.id} className="text-sm text-foreground">
                        {formatDateTime(r.start_at)} — {r.patients?.full_name ?? "Bemor"}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              <Link
                href="/doctor/schedule"
                className="inline-flex items-center rounded-lg border border-hairline px-3 py-1.5 text-xs font-medium text-foreground hover:bg-sand"
              >
                Mening kalendarim
              </Link>
            </div>
          )}
        </Card>
      ) : (
        <>
          <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-5">
            <StatCard label="Bugungi qabullar" value={counts.total} />
            <StatCard label="Kutilmoqda" value={counts.waiting} tone="clay" />
            <StatCard label="Keldi" value={counts.checkedIn} tone="info" />
            <StatCard label="Jarayonda" value={counts.inProgress} tone="info" />
            <StatCard label="Yakunlangan" value={counts.completed} tone="pine" />
          </div>

          {nextPatient && (
            <Card className="mb-6 border-pine/30 bg-pine-tint/60">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-pine-deep">
                    <span className="pulse-dot" />
                    Keyingi bemor
                  </p>
                  <p className="font-display mt-1 text-lg font-bold text-foreground">{nextPatient.patients?.full_name ?? "—"}</p>
                  <p className="font-numeric text-sm text-ink-muted">
                    {formatTime(nextPatient.start_at)} · {nextPatient.services?.name ?? "—"} · {formatPrice(nextPatient.services?.price)}
                  </p>
                  {nextPatient.notes?.trim() && (
                    <p className="mt-1 max-w-md truncate text-xs text-ink-muted" title={nextPatient.notes}>
                      “{nextPatient.notes}”
                    </p>
                  )}
                </div>
                <AButton onClick={() => setModalTarget(nextPatient)}>
                  {nextConsultationStep(nextPatient.status)?.label ?? "Batafsil"}
                </AButton>
              </div>
            </Card>
          )}

          <Card className="p-0">
            <div className="divide-y divide-hairline/70">
              {rows.map((r) => (
                <button
                  key={r.id}
                  type="button"
                  onClick={() => setModalTarget(r)}
                  className={`flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition-colors hover:bg-sand ${
                    r.id === nextPatient?.id ? "bg-pine-tint/50" : ""
                  }`}
                >
                  <div className="flex items-center gap-3">
                    <span className="font-numeric w-14 shrink-0 text-sm font-semibold text-foreground">{formatTime(r.start_at)}</span>
                    <div>
                      <p className="text-sm font-medium text-foreground">{r.patients?.full_name ?? "—"}</p>
                      <p className="text-xs text-ink-muted">{r.services?.name ?? "—"}</p>
                    </div>
                  </div>
                  <ABadge tone={STATUS_TONES[r.status] ?? "neutral"}>{STATUS_LABELS[r.status] ?? r.status}</ABadge>
                </button>
              ))}
            </div>
          </Card>
        </>
      )}

      {modalTarget && (
        <ConsultationModal
          appointment={modalTarget}
          doctorId={doctor.id}
          onClose={() => setModalTarget(null)}
          onStatusChanged={() => void loadDay()}
        />
      )}
    </div>
  );
}

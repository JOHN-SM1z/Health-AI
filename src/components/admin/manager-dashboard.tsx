"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ChevronLeft, ChevronRight, UserPlus, ClipboardList, ShieldAlert, Stethoscope } from "lucide-react";
import { PageHeader, Card, StatCard, ABadge, AError, AButton, LoadingRow, AEmpty } from "@/components/admin/ui";
import { formatTime, adminApi, AdminApiError } from "@/lib/admin/client";
import { doctorWorkloadToday, countDelayedToday } from "@/lib/admin/today-aggregate";
import type { DashboardSnapshot, TodayAppointmentRow } from "@/lib/admin/dashboard-types";
import { addDays } from "@/lib/admin/date-range";
import { createClient } from "@/lib/supabase/browser";
import { clinicDateKey } from "@/lib/time/local";
import { QuickBookingModal } from "@/components/admin/quick-booking-modal";
import { CancelAppointmentModal } from "@/components/admin/cancel-appointment-modal";
import { RecordPaymentModal } from "@/components/admin/record-payment-modal";
import { AppointmentBoard } from "@/components/admin/appointment-board";

type Row = TodayAppointmentRow;

// Same-day operational thresholds — small samples (a single clinic, one
// day) so these stay conservative to avoid crying wolf.
const PENDING_BACKLOG_THRESHOLD = 3;
const NO_SHOW_ALERT_THRESHOLD = 2;
const CANCELLED_ALERT_THRESHOLD = 3;

function formatDayLabel(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("uz-UZ", { weekday: "long", day: "numeric", month: "long" });
}

export function ManagerDashboard({ clinicTimezone }: { clinicTimezone: string }) {
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [now, setNow] = useState(() => new Date());
  const [modalOpen, setModalOpen] = useState(false);
  const [cancelTarget, setCancelTarget] = useState<Row | null>(null);
  const [paymentTarget, setPaymentTarget] = useState<Row | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setSelectedDate(clinicDateKey(clinicTimezone, new Date()));
  }, [clinicTimezone]);

  const todayKey = useMemo(() => clinicDateKey(clinicTimezone, new Date()), [clinicTimezone]);
  const isToday = selectedDate === todayKey;

  const load = async (date: string) => {
    setNow(new Date());
    let day: { start: string; end: string } | null = null;
    try {
      day = (await adminApi.get<DashboardSnapshot>(`/api/admin/dashboard?date=${date}`)).day;
    } catch {
      day = null;
    }
    if (!day) {
      setError("Ma’lumotlarni yuklab bo‘lmadi");
      return;
    }
    const supabase = createClient();
    const { data, error: err } = await supabase
      .from("appointments")
      .select("id, start_at, status, source, patients(full_name, phone), doctors(name), services(name, price), payments(status)")
      .gte("start_at", day.start)
      .lt("start_at", day.end)
      .order("start_at", { ascending: true });
    if (err) {
      setError("Ma’lumotlarni yuklab bo‘lmadi");
      return;
    }
    setRows(data ?? []);
    setError(null);
  };

  useEffect(() => {
    if (selectedDate) void load(selectedDate);
  }, [selectedDate]);

  const counts = useMemo(() => {
    const c: Record<string, number> = { total: 0, pending: 0, confirmed: 0, checked_in: 0, in_progress: 0, completed: 0, cancelled: 0, no_show: 0 };
    for (const r of rows ?? []) {
      c.total += 1;
      c[r.status] = (c[r.status] ?? 0) + 1;
    }
    return c;
  }, [rows]);

  const workload = useMemo(() => (rows ? doctorWorkloadToday(rows, now) : []), [rows, now]);
  const delayedCount = useMemo(() => (rows ? countDelayedToday(rows, now) : 0), [rows, now]);
  const busyDoctors = workload.filter((d) => d.busy).length;

  const alerts = useMemo(() => {
    if (!rows) return [];
    const list: Array<{ text: string; href: string }> = [];
    if (counts.pending >= PENDING_BACKLOG_THRESHOLD) {
      list.push({ text: `${counts.pending} ta tasdiqlanmagan qabul kutmoqda`, href: "/admin/appointments" });
    }
    if (counts.no_show >= NO_SHOW_ALERT_THRESHOLD) {
      list.push({ text: `Bugun ${counts.no_show} ta bemor kelmadi`, href: "/admin/appointments" });
    }
    if (counts.cancelled >= CANCELLED_ALERT_THRESHOLD) {
      list.push({ text: `Bugun ${counts.cancelled} ta qabul bekor qilindi`, href: "/admin/appointments" });
    }
    return list;
  }, [rows, counts]);

  const setStatus = async (id: string, status: string) => {
    setBusyId(id);
    try {
      await adminApi.patch(`/api/admin/appointments/${id}`, { action: "status", status });
      if (selectedDate) await load(selectedDate);
    } catch (e) {
      setError(e instanceof AdminApiError ? e.message : "Xatolik yuz berdi");
    } finally {
      setBusyId(null);
    }
  };

  if (!selectedDate) {
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

  return (
    <div>
      <PageHeader
        title="Bugungi operatsiyalar"
        subtitle={formatDayLabel(selectedDate)}
        action={
          <div className="flex items-center gap-2">
            <div className="flex items-center rounded-lg border border-hairline bg-surface">
              <button
                type="button"
                aria-label="Oldingi kun"
                onClick={() => setSelectedDate(addDays(selectedDate, -1))}
                className="p-2 text-ink-muted hover:text-foreground"
              >
                <ChevronLeft className="h-4 w-4" />
              </button>
              {!isToday && (
                <button type="button" onClick={() => setSelectedDate(todayKey)} className="px-2 text-xs font-medium text-pine hover:underline">
                  Bugun
                </button>
              )}
              <button
                type="button"
                aria-label="Keyingi kun"
                onClick={() => setSelectedDate(addDays(selectedDate, 1))}
                className="p-2 text-ink-muted hover:text-foreground"
              >
                <ChevronRight className="h-4 w-4" />
              </button>
            </div>
            <AButton size="md" onClick={() => setModalOpen(true)}>
              <UserPlus className="mr-1.5 h-4 w-4" />
              Yangi qabul
            </AButton>
          </div>
        }
      />

      {error && <AError message={error} />}

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

      <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-5">
        <StatCard label="Jami qabullar" value={counts.total.toLocaleString("uz-UZ")} tone="neutral" />
        <StatCard label="Kutilmoqda" value={counts.pending.toLocaleString("uz-UZ")} tone="clay" />
        <StatCard label="Tasdiqlangan" value={counts.confirmed.toLocaleString("uz-UZ")} tone="info" />
        <StatCard label="Keldi" value={counts.checked_in.toLocaleString("uz-UZ")} tone="pine" />
        <StatCard label="Jarayonda" value={counts.in_progress.toLocaleString("uz-UZ")} tone="info" />
      </div>

      <div className="mb-6 grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-1">
          <div className="mb-3 flex items-center gap-2">
            <ClipboardList className="h-4 w-4 text-ink-muted" />
            <p className="text-sm font-bold text-foreground">Bugungi holat</p>
          </div>
          {rows === null ? (
            <LoadingRow />
          ) : (
            <div className="space-y-2.5 text-sm">
              <div className="flex items-center justify-between">
                <span className="text-ink-muted">Kutish zalida</span>
                <span className="font-numeric font-semibold text-foreground">{counts.checked_in}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-ink-muted">Qabulda (jarayonda)</span>
                <span className="font-numeric font-semibold text-foreground">{counts.in_progress}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-ink-muted">Yakunlangan</span>
                <span className="font-numeric font-semibold text-foreground">{counts.completed}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-ink-muted">Kechikkan qabullar</span>
                <span className={`font-numeric font-semibold ${delayedCount > 0 ? "text-clay-deep" : "text-foreground"}`}>{delayedCount}</span>
              </div>
              <div className="flex items-center justify-between border-t border-hairline pt-2.5">
                <span className="text-ink-muted">Shifokorlar band / bo‘sh</span>
                <span className="font-numeric font-semibold text-foreground">
                  {busyDoctors} / {Math.max(workload.length - busyDoctors, 0)}
                </span>
              </div>
            </div>
          )}
        </Card>

        <Card className="lg:col-span-2">
          <div className="mb-3 flex items-center gap-2">
            <Stethoscope className="h-4 w-4 text-ink-muted" />
            <p className="text-sm font-bold text-foreground">Shifokorlar yuklamasi</p>
          </div>
          {rows === null ? (
            <LoadingRow />
          ) : workload.length === 0 ? (
            <AEmpty title="Bugun shifokorlar band emas" icon={<Stethoscope className="h-5 w-5" />} />
          ) : (
            <div className="space-y-3">
              {workload.map((d) => (
                <div key={d.name} className="flex items-center justify-between gap-2 text-sm">
                  <div className="min-w-0">
                    <p className="truncate font-medium text-foreground">{d.name}</p>
                    <p className="text-xs text-ink-muted">
                      {d.count} ta qabul · {d.completed} ta yakunlangan
                      {d.nextPatient ? ` · Keyingi: ${formatTime(d.nextPatient.time)}` : ""}
                    </p>
                  </div>
                  <ABadge tone={d.busy ? "green" : "gray"}>{d.busy ? "Hozir qabulda" : "Bo‘sh"}</ABadge>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      <AppointmentBoard
        rows={rows}
        busyId={busyId}
        onSetStatus={(id, status) => void setStatus(id, status)}
        onCancel={setCancelTarget}
        onRecordPayment={setPaymentTarget}
        emptyTitle={isToday ? "Bugun qabul rejalashtirilmagan" : "Bu kunga qabul rejalashtirilmagan"}
        emptySubtitle="Yangi qabul qo‘shish uchun yuqoridagi tugmadan foydalaning."
      />

      {modalOpen && (
        <QuickBookingModal
          onClose={() => setModalOpen(false)}
          onCreated={() => {
            setModalOpen(false);
            if (selectedDate) void load(selectedDate);
          }}
          onError={setError}
        />
      )}

      {cancelTarget && (
        <CancelAppointmentModal
          appointmentId={cancelTarget.id}
          patientName={cancelTarget.patients?.full_name ?? "Bemor"}
          onClose={() => setCancelTarget(null)}
          onCancelled={() => {
            setCancelTarget(null);
            if (selectedDate) void load(selectedDate);
          }}
        />
      )}

      {paymentTarget && (
        <RecordPaymentModal
          appointmentId={paymentTarget.id}
          patientName={paymentTarget.patients?.full_name ?? "Bemor"}
          amount={paymentTarget.services?.price}
          onClose={() => setPaymentTarget(null)}
          onRecorded={() => {
            setPaymentTarget(null);
            if (selectedDate) void load(selectedDate);
          }}
        />
      )}
    </div>
  );
}

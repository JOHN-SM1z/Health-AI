"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { UserPlus, CalendarPlus, MessagesSquare, Search, Clock, Send, ListOrdered } from "lucide-react";
import { PageHeader, Card, StatCard, ABadge, AEmpty, AError, AButton, AInput, LoadingRow } from "@/components/admin/ui";
import { adminApi, AdminApiError, formatTime } from "@/lib/admin/client";
import type { DashboardSnapshot, TodayAppointmentRow } from "@/lib/admin/dashboard-types";
import { createClient } from "@/lib/supabase/browser";
import { QuickBookingModal } from "@/components/admin/quick-booking-modal";
import { CancelAppointmentModal } from "@/components/admin/cancel-appointment-modal";
import { RescheduleAppointmentModal } from "@/components/admin/reschedule-appointment-modal";
import { AppointmentBoard } from "@/components/admin/appointment-board";

type Row = TodayAppointmentRow;

type OnlineBooking = {
  id: string;
  start_at: string;
  source: string;
  created_at: string;
  doctor_id: string;
  service_id: string;
  patients: { full_name: string | null; phone: string | null } | null;
  doctors: { name: string } | null;
  services: { name: string } | null;
};

type PatientResult = { id: string; full_name: string | null; phone: string | null; telegram_username: string | null; appointments_count: number };

const SOURCE_LABELS: Record<string, string> = {
  telegram_mini_app: "Mini App",
  telegram_chat: "Telegram bot",
  web: "Veb-sayt",
};

// A patient waiting past this many minutes gets visually flagged — a
// deliberately conservative threshold (small clinics, short queues).
const LONG_WAIT_MINUTES = 15;

function minutesSince(iso: string, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - new Date(iso).getTime()) / 60000));
}

export function ReceptionistDashboard() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [dashboard, setDashboard] = useState<DashboardSnapshot | null>(null);
  const [onlineBookings, setOnlineBookings] = useState<OnlineBooking[] | null>(null);
  const [now, setNow] = useState(() => new Date());
  const [todayLabel, setTodayLabel] = useState("");
  const [modalOpen, setModalOpen] = useState(false);
  const [cancelTarget, setCancelTarget] = useState<{ id: string; patientName: string } | null>(null);
  const [rescheduleTarget, setRescheduleTarget] = useState<OnlineBooking | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<PatientResult[] | null>(null);
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    setTodayLabel(new Date().toLocaleDateString("uz-UZ", { weekday: "long", day: "numeric", month: "long" }));
  }, []);

  const loadOnlineBookings = async () => {
    const supabase = createClient();
    const { data } = await supabase
      .from("appointments")
      .select("id, start_at, source, created_at, doctor_id, service_id, patients(full_name, phone), doctors(name), services(name)")
      .eq("status", "pending")
      .in("source", ["telegram_mini_app", "telegram_chat", "web"])
      .order("created_at", { ascending: false })
      .limit(10);
    setOnlineBookings(data ?? []);
  };

  const load = async () => {
    setNow(new Date());
    let day: { start: string; end: string } | null = null;
    try {
      const d = await adminApi.get<DashboardSnapshot>("/api/admin/dashboard");
      setDashboard(d);
      day = d.day;
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
    await loadOnlineBookings();
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const term = searchQuery.trim();
    if (term.length < 2) {
      setSearchResults(null);
      return;
    }
    setSearching(true);
    const timer = window.setTimeout(() => {
      adminApi
        .get<{ patients: PatientResult[] }>(`/api/admin/patients?q=${encodeURIComponent(term)}`)
        .then((r) => setSearchResults(r.patients))
        .catch(() => setSearchResults([]))
        .finally(() => setSearching(false));
    }, 300);
    return () => window.clearTimeout(timer);
  }, [searchQuery]);

  const counts = useMemo(() => {
    const c: Record<string, number> = { total: 0, pending: 0, confirmed: 0, checked_in: 0, in_progress: 0, completed: 0, cancelled: 0, no_show: 0 };
    for (const r of rows ?? []) {
      c.total += 1;
      c[r.status] = (c[r.status] ?? 0) + 1;
    }
    return c;
  }, [rows]);

  const nextPatient = useMemo(() => {
    if (!rows) return null;
    return rows.find((r) => r.status === "checked_in") ?? rows.find((r) => r.status === "confirmed") ?? rows.find((r) => r.status === "pending") ?? null;
  }, [rows]);

  const waitingQueue = useMemo(() => {
    if (!rows) return [];
    return rows
      .filter((r) => r.status === "checked_in")
      .map((r) => ({ row: r, waitingMinutes: minutesSince(r.start_at, now) }))
      .sort((a, b) => b.waitingMinutes - a.waitingMinutes);
  }, [rows, now]);

  const hasConversationActivity = (dashboard?.active_conversations ?? 0) > 0 || (dashboard?.attention_conversations ?? 0) > 0;

  const setStatus = async (id: string, status: string) => {
    setBusyId(id);
    try {
      await adminApi.patch(`/api/admin/appointments/${id}`, { action: "status", status });
      await load();
    } catch (e) {
      setError(e instanceof AdminApiError ? e.message : "Xatolik yuz berdi");
    } finally {
      setBusyId(null);
    }
  };

  const confirmOnlineBooking = async (booking: OnlineBooking) => {
    setBusyId(booking.id);
    try {
      await adminApi.patch(`/api/admin/appointments/${booking.id}`, { action: "status", status: "confirmed" });
      await loadOnlineBookings();
    } catch (e) {
      setError(e instanceof AdminApiError ? e.message : "Xatolik yuz berdi");
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div>
      <PageHeader
        eyebrow="Health AI — Call Center"
        title="Bugungi qabullar"
        subtitle={todayLabel}
        action={
          <AButton size="md" onClick={() => setModalOpen(true)}>
            <UserPlus className="mr-1.5 h-4 w-4" />
            Yangi qabul
          </AButton>
        }
      />

      {error && <AError message={error} />}

      <div className="mb-6 flex flex-wrap gap-2">
        <AButton size="sm" variant="outline" onClick={() => setModalOpen(true)}>
          <UserPlus className="mr-1.5 h-3.5 w-3.5" />
          Yangi bemor
        </AButton>
        <AButton size="sm" variant="outline" onClick={() => setModalOpen(true)}>
          <CalendarPlus className="mr-1.5 h-3.5 w-3.5" />
          Yangi qabul
        </AButton>
        <Link href="/admin/conversations">
          <AButton size="sm" variant="outline">
            <MessagesSquare className="mr-1.5 h-3.5 w-3.5" />
            Suhbatlar
          </AButton>
        </Link>
        {/* "To'lov" quick action intentionally omitted: recording a payment
            (POST /api/admin/appointments/[id]/payment) is requireRoles("owner","admin")
            only — receptionist isn't authorized to record payments in this
            system today, so no action here could actually do anything. Flagged
            in the PR rather than either building a dead button or silently
            expanding receptionist's payment permission. */}
      </div>

      <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-5">
        <StatCard label="Jami" value={counts.total.toLocaleString("uz-UZ")} tone="neutral" />
        <StatCard label="Kutilmoqda" value={counts.pending.toLocaleString("uz-UZ")} tone="clay" />
        <StatCard label="Tasdiqlangan" value={counts.confirmed.toLocaleString("uz-UZ")} tone="info" />
        <StatCard label="Keldi" value={counts.checked_in.toLocaleString("uz-UZ")} tone="pine" />
        <StatCard label="Jarayonda" value={counts.in_progress.toLocaleString("uz-UZ")} tone="info" />
      </div>

      <div className="mb-6 grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-1">
          <div className="mb-3 flex items-center gap-2">
            <Search className="h-4 w-4 text-ink-muted" />
            <p className="text-sm font-bold text-foreground">Bemor qidirish</p>
          </div>
          <AInput value={searchQuery} onChange={setSearchQuery} placeholder="Ism yoki telefon…" aria-label="Bemor qidirish" />
          {searching && <div className="mt-2"><LoadingRow /></div>}
          {!searching && searchResults !== null && (
            <div className="mt-2 max-h-40 space-y-1 overflow-y-auto">
              {searchResults.length === 0 ? (
                <p className="px-1 py-1.5 text-xs text-ink-muted">Topilmadi</p>
              ) : (
                searchResults.map((p) => (
                  <Link
                    key={p.id}
                    href={`/admin/patients?id=${p.id}`}
                    className="flex items-center justify-between rounded-lg px-2 py-1.5 text-sm hover:bg-sand"
                  >
                    <span className="font-medium text-foreground">{p.full_name || (p.telegram_username ? `@${p.telegram_username}` : "Noma’lum")}</span>
                    <span className="text-xs text-ink-muted">{p.phone ?? "—"}</span>
                  </Link>
                ))
              )}
            </div>
          )}
        </Card>

        <Card className="lg:col-span-1">
          <div className="mb-3 flex items-center gap-2">
            <ListOrdered className="h-4 w-4 text-ink-muted" />
            <p className="text-sm font-bold text-foreground">Keyingi qabul</p>
          </div>
          {rows === null ? (
            <LoadingRow />
          ) : !nextPatient ? (
            <AEmpty title="Navbatda qabul yo‘q" icon={<ListOrdered className="h-5 w-5" />} />
          ) : (
            <div>
              <p className="font-display text-lg font-bold text-foreground">{nextPatient.patients?.full_name ?? "—"}</p>
              <p className="font-numeric mt-0.5 text-sm text-ink-muted">
                {formatTime(nextPatient.start_at)} · {nextPatient.doctors?.name ?? "—"} · {nextPatient.services?.name ?? "—"}
              </p>
              <div className="mt-2">
                <ABadge tone={nextPatient.status === "checked_in" ? "green" : "blue"}>{nextPatient.status === "checked_in" ? "Keldi" : "Tasdiqlangan"}</ABadge>
              </div>
            </div>
          )}
        </Card>

        <Card className="lg:col-span-1">
          <div className="mb-3 flex items-center gap-2">
            <Clock className="h-4 w-4 text-ink-muted" />
            <p className="text-sm font-bold text-foreground">Hozir kutmoqda</p>
          </div>
          {rows === null ? (
            <LoadingRow />
          ) : waitingQueue.length === 0 ? (
            <AEmpty title="Kutish zalida hech kim yo‘q" icon={<Clock className="h-5 w-5" />} />
          ) : (
            <div className="space-y-2.5">
              {waitingQueue.map(({ row, waitingMinutes }) => (
                <div key={row.id} className="flex items-center justify-between text-sm">
                  <div className="min-w-0">
                    <p className="truncate font-medium text-foreground">{row.patients?.full_name ?? "—"}</p>
                    <p className="text-xs text-ink-muted">{row.doctors?.name ?? "—"} · {formatTime(row.start_at)}</p>
                  </div>
                  <span className={`font-numeric shrink-0 text-xs font-semibold ${waitingMinutes >= LONG_WAIT_MINUTES ? "text-danger" : "text-ink-muted"}`}>
                    {waitingMinutes} daq.
                  </span>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      <Card className="mb-6">
        <div className="mb-4 flex items-center gap-2">
          <Send className="h-4 w-4 text-ink-muted" />
          <p className="text-sm font-bold text-foreground">Yangi onlayn qabullar</p>
        </div>
        {onlineBookings === null ? (
          <LoadingRow />
        ) : onlineBookings.length === 0 ? (
          <AEmpty title="Yangi onlayn so‘rovlar yo‘q" icon={<Send className="h-5 w-5" />} />
        ) : (
          <div className="space-y-2.5">
            {onlineBookings.map((b) => (
              <div key={b.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-hairline px-3 py-2.5">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="font-medium text-foreground">{b.patients?.full_name ?? "—"}</p>
                    <ABadge tone="gray">{SOURCE_LABELS[b.source] ?? b.source}</ABadge>
                  </div>
                  <p className="font-numeric text-xs text-ink-muted">
                    {formatTime(b.start_at)} · {b.doctors?.name ?? "—"} · {b.services?.name ?? "—"}
                  </p>
                </div>
                <div className="flex gap-1.5">
                  <AButton size="sm" variant="outline" loading={busyId === b.id} onClick={() => void confirmOnlineBooking(b)}>
                    Tasdiqlash
                  </AButton>
                  <AButton size="sm" variant="ghost" onClick={() => setRescheduleTarget(b)}>
                    O‘zgartirish
                  </AButton>
                  <AButton size="sm" variant="ghost" onClick={() => setCancelTarget({ id: b.id, patientName: b.patients?.full_name ?? "Bemor" })}>
                    Bekor qilish
                  </AButton>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      {hasConversationActivity && (
        <div className="mb-6 grid grid-cols-2 gap-3">
          <Link href="/admin/conversations">
            <StatCard label="Faol suhbatlar" value={(dashboard?.active_conversations ?? 0).toLocaleString("uz-UZ")} tone="info" />
          </Link>
          <Link href="/admin/conversations">
            <StatCard label="Diqqat talab suhbatlar" value={(dashboard?.attention_conversations ?? 0).toLocaleString("uz-UZ")} tone="clay" />
          </Link>
        </div>
      )}

      <AppointmentBoard
        rows={rows}
        busyId={busyId}
        onSetStatus={(id, status) => void setStatus(id, status)}
        onCancel={(row) => setCancelTarget({ id: row.id, patientName: row.patients?.full_name ?? "Bemor" })}
        emptyTitle="Bugun qabul yo‘q"
        emptySubtitle="Yangi qabul yaratish yoki onlayn so‘rovlarni tekshiring."
      />

      {modalOpen && (
        <QuickBookingModal
          onClose={() => setModalOpen(false)}
          onCreated={() => {
            setModalOpen(false);
            void load();
          }}
          onError={setError}
        />
      )}

      {cancelTarget && (
        <CancelAppointmentModal
          appointmentId={cancelTarget.id}
          patientName={cancelTarget.patientName}
          onClose={() => setCancelTarget(null)}
          onCancelled={() => {
            setCancelTarget(null);
            void load();
          }}
        />
      )}

      {rescheduleTarget && (
        <RescheduleAppointmentModal
          appointmentId={rescheduleTarget.id}
          patientName={rescheduleTarget.patients?.full_name ?? "Bemor"}
          serviceId={rescheduleTarget.service_id}
          doctorId={rescheduleTarget.doctor_id}
          currentStartAt={rescheduleTarget.start_at}
          onClose={() => setRescheduleTarget(null)}
          onRescheduled={() => {
            setRescheduleTarget(null);
            void loadOnlineBookings();
          }}
        />
      )}
    </div>
  );
}

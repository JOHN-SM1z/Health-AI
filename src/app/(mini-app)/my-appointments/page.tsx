"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useTelegramInitData } from "@/components/mini-app/telegram-provider";
import { apiGet, apiPost } from "@/lib/client/api";
import { Button, Card, Badge, Spinner, ErrorBanner, SectionTitle, EmptyState } from "@/components/mini-app/ui";
import { CalendarCheck, RefreshCw } from "lucide-react";
import { formatClinicDateTime, isUpcoming, patientStatus } from "@/lib/appointments/patient-view";

type Appointment = {
  id: string;
  start_at: string;
  end_at: string;
  status: string;
  source: string;
  doctors: { name: string; title: string | null } | null;
  services: { name: string; price: number; duration_minutes: number } | null;
  payments: { status: string; amount: number; currency: string } | null;
};

type MyAppointmentsResponse = {
  appointments: Appointment[];
  clinic?: { name: string; timezone: string };
};

/** How often the page re-reads the appointments while it is on screen. */
const REFRESH_MS = 15_000;

export default function MyAppointmentsPage() {
  return (
    <Suspense fallback={<Spinner label="Yuklanmoqda..." />}>
      <MyAppointmentsInner />
    </Suspense>
  );
}

function MyAppointmentsInner() {
  const initData = useTelegramInitData();
  const devMode = process.env.NEXT_PUBLIC_TELEGRAM_DEV_MODE === "true";
  const identity = useMemo(() => initData ?? (devMode ? "dev" : null), [initData, devMode]);
  const searchParams = useSearchParams();

  const [data, setData] = useState<MyAppointmentsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  const [cancelling, setCancelling] = useState<string | null>(null);
  const inFlight = useRef(false);
  const hasData = useRef(false);

  const load = useCallback(
    async (opts: { quiet?: boolean } = {}) => {
      if (!identity) {
        setLoading(false);
        return;
      }
      if (inFlight.current) return;
      inFlight.current = true;
      if (!opts.quiet) setRefreshing(true);
      const res = await apiGet<MyAppointmentsResponse>("/api/me/appointments", identity);
      inFlight.current = false;
      setRefreshing(false);
      setLoading(false);
      if (res.ok) {
        hasData.current = true;
        setData(res.data);
        setError(null);
        setUpdatedAt(new Date());
      } else if (!opts.quiet || !hasData.current) {
        // A failed background refresh keeps showing the last good list.
        setError(res.error);
      }
    },
    [identity],
  );

  // First load, then live updates: every 15 s while the page is visible, and
  // at once when the patient comes back to it (Telegram re-shows the WebView).
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    if (!identity) return;
    const tick = () => {
      if (document.visibilityState === "visible") void load({ quiet: true });
    };
    const timer = window.setInterval(tick, REFRESH_MS);
    document.addEventListener("visibilitychange", tick);
    window.addEventListener("focus", tick);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
      window.removeEventListener("focus", tick);
    };
  }, [identity, load]);

  const cancelAppointment = async (id: string) => {
    if (!identity) return;
    setCancelling(id);
    const res = await apiPost<{ cancelled: boolean }>(
      `/api/bookings/${id}/cancel`,
      { reason: "Bemor tomonidan bekor qilindi" },
      identity,
    );
    setCancelling(null);
    if (res.ok) {
      await load();
      if (searchParams.get("id") === id) window.history.replaceState({}, "", "/my-appointments");
    } else {
      setError(res.error);
    }
  };

  const timeZone = data?.clinic?.timezone ?? "Asia/Tashkent";
  const { upcoming, past } = useMemo(() => {
    const all = data?.appointments ?? [];
    const now = new Date();
    return {
      upcoming: all.filter((a) => isUpcoming(a, now)).sort((a, b) => a.start_at.localeCompare(b.start_at)),
      past: all.filter((a) => !isUpcoming(a, now)).sort((a, b) => b.start_at.localeCompare(a.start_at)),
    };
  }, [data]);

  if (loading) return <Spinner label="Qabullar yuklanmoqda..." />;

  if (!identity) {
    return (
      <div className="flex flex-col gap-3">
        <SectionTitle>Mening qabullarim</SectionTitle>
        <Card>
          <EmptyState
            title="Telegram orqali oching"
            subtitle={
              <>
                Qabullaringizni ko‘rish uchun klinika botidagi <b>“📋 Mening qabullarim”</b> tugmasini bosing — bot qabullaringizni
                ko‘rsatadi va ushbu sahifani to‘g‘ri ochadi.
              </>
            }
            icon={<CalendarCheck className="h-6 w-6" />}
          />
        </Card>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <SectionTitle>Mening qabullarim</SectionTitle>
        <button
          type="button"
          onClick={() => void load()}
          className="flex items-center gap-1.5 text-xs text-[var(--tg-link,var(--pine-deep))]"
          aria-label="Yangilash"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? "animate-spin" : ""}`} />
          {updatedAt ? `Yangilandi ${updatedAt.toLocaleTimeString("uz-UZ", { hour: "2-digit", minute: "2-digit" })}` : "Yangilash"}
        </button>
      </div>
      {error && <ErrorBanner message={error} />}

      <section aria-label="Kelgusi qabullar" className="flex flex-col gap-3">
        <p className="text-xs font-semibold uppercase tracking-wide text-[var(--tg-hint,#8a9699)]">Kelgusi qabullar</p>
        {upcoming.length === 0 ? (
          <Card>
            <EmptyState
              title="Rejalashtirilgan qabul yo‘q"
              subtitle={
                <a href="/book" className="underline">
                  Qabulga yozilish
                </a>
              }
              icon={<CalendarCheck className="h-6 w-6" />}
            />
          </Card>
        ) : (
          upcoming.map((a) => (
            <AppointmentCard key={a.id} a={a} timeZone={timeZone} highlight={a.id === searchParams.get("id")}>
              {["pending", "confirmed"].includes(a.status) && (
                <div className="mt-3">
                  <Button variant="outline" size="sm" loading={cancelling === a.id} onClick={() => cancelAppointment(a.id)}>
                    Bekor qilish
                  </Button>
                </div>
              )}
            </AppointmentCard>
          ))
        )}
      </section>

      {past.length > 0 && (
        <section aria-label="O‘tgan qabullar" className="mt-2 flex flex-col gap-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-[var(--tg-hint,#8a9699)]">O‘tgan qabullar</p>
          {past.slice(0, 10).map((a) => (
            <AppointmentCard key={a.id} a={a} timeZone={timeZone} muted />
          ))}
        </section>
      )}
    </div>
  );
}

function AppointmentCard({
  a,
  timeZone,
  muted,
  highlight,
  children,
}: {
  a: Appointment;
  timeZone: string;
  muted?: boolean;
  highlight?: boolean;
  children?: React.ReactNode;
}) {
  const st = patientStatus(a.status);
  return (
    <Card className={`${muted ? "opacity-75" : ""} ${highlight ? "ring-2 ring-[var(--pine-deep)]" : ""}`}>
      <div className="mb-2 flex items-center justify-between gap-2">
        <Badge tone={st.tone}>{st.label}</Badge>
        <span className="text-xs text-[var(--tg-hint,#8a9699)]">{formatClinicDateTime(a.start_at, timeZone)}</span>
      </div>
      <p className="text-sm font-medium text-[var(--tg-text,var(--foreground))]">{a.doctors?.name ?? "Shifokor"}</p>
      {a.services?.name && <p className="text-xs text-[var(--tg-hint,#8a9699)]">{a.services.name}</p>}
      {!muted && st.hint && <p className="mt-2 text-xs text-[var(--tg-text,var(--foreground))]">{st.hint}</p>}
      {a.payments && (
        <p className="mt-2 text-xs">
          <Badge tone={a.payments.status === "paid" ? "green" : a.payments.status === "cancelled" ? "red" : "amber"}>
            To‘lov: {a.payments.status === "paid" ? "To‘langan" : "To‘lanmagan"}
          </Badge>
        </p>
      )}
      {children}
    </Card>
  );
}

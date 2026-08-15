"use client";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useTelegramInitData } from "@/components/mini-app/telegram-provider";
import { apiGet, apiPost } from "@/lib/client/api";
import { Button, Card, Badge, Spinner, ErrorBanner, SectionTitle } from "@/components/mini-app/ui";

type MyAppointmentsResponse = {
  appointments: Array<{
    id: string;
    start_at: string;
    end_at: string;
    status: string;
    source: string;
    doctors: { name: string; title: string | null } | null;
    services: { name: string; price: number; duration_minutes: number } | null;
    payments: { status: string; amount: number; currency: string } | null;
  }>;
};

const STATUS_LABELS: Record<string, { label: string; tone: "green" | "red" | "amber" | "blue" | "gray" }> = {
  pending: { label: "Kutilmoqda", tone: "amber" },
  confirmed: { label: "Tasdiqlangan", tone: "blue" },
  checked_in: { label: "Keldi", tone: "blue" },
  in_progress: { label: "Qabulda", tone: "blue" },
  completed: { label: "Yakunlangan", tone: "green" },
  cancelled: { label: "Bekor qilingan", tone: "red" },
  no_show: { label: "Kelmagan", tone: "gray" },
};

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
  const [error, setError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!identity) {
      setError("Telegram orqali kirilmagan");
      setLoading(false);
      return;
    }
    const res = await apiGet<MyAppointmentsResponse>("/api/me/appointments", identity);
    if (res.ok) setData(res.data);
    else setError(res.error);
    setLoading(false);
  }, [identity]);

  useEffect(() => {
    void load();
  }, [load]);

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

  if (loading) return <Spinner label="Qabullar yuklanmoqda..." />;
  if (error) return <ErrorBanner message={error} />;
  if (!data) return null;

  return (
    <div className="flex flex-col gap-3">
      <SectionTitle>Mening qabullarim</SectionTitle>
      {data.appointments.length === 0 && (
        <Card className="text-center text-sm text-[var(--tg-hint,#8a9699)]">
          Hozircha qabullar yo‘q.{" "}
          <a href="/book" className="underline">
            Yozilish
          </a>
        </Card>
      )}
      {data.appointments.map((a) => {
        const st = STATUS_LABELS[a.status] ?? { label: a.status, tone: "gray" as const };
        const start = new Date(a.start_at);
        return (
          <Card key={a.id}>
            <div className="mb-2 flex items-center justify-between">
              <Badge tone={st.tone}>{st.label}</Badge>
              <span className="text-xs text-[var(--tg-hint,#8a9699)]">
                {start.toLocaleDateString("uz-UZ", { day: "numeric", month: "long" })},{" "}
                {start.toLocaleTimeString("uz-UZ", { hour: "2-digit", minute: "2-digit" })}
              </span>
            </div>
            <p className="text-sm font-medium text-[var(--tg-text,var(--foreground))]">{a.doctors?.name ?? "Shifokor"}</p>
            <p className="text-xs text-[var(--tg-hint,#8a9699)]">{a.services?.name}</p>
            {a.payments && (
              <p className="mt-2 text-xs">
                <Badge tone={a.payments.status === "paid" ? "green" : a.payments.status === "cancelled" ? "red" : "amber"}>
                  To‘lov: {a.payments.status === "paid" ? "To‘langan" : "To‘lanmagan"}
                </Badge>
              </p>
            )}
            {["pending", "confirmed"].includes(a.status) && (
              <div className="mt-3">
                <Button
                  variant="outline"
                  size="sm"
                  loading={cancelling === a.id}
                  onClick={() => cancelAppointment(a.id)}
                >
                  Bekor qilish
                </Button>
              </div>
            )}
          </Card>
        );
      })}
    </div>
  );
}
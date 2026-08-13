"use client";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useTelegramInitData } from "@/components/mini-app/telegram-provider";
import { apiGet } from "@/lib/client/api";
import { Button, Card, Spinner, ErrorBanner, Badge } from "@/components/mini-app/ui";

type MyAppointmentsResponse = {
  appointments: Array<{
    id: string;
    start_at: string;
    status: string;
    doctors: { name: string; title: string | null } | null;
    services: { name: string; price: number } | null;
    payments: { status: string; amount: number; currency: string } | null;
  }>;
};

/**
 * Truthful confirmation page: the appointment id comes from the server
 * response at booking time and is re-fetched here from the patient's own
 * appointments. Nothing is claimed unless the server confirms it.
 */
export default function ConfirmationPage() {
  return (
    <Suspense fallback={<Spinner label="Tasdiq tekshirilmoqda..." />}>
      <ConfirmationInner />
    </Suspense>
  );
}

function ConfirmationInner() {
  const initData = useTelegramInitData();
  const devMode = process.env.NEXT_PUBLIC_TELEGRAM_DEV_MODE === "true";
  const identity = useMemo(() => initData ?? (devMode ? "dev" : null), [initData, devMode]);
  const searchParams = useSearchParams();
  const appointmentId = searchParams.get("id");

  const [appointment, setAppointment] = useState<MyAppointmentsResponse["appointments"][number] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!identity || !appointmentId) {
      setError("Qabul identifikatori topilmadi");
      setLoading(false);
      return;
    }
    const res = await apiGet<MyAppointmentsResponse>("/api/me/appointments", identity);
    if (res.ok) {
      const found = res.data.appointments.find((a) => a.id === appointmentId);
      if (found) setAppointment(found);
      else setError("Qabul topilmadi");
    } else {
      setError(res.error);
    }
    setLoading(false);
  }, [identity, appointmentId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) return <Spinner label="Tasdiq tekshirilmoqda..." />;
  if (error) return <ErrorBanner message={error} />;
  if (!appointment) return null;

  const start = new Date(appointment.start_at);

  return (
    <div className="flex flex-col gap-4">
      <Card className="text-center">
        <div className="mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-full bg-green-100 text-2xl">✅</div>
        <p className="font-medium text-[var(--tg-text,#0f172a)]">Qabul tasdiqlandi!</p>
        <p className="mt-1 text-xs text-[var(--tg-hint,#64748b)]">
          Sizga Telegram bot orqali tasdiq va eslatmalar keladi.
        </p>
      </Card>

      <Card className="flex flex-col gap-2 text-sm">
        <p className="font-medium text-[var(--tg-text,#0f172a)]">{appointment.doctors?.name}</p>
        {appointment.doctors?.title && <p className="text-xs text-[var(--tg-hint,#64748b)]">{appointment.doctors.title}</p>}
        <div className="mt-1 flex items-center justify-between">
          <span className="text-[var(--tg-hint,#64748b)]">Sana va vaqt</span>
          <span className="font-medium">
            {start.toLocaleDateString("uz-UZ", { day: "numeric", month: "long" })},{" "}
            {start.toLocaleTimeString("uz-UZ", { hour: "2-digit", minute: "2-digit" })}
          </span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-[var(--tg-hint,#64748b)]">Xizmat</span>
          <span className="font-medium">{appointment.services?.name}</span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-[var(--tg-hint,#64748b)]">To‘lov</span>
          <Badge tone={appointment.payments?.status === "paid" ? "green" : "amber"}>
            {appointment.payments?.status === "paid" ? "To‘langan" : "Qabulxonada to‘lanadi"}
          </Badge>
        </div>
      </Card>

      <a href="/my-appointments">
        <Button size="full" variant="outline">
          Mening qabullarim
        </Button>
      </a>
    </div>
  );
}
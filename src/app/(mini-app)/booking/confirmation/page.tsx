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
    payments: { status: string; amount: number; currency: string; payment_url?: string | null } | null;
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
  const paymentMode = process.env.NEXT_PUBLIC_PAYMENT_PROVIDER ?? "manual";
  const searchParams = useSearchParams();
  const appointmentId = searchParams.get("id");

  const [appointment, setAppointment] = useState<MyAppointmentsResponse["appointments"][number] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Without a Telegram identity (walk-in booking outside the Mini App) the
  // appointment cannot be fetched from /api/me/appointments. The server
  // already confirmed the booking and returned its summary at creation time;
  // that payload is cached in this tab's sessionStorage and rendered here.
  const cached = useMemo(() => {
    if (!appointmentId || typeof window === "undefined") return null;
    try {
      const raw = sessionStorage.getItem(`booking:${appointmentId}`);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as {
        appointment: MyAppointmentsResponse["appointments"][number];
        paymentUrl?: string | null;
      };
      return parsed;
    } catch {
      return null;
    }
  }, [appointmentId]);

  const load = useCallback(async () => {
    if (!appointmentId) {
      setError("Qabul identifikatori topilmadi");
      setLoading(false);
      return;
    }
    if (!identity) {
      if (cached?.appointment) {
        setAppointment(cached.appointment);
        setLoading(false);
        return;
      }
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
  }, [identity, appointmentId, cached]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) return <Spinner label="Tasdiq tekshirilmoqda..." />;
  if (error) return <ErrorBanner message={error} />;
  if (!appointment) return null;

  const start = new Date(appointment.start_at);
  const paymentUrl = cached?.paymentUrl ?? appointment.payments?.payment_url ?? null;

  return (
    <div className="flex flex-col gap-4">
      <Card className="text-center">
        <div className="mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-full bg-pine-tint text-2xl">✅</div>
        <p className="font-medium text-[var(--tg-text,var(--foreground))]">Qabul tasdiqlandi!</p>
        <p className="mt-1 text-xs text-[var(--tg-hint,#8a9699)]">
          {identity
            ? "Sizga Telegram bot orqali tasdiq va eslatmalar keladi."
            : "Tasdiqlangan qabul: " + appointmentId}
        </p>
      </Card>

      <Card className="flex flex-col gap-2 text-sm">
        <p className="font-medium text-[var(--tg-text,var(--foreground))]">{appointment.doctors?.name}</p>
        {appointment.doctors?.title && <p className="text-xs text-[var(--tg-hint,#8a9699)]">{appointment.doctors.title}</p>}
        <div className="mt-1 flex items-center justify-between">
          <span className="text-[var(--tg-hint,#8a9699)]">Sana va vaqt</span>
          <span className="font-medium">
            {start.toLocaleDateString("uz-UZ", { day: "numeric", month: "long" })},{" "}
            {start.toLocaleTimeString("uz-UZ", { hour: "2-digit", minute: "2-digit" })}
          </span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-[var(--tg-hint,#8a9699)]">Xizmat</span>
          <span className="font-medium">{appointment.services?.name}</span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-[var(--tg-hint,#8a9699)]">To‘lov</span>
          <Badge tone={appointment.payments?.status === "paid" ? "green" : appointment.payments?.status === "pending" ? "amber" : "amber"}>
            {appointment.payments?.status === "paid"
              ? "To‘langan"
              : appointment.payments?.status === "pending"
                ? "To‘lov kutilmoqda"
                : paymentMode === "manual"
                  ? "Qabulxonada to‘lanadi"
                  : "To‘lov amalga oshirilmagan"}
          </Badge>
        </div>
      </Card>

      {appointment.payments && appointment.payments.status !== "paid" && paymentUrl && (
        <a href={paymentUrl} target="_blank" rel="noopener noreferrer" className="block w-full">
          <Button size="full">To‘lov qilish (Click)</Button>
        </a>
      )}

      <a href="/my-appointments">
        <Button size="full" variant="outline">
          Mening qabullarim
        </Button>
      </a>
    </div>
  );
}
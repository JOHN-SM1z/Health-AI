"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { CreditCard, Ticket } from "lucide-react";
import { Button, ErrorBanner, Spinner } from "@/components/mini-app/ui";
import { apiPost } from "@/lib/client/api";

type Status = { paymentStatus: string; onlineAvailable: boolean; queueNumber: number | null; queueDate: string | null; visitStatus: string | null };

/**
 * Pay online, get the queue number online (Slice C). Shows only what the SERVER has verified: "paid" and the number
 * appear after the provider's signed webhook settled the payment — never because the patient came back from the
 * payment page. Without an online provider the patient is told to pay at the kassa.
 */
export function OnlinePayment({ identity, appointmentId }: { identity: string | null; appointmentId: string }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [waiting, setWaiting] = useState(false);
  const [busy, setBusy] = useState(false);
  const polls = useRef(0);

  const refresh = useCallback(async () => {
    const res = await apiPost<Status>("/api/me/payments/status", { appointmentId }, identity);
    if (res.ok) setStatus(res.data);
    return res.ok ? res.data : null;
  }, [appointmentId, identity]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // After the patient opened the payment page: ask the server until the payment is settled (up to ~3 minutes).
  useEffect(() => {
    if (!waiting) return;
    const run = ++polls.current;
    let tries = 0;
    const tick = async () => {
      if (run !== polls.current) return;
      const s = await refresh();
      tries++;
      if (s && (s.paymentStatus === "paid" || s.queueNumber !== null)) return setWaiting(false);
      if (tries < 60) setTimeout(tick, 3000);
      else setWaiting(false);
    };
    const t = setTimeout(tick, 1500);
    return () => clearTimeout(t);
  }, [waiting, refresh]);

  const pay = async () => {
    setBusy(true);
    setError(null);
    const res = await apiPost<{ payUrl: string }>("/api/me/payments/invoice", { appointmentId }, identity);
    setBusy(false);
    if (!res.ok) return setError(res.error);
    setWaiting(true);
    const url = res.data.payUrl;
    if (url.startsWith("/")) {
      window.open(url, "_blank", "noopener");
      return;
    }
    try {
      const sdk = await import("@tma.js/sdk");
      const open = sdk.openLink as unknown as { (u: string): void; isAvailable?: () => boolean };
      if (open.isAvailable && !open.isAvailable()) throw new Error("unavailable");
      open(url);
    } catch {
      window.open(url, "_blank", "noopener");
    }
  };

  if (!status) return <Spinner label="To‘lov holati…" />;

  if (status.queueNumber !== null && status.paymentStatus === "paid") {
    return (
      <div className="rounded-xl border border-[var(--pine)] p-4 text-center" data-testid="online-queue-number">
        <Ticket className="mx-auto mb-1 h-5 w-5" aria-hidden />
        <p className="text-xs text-[var(--tg-hint,#8a9699)]">To‘lov qabul qilindi. Navbat raqamingiz</p>
        <p className="font-display text-4xl font-bold">{status.queueNumber}</p>
        <p className="mt-1 text-xs text-[var(--tg-hint,#8a9699)]">
          {status.visitStatus === "booked" ? "Klinikaga kelganingizda qabulxonaga ayting — shifokor sizni yozilgan vaqtingizda qabul qiladi." : "Navbatdasiz."}
        </p>
      </div>
    );
  }
  if (status.paymentStatus === "paid") return <p className="text-sm">To‘lov qabul qilindi.</p>;
  if (status.paymentStatus === "manual_review") return <p className="text-sm">To‘lov tekshirilmoqda — klinika siz bilan bog‘lanadi.</p>;
  if (!status.onlineAvailable) return <p className="text-xs text-[var(--tg-hint,#8a9699)]">To‘lov klinikaning kassasida qabul qilinadi. Navbat raqami to‘lovdan so‘ng beriladi.</p>;

  return (
    <div className="flex flex-col gap-2">
      {error && <ErrorBanner message={error} />}
      {waiting ? (
        <Spinner label="To‘lov kutilmoqda… (to‘lovni tugatib, shu yerga qayting)" />
      ) : (
        <Button size="full" loading={busy} onClick={pay}>
          <CreditCard className="h-4 w-4" aria-hidden /> Onlayn to‘lash va navbat olish
        </Button>
      )}
      {waiting && (
        <Button variant="ghost" size="full" onClick={() => void refresh()}>
          Holatni yangilash
        </Button>
      )}
    </div>
  );
}

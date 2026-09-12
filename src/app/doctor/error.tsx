"use client";

import { useEffect } from "react";
import { HeartPulse } from "lucide-react";
import { AButton, AError, Card } from "@/components/admin/ui";

/**
 * Catches uncaught errors anywhere under /doctor — including a thrown
 * getStaffContext() (e.g. Supabase unreachable) in doctor/layout.tsx itself,
 * which would otherwise fall through to Next.js's generic error page. Never
 * renders the raw error message: it may carry internal details, and the
 * server-side log (via `logger`, in whichever data call actually threw) is
 * the durable diagnostic record.
 */
export default function DoctorError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("doctor route error", error);
  }, [error]);

  return (
    <div className="flex min-h-dvh flex-col items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <div className="brand-tile mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-2xl text-white">
            <HeartPulse className="h-7 w-7" />
          </div>
          <h1 className="font-display mt-2 text-xl font-bold tracking-tight text-foreground">
            Sahifani yuklab bo‘lmadi
          </h1>
        </div>
        <Card className="flex flex-col gap-3 p-6">
          <AError message="Kutilmagan xatolik yuz berdi. Internet aloqasini tekshiring va qayta urinib ko‘ring." />
          <AButton size="lg" onClick={reset}>
            Qayta urinish
          </AButton>
          <a href="/doctor" className="text-center text-sm text-pine-deep hover:underline">
            Bosh sahifaga qaytish
          </a>
        </Card>
      </div>
    </div>
  );
}

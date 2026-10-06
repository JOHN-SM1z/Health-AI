"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useTelegramInitData } from "@/components/mini-app/telegram-provider";
import { apiGet } from "@/lib/client/api";
import { Badge, Card, EmptyState, ErrorBanner, SectionTitle, Spinner } from "@/components/mini-app/ui";
import { FlaskConical } from "lucide-react";
import { formatDay } from "@/lib/labs/format-day";

/**
 * The patient's own verified laboratory results (Phase 12). Identity is the
 * verified Telegram initData; the list shows names and dates only — values
 * open on the result page, which is audited.
 */

type Summary = { itemId: string; testName: string; date: string; corrected: boolean; outsideRange: number };

export default function LabResultsPage() {
  return (
    <Suspense fallback={<Spinner label="Yuklanmoqda..." />}>
      <LabResultsInner />
    </Suspense>
  );
}

function LabResultsInner() {
  const initData = useTelegramInitData();
  const devMode = process.env.NEXT_PUBLIC_TELEGRAM_DEV_MODE === "true";
  const identity = useMemo(() => initData ?? (devMode ? "dev" : null), [initData, devMode]);
  const [data, setData] = useState<{ released: boolean; results: Summary[] } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!identity) return;
    void apiGet<{ released: boolean; results: Summary[] }>("/api/me/lab-results", identity).then((res) => {
      if (res.ok) setData(res.data);
      else setError(res.error);
    });
  }, [identity]);

  if (!identity) {
    return (
      <Card>
        <EmptyState title="Tahlil natijalari" subtitle="Natijalaringizni ko‘rish uchun ilovani klinikaning Telegram boti orqali oching." icon={<FlaskConical className="h-6 w-6" />} />
      </Card>
    );
  }
  if (error) return <ErrorBanner message={error} />;
  if (!data) return <Spinner label="Natijalar yuklanmoqda..." />;

  return (
    <div className="flex flex-col gap-3">
      <SectionTitle>Tahlil natijalari</SectionTitle>
      {!data.released || data.results.length === 0 ? (
        <Card>
          <EmptyState
            title={data.released ? "Hozircha tayyor natija yo‘q" : "Natijalar klinikada beriladi"}
            subtitle={data.released ? "Natija tayyor bo‘lganda Telegram orqali xabar beramiz." : "Natijalaringizni klinikadan oling."}
            icon={<FlaskConical className="h-6 w-6" />}
          />
        </Card>
      ) : (
        data.results.map((r) => (
          <Link key={r.itemId} href={`/lab-results/${r.itemId}`} aria-label={`${r.testName} natijasi`}>
            <Card className="card-hover">
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm font-medium text-[var(--tg-text,var(--foreground))]">{r.testName}</p>
                <span className="text-xs text-[var(--tg-hint,#8a9699)]">{formatDay(r.date)}</span>
              </div>
              <div className="mt-2 flex flex-wrap gap-1">
                {r.corrected && <Badge tone="blue">Yangilangan</Badge>}
                {r.outsideRange > 0 ? <Badge tone="amber">{r.outsideRange} ta ko‘rsatkich me’yordan tashqarida</Badge> : <Badge tone="green">Ko‘rish</Badge>}
              </div>
            </Card>
          </Link>
        ))
      )}
      <p className="text-center text-xs leading-relaxed text-[var(--tg-hint,#8a9699)]">
        Bu ilova tashxis qo‘ymaydi. Natijalaringiz bo‘yicha shifokoringiz bilan maslahatlashing.
      </p>
    </div>
  );
}

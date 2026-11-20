"use client";

import { Suspense, use, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useTelegramInitData } from "@/components/mini-app/telegram-provider";
import { apiGet } from "@/lib/client/api";
import { Badge, Button, Card, EmptyState, ErrorBanner, SectionTitle, Spinner } from "@/components/mini-app/ui";
import { LAB_FLAG_LABELS } from "@/lib/labs/flag-labels";
import { formatRange } from "@/lib/labs/values";
import { FileDown, FlaskConical } from "lucide-react";
import { formatDay } from "@/lib/labs/format-day";

/**
 * One of the patient's own verified results (Phase 12): each value with its
 * unit, the clinic's configured range and where the value sits against it —
 * never an interpretation — and the result's documents (60-second links).
 */

type Detail = {
  itemId: string;
  testName: string;
  date: string;
  verifiedAt: string;
  corrected: boolean;
  values: Array<{ parameter: string; value: string; unit: string | null; rangeLow: number | null; rangeHigh: number | null; rangeText: string | null; flag: string }>;
  documents: Array<{ id: string; kind: string; mimeType: string; sizeBytes: number }>;
};

const KIND: Record<string, string> = { report: "Hisobot", scan: "Skan", image: "Rasm", import_source: "Hujjat" };

export default function LabResultPage({ params }: { params: Promise<{ itemId: string }> }) {
  const { itemId } = use(params);
  return (
    <Suspense fallback={<Spinner label="Yuklanmoqda..." />}>
      <LabResultInner itemId={itemId} />
    </Suspense>
  );
}

function LabResultInner({ itemId }: { itemId: string }) {
  const initData = useTelegramInitData();
  const devMode = process.env.NEXT_PUBLIC_TELEGRAM_DEV_MODE === "true";
  const identity = useMemo(() => initData ?? (devMode ? "dev" : null), [initData, devMode]);
  const [result, setResult] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [opening, setOpening] = useState<string | null>(null);

  useEffect(() => {
    if (!identity) return;
    void apiGet<{ result: Detail }>(`/api/me/lab-results/${encodeURIComponent(itemId)}`, identity).then((res) => {
      if (res.ok) setResult(res.data.result);
      else setError(res.error);
    });
  }, [identity, itemId]);

  const download = async (id: string) => {
    if (!identity) return;
    setOpening(id);
    const res = await apiGet<{ url: string }>(`/api/me/lab-documents/${id}`, identity);
    setOpening(null);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    // Inside Telegram, open through the Mini App API; elsewhere, navigate.
    const tg = (window as unknown as { Telegram?: { WebApp?: { openLink?: (url: string) => void } } }).Telegram?.WebApp;
    if (tg?.openLink) tg.openLink(res.data.url);
    else window.location.assign(res.data.url);
  };

  if (!identity) {
    return (
      <Card>
        <EmptyState title="Tahlil natijasi" subtitle="Natijani ko‘rish uchun ilovani klinikaning Telegram boti orqali oching." icon={<FlaskConical className="h-6 w-6" />} />
      </Card>
    );
  }
  if (error) {
    return (
      <div className="flex flex-col gap-3">
        <ErrorBanner message={error} />
        <Link href="/lab-results" className="text-sm underline">Barcha natijalar</Link>
      </div>
    );
  }
  if (!result) return <Spinner label="Natija yuklanmoqda..." />;

  return (
    <div className="flex flex-col gap-3">
      <SectionTitle>{result.testName}</SectionTitle>
      <p className="text-xs text-[var(--tg-hint,#8a9699)]">
        Sana: {formatDay(result.date)}
        {result.corrected && " · natija laboratoriya tomonidan yangilangan"}
      </p>
      <Card>
        <ul className="flex flex-col divide-y divide-[var(--hairline)]" aria-label="Ko‘rsatkichlar">
          {result.values.map((v) => {
            const flag = LAB_FLAG_LABELS[v.flag] ?? { label: v.flag, tone: "gray" as const };
            const range = formatRange({ low: v.rangeLow, high: v.rangeHigh, text: v.rangeText });
            return (
              <li key={v.parameter} className="flex items-start justify-between gap-3 py-2.5">
                <div>
                  <p className="text-sm font-medium text-[var(--tg-text,var(--foreground))]">{v.parameter}</p>
                  <p className="text-xs text-[var(--tg-hint,#8a9699)]">{range ? `Me’yor: ${range}${v.unit ? ` ${v.unit}` : ""}` : "Me’yor sozlanmagan"}</p>
                </div>
                <div className="text-right">
                  <p className="font-numeric text-sm font-semibold text-[var(--tg-text,var(--foreground))]">
                    {v.value}
                    {v.unit ? ` ${v.unit}` : ""}
                  </p>
                  <Badge tone={flag.tone === "gray" ? "gray" : flag.tone}>{flag.label}</Badge>
                </div>
              </li>
            );
          })}
        </ul>
      </Card>
      {result.documents.length > 0 && (
        <Card>
          <p className="mb-2 text-sm font-medium text-[var(--tg-text,var(--foreground))]">Hujjatlar</p>
          <div className="flex flex-col gap-2">
            {result.documents.map((d) => (
              <Button key={d.id} variant="outline" size="full" loading={opening === d.id} onClick={() => void download(d.id)}>
                <FileDown className="h-4 w-4" /> {KIND[d.kind] ?? "Hujjat"} ({Math.max(1, Math.round(d.sizeBytes / 1024))} KB)
              </Button>
            ))}
          </div>
        </Card>
      )}
      <p className="text-xs leading-relaxed text-[var(--tg-hint,#8a9699)]">
        Belgilar qiymatning klinikada belgilangan me’yorga nisbatan joylashuvini ko‘rsatadi — bu tashxis emas. Natijani shifokoringiz bilan muhokama qiling.
      </p>
      <Link href="/lab-results" className="text-center text-sm underline">Barcha natijalar</Link>
    </div>
  );
}

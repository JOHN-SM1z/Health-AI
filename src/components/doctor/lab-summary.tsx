"use client";

import { useEffect, useState } from "react";
import { Sparkles, ListChecks } from "lucide-react";
import { ABadge, AButton, AEmpty, AError } from "@/components/admin/ui";
import { adminApi, AdminApiError } from "@/lib/admin/client";

/**
 * The doctor's laboratory summary (Phase 18): recorded values, trends,
 * repeated tests and tests still pending — an aid for preparing a
 * consultation, never a conclusion. It states where its text came from
 * (AI rewording that passed the checks, or computed) and that the decision
 * is the doctor's.
 */

type Summary = {
  bullets: Array<{ id: string; kind: "parameter" | "comparable" | "pending" | "notice"; severity: "critical" | "abnormal" | "info"; text: string }>;
  source: "ai" | "computed";
  aiStatus: "used" | "disabled" | "not_enabled_for_clinic" | "not_needed" | "unavailable" | "rejected";
  basis: { results: number; from: string | null; to: string | null; windowDays: number; nonNumericValues: number };
  generatedAt: string;
};

const SECTIONS: Array<{ kind: Summary["bullets"][number]["kind"]; title: string }> = [
  { kind: "parameter", title: "Qiymatlar va dinamika" },
  { kind: "comparable", title: "Taqqoslanadigan tahlillar" },
  { kind: "pending", title: "Kutilayotgan natijalar" },
  { kind: "notice", title: "Eslatma" },
];

const SOURCE_NOTE: Record<Summary["aiStatus"], string> = {
  used: "AI tomonidan qayta yozilgan; har bir raqam tasdiqlangan qiymatlar bilan tekshirilgan.",
  disabled: "AI o‘chirilgan — xulosa tasdiqlangan qiymatlardan avtomatik tuzilgan.",
  not_enabled_for_clinic: "Klinikada AI xulosasi yoqilmagan — xulosa tasdiqlangan qiymatlardan avtomatik tuzilgan.",
  not_needed: "Xulosa tasdiqlangan qiymatlardan avtomatik tuzilgan.",
  unavailable: "AI hozir javob bermadi — xulosa tasdiqlangan qiymatlardan avtomatik tuzilgan.",
  rejected: "AI javobi tekshiruvdan o‘tmadi va ko‘rsatilmadi — xulosa tasdiqlangan qiymatlardan avtomatik tuzilgan.",
};

export function LabSummaryPanel({ patientId }: { patientId: string }) {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    adminApi
      .get<{ summary: Summary }>(`/api/doctor/patients/${patientId}/lab-summary`)
      .then((res) => !cancelled && setSummary(res.summary))
      .catch((e) => !cancelled && setError(e instanceof AdminApiError ? e.message : "Laboratoriya xulosasini yuklab bo‘lmadi"));
    return () => {
      cancelled = true;
    };
  }, [patientId, tick]);

  if (error) return <AError message={error} />;
  if (!summary) {
    return (
      <div className="space-y-2 py-3" role="status" aria-label="Xulosa tayyorlanmoqda">
        <div className="h-2 w-full animate-pulse rounded bg-hairline" />
        <div className="h-2 w-2/3 animate-pulse rounded bg-hairline/70" />
      </div>
    );
  }

  return (
    <section className="flex flex-col gap-3" aria-label="Natijalar xulosasi">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          {summary.source === "ai" ? <Sparkles className="h-4 w-4 text-pine" /> : <ListChecks className="h-4 w-4 text-ink-muted" />}
          <ABadge tone={summary.source === "ai" ? "purple" : "gray"}>{summary.source === "ai" ? "AI yordamchi xulosasi" : "Avtomatik xulosa"}</ABadge>
        </div>
        <AButton
          variant="ghost"
          onClick={() => {
            setSummary(null);
            setTick((t) => t + 1);
          }}
        >
          Yangilash
        </AButton>
      </div>

      {summary.bullets.length === 0 ? (
        <AEmpty title="Xulosa uchun ma’lumot yetarli emas" />
      ) : (
        SECTIONS.map(({ kind, title }) => {
          const items = summary.bullets.filter((b) => b.kind === kind);
          if (items.length === 0) return null;
          return (
            <div key={kind}>
              <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-muted">{title}</p>
              <ul className="space-y-1.5" aria-label={title}>
                {items.map((b) => (
                  <li key={b.id} className="flex items-start gap-2 text-sm text-foreground">
                    <span
                      aria-hidden
                      className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${b.severity === "critical" ? "bg-danger" : b.severity === "abnormal" ? "bg-clay" : "bg-hairline"}`}
                    />
                    <span>{b.text}</span>
                  </li>
                ))}
              </ul>
            </div>
          );
        })
      )}

      <div className="rounded-xl bg-sand px-3 py-2 text-xs text-ink-muted">
        <p>{SOURCE_NOTE[summary.aiStatus]}</p>
        <p className="mt-1">
          Bu yordamchi xulosa: faqat tasdiqlangan laboratoriya qiymatlarini jamlaydi va sozlangan me’yor bilan solishtiradi. Tashxis, davolash yoki tavsiya emas — qaror
          davolovchi shifokorniki. Asos: {summary.basis.results} ta tasdiqlangan natija (oxirgi {Math.round(summary.basis.windowDays / 365)} yil).
        </p>
      </div>
    </section>
  );
}

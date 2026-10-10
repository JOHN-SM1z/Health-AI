"use client";

import { useEffect, useMemo, useState } from "react";
import { ABadge, AButton, AEmpty, AError } from "@/components/admin/ui";
import { adminApi, AdminApiError, formatDateTime } from "@/lib/admin/client";
import { LAB_FLAG, LabOrdersSection } from "@/components/doctor/lab-orders";
import { LabSummaryPanel } from "@/components/doctor/lab-summary";
import { formatRange } from "@/lib/labs/values";
import { buildSeries, type Series } from "@/lib/labs/trends";
import { FlaskConical, LineChart, Paperclip } from "lucide-react";

/**
 * The laboratory part of the patient's longitudinal record (Phase 10):
 * orders (Phase 5), every verified result of the patient with its dates,
 * source and attachments, and the trend of each numeric parameter over time.
 * Read-only: results belong to the laboratory that verified them; a doctor
 * records their own view in their clinical record. Values are placed against
 * the range configured when they were recorded — never interpreted.
 */

type Value = {
  parameterCode: string;
  parameter: string;
  order: number;
  numeric: number | null;
  display: string;
  unit: string | null;
  flag: string;
  rangeLow: number | null;
  rangeHigh: number | null;
  rangeText: string | null;
};
type Result = {
  resultId: string;
  itemId: string;
  testCode: string;
  testName: string;
  source: string;
  orderSource: string;
  orderedAt: string;
  orderedByName: string | null;
  collectedAt: string | null;
  performedAt: string | null;
  verifiedAt: string;
  verifiedByName: string | null;
  version: number;
  correctionReason: string | null;
  labComment: string | null;
  values: Value[];
  documents: Array<{ id: string; kind: string; mimeType: string; sizeBytes: number; createdAt: string }>;
};

const SOURCE: Record<string, string> = { manual: "Klinika laboratoriyasi", import: "Import qilingan", external: "Tashqi laboratoriya" };
const DOC_KIND: Record<string, string> = { report: "Hisobot", scan: "Skan", image: "Rasm", import_source: "Manba fayl" };
const errorText = (e: unknown, fallback: string) => (e instanceof AdminApiError ? e.message : fallback);
const formatDate = (iso: string) => new Date(iso).toLocaleDateString("uz-UZ", { day: "2-digit", month: "2-digit", year: "numeric" });

type Tab = "orders" | "results" | "trends" | "summary";

export function LabWorkspace({ patientId, appointmentId }: { patientId: string; appointmentId: string | null }) {
  const [tab, setTab] = useState<Tab>("orders");
  const [results, setResults] = useState<Result[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Results are read (and audited) only when the doctor opens them.
  useEffect(() => {
    if (tab === "orders" || tab === "summary" || results !== null) return;
    adminApi
      .get<{ results: Result[] }>(`/api/doctor/patients/${patientId}/lab-history`)
      .then((res) => setResults(res.results))
      .catch((e) => setError(errorText(e, "Laboratoriya natijalarini yuklab bo‘lmadi")));
  }, [tab, results, patientId]);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-1" role="tablist" aria-label="Laboratoriya bo‘limlari">
        {([
          ["orders", "Buyurtmalar"],
          ["results", "Natijalar tarixi"],
          ["trends", "Dinamika"],
          ["summary", "Xulosa"],
        ] as const).map(([value, label]) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={tab === value}
            onClick={() => setTab(value)}
            className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${tab === value ? "bg-pine text-white" : "border border-hairline bg-surface text-foreground hover:bg-sand"}`}
          >
            {label}
          </button>
        ))}
      </div>
      {tab === "orders" && <LabOrdersSection patientId={patientId} appointmentId={appointmentId} />}
      {tab === "summary" && <LabSummaryPanel patientId={patientId} />}
      {(tab === "results" || tab === "trends") && error && <AError message={error} />}
      {(tab === "results" || tab === "trends") && !error && results === null && <div className="h-2 w-full animate-pulse rounded bg-hairline" />}
      {tab === "results" && results && <ResultsHistory patientId={patientId} results={results} />}
      {tab === "trends" && results && <Trends results={results} />}
    </div>
  );
}

function ResultsHistory({ patientId, results }: { patientId: string; results: Result[] }) {
  const [open, setOpen] = useState<string | null>(results[0]?.resultId ?? null);
  const [docError, setDocError] = useState<string | null>(null);

  if (results.length === 0) {
    return <AEmpty title="Tasdiqlangan natijalar yo‘q" subtitle="Natija laboratoriyada tasdiqlangandan keyin shu yerda ko‘rinadi" icon={<FlaskConical className="h-6 w-6" />} />;
  }

  // The tab is opened synchronously in the click (browsers block a window
  // opened after an await), then pointed at the short-lived signed link.
  const openDocument = async (id: string) => {
    setDocError(null);
    const tab = window.open("about:blank", "_blank");
    if (tab) tab.opener = null;
    try {
      const res = await adminApi.get<{ url: string }>(`/api/doctor/patients/${patientId}/lab-documents/${id}`);
      if (tab) tab.location.href = res.url;
      else window.location.assign(res.url);
    } catch (e) {
      tab?.close();
      setDocError(errorText(e, "Hujjatni ochib bo‘lmadi"));
    }
  };

  return (
    <div className="flex flex-col gap-2">
      {docError && <AError message={docError} />}
      <ul className="flex flex-col gap-2" aria-label="Natijalar tarixi">
        {results.map((r) => {
          const outside = r.values.filter((v) => v.flag !== "normal" && v.flag !== "not_evaluated").length;
          const expanded = open === r.resultId;
          return (
            <li key={r.resultId} className="rounded-xl border border-hairline">
              <button
                type="button"
                className="flex w-full flex-wrap items-center justify-between gap-2 px-3 py-2 text-left"
                aria-expanded={expanded}
                onClick={() => setOpen(expanded ? null : r.resultId)}
              >
                <span>
                  <span className="text-sm font-medium text-foreground">{r.testName}</span>
                  <span className="block text-xs text-ink-muted">
                    {r.performedAt ? `Bajarilgan ${formatDate(r.performedAt)}` : r.collectedAt ? `Namuna olingan ${formatDate(r.collectedAt)}` : `Tasdiqlangan ${formatDate(r.verifiedAt)}`}
                  </span>
                </span>
                <span className="flex flex-wrap items-center gap-1">
                  {r.version > 1 && <ABadge tone="purple">Tuzatilgan ({r.version}-versiya)</ABadge>}
                  {outside > 0 && <ABadge tone="amber">{outside} ta ko‘rsatkich me’yordan tashqarida</ABadge>}
                  {r.documents.length > 0 && <Paperclip className="h-4 w-4 text-ink-muted" aria-label="Ilova bor" />}
                </span>
              </button>
              {expanded && (
                <div className="flex flex-col gap-2 border-t border-hairline px-3 py-2 text-sm">
                  <dl className="grid grid-cols-1 gap-x-4 gap-y-0.5 text-xs text-ink-muted sm:grid-cols-2">
                    <div>Buyurtma: {formatDateTime(r.orderedAt)}{r.orderedByName ? ` · ${r.orderedByName}` : ""}</div>
                    <div>Namuna olingan: {r.collectedAt ? formatDateTime(r.collectedAt) : "—"}</div>
                    {r.performedAt && <div>Bajarilgan: {formatDateTime(r.performedAt)}</div>}
                    <div>Tasdiqlangan: {formatDateTime(r.verifiedAt)}{r.verifiedByName ? ` · ${r.verifiedByName}` : ""}</div>
                    <div>Manba: {SOURCE[r.source] ?? r.source}</div>
                  </dl>
                  {r.version > 1 && r.correctionReason && <p className="text-xs text-ink-muted">Tuzatish sababi: {r.correctionReason}</p>}
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left text-xs text-ink-muted">
                        <th className="py-1 font-medium">Ko‘rsatkich</th>
                        <th className="py-1 font-medium">Qiymat</th>
                        <th className="py-1 font-medium">Me’yor</th>
                        <th className="py-1 font-medium">Joylashuv</th>
                      </tr>
                    </thead>
                    <tbody>
                      {r.values.map((v) => {
                        const flag = LAB_FLAG[v.flag] ?? { label: v.flag, tone: "neutral" as const };
                        return (
                          <tr key={v.parameterCode} className="border-t border-hairline">
                            <td className="py-1 text-foreground">{v.parameter}</td>
                            <td className="font-numeric py-1 text-foreground">{v.display}{v.unit ? ` ${v.unit}` : ""}</td>
                            <td className="py-1 text-xs text-ink-muted">{formatRange({ low: v.rangeLow, high: v.rangeHigh, text: v.rangeText }) ?? "—"}</td>
                            <td className="py-1"><ABadge tone={flag.tone}>{flag.label}</ABadge></td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                  {r.labComment && <p className="text-xs text-ink-muted">Laboratoriya izohi: {r.labComment}</p>}
                  {r.documents.length > 0 && (
                    <div className="flex flex-wrap gap-2">
                      {r.documents.map((d) => (
                        <AButton key={d.id} size="sm" variant="outline" onClick={() => void openDocument(d.id)}>
                          <Paperclip className="h-4 w-4" /> {DOC_KIND[d.kind] ?? d.kind} ({Math.max(1, Math.round(d.sizeBytes / 1024))} KB)
                        </AButton>
                      ))}
                    </div>
                  )}
                  <p className="text-xs text-ink-muted">Joylashuv faqat sozlangan me’yor oralig‘iga nisbatan ko‘rsatiladi — bu tashxis emas. O‘z xulosangizni klinik yozuvingizda qayd eting.</p>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Trends: one numeric parameter of one test over time (same unit)
// ---------------------------------------------------------------------------

function Trends({ results }: { results: Result[] }) {
  const series = useMemo(() => buildSeries(results), [results]);
  const trended = series.filter((s) => s.points.length >= 2);
  if (trended.length === 0) {
    return (
      <AEmpty
        title="Dinamika uchun ma’lumot yetarli emas"
        subtitle="Bir xil ko‘rsatkich bo‘yicha kamida ikkita tasdiqlangan son natijasi kerak"
        icon={<LineChart className="h-6 w-6" />}
      />
    );
  }
  return (
    <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
      {trended.map((s) => (
        <TrendCard key={s.key} series={s} />
      ))}
    </div>
  );
}

function TrendCard({ series }: { series: Series }) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 320;
  const H = 120;
  const pad = { l: 36, r: 12, t: 10, b: 20 };
  const last = series.points[series.points.length - 1];
  // The band shows the range configured for the latest value (recessive).
  const values = series.points.map((p) => p.value);
  const bounds = [...values, ...(last.low !== null ? [last.low] : []), ...(last.high !== null ? [last.high] : [])];
  let min = Math.min(...bounds);
  let max = Math.max(...bounds);
  if (min === max) {
    min -= 1;
    max += 1;
  }
  const span = max - min;
  min -= span * 0.1;
  max += span * 0.1;
  const times = series.points.map((p) => new Date(p.at).getTime());
  const t0 = Math.min(...times);
  const t1 = Math.max(...times);
  const x = (t: number) => pad.l + (t1 === t0 ? (W - pad.l - pad.r) / 2 : ((t - t0) / (t1 - t0)) * (W - pad.l - pad.r));
  const y = (v: number) => pad.t + (1 - (v - min) / (max - min)) * (H - pad.t - pad.b);
  const path = series.points.map((p, i) => `${i === 0 ? "M" : "L"}${x(times[i]).toFixed(1)},${y(p.value).toFixed(1)}`).join(" ");
  const bandTop = last.high !== null ? y(last.high) : pad.t;
  const bandBottom = last.low !== null ? y(last.low) : H - pad.b;
  const active = hover !== null ? series.points[hover] : null;

  return (
    <figure className="rounded-xl border border-hairline p-3" aria-label={series.title}>
      <figcaption className="text-sm font-medium text-foreground">
        {series.title}
        {series.unit && <span className="text-xs text-ink-muted"> ({series.unit})</span>}
      </figcaption>
      <p className="mb-1 h-4 text-xs text-ink-muted" aria-live="polite">
        {active ? `${formatDate(active.at)}: ${active.display}${series.unit ? ` ${series.unit}` : ""} — ${LAB_FLAG[active.flag]?.label ?? active.flag}` : `Oxirgi: ${last.display}${series.unit ? ` ${series.unit}` : ""}`}
      </p>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full text-pine" role="img" aria-label={`${series.title} dinamikasi, ${series.points.length} ta natija`}>
        {(last.low !== null || last.high !== null) && (
          <rect x={pad.l} y={bandTop} width={W - pad.l - pad.r} height={Math.max(0, bandBottom - bandTop)} className="fill-current" opacity={0.08} />
        )}
        <line x1={pad.l} x2={W - pad.r} y1={H - pad.b} y2={H - pad.b} className="stroke-hairline" strokeWidth={1} />
        <text x={pad.l - 4} y={y(max - span * 0.1) + 4} textAnchor="end" className="fill-ink-muted text-[9px]">{Number((max - span * 0.1).toFixed(2))}</text>
        <text x={pad.l - 4} y={y(min + span * 0.1) + 4} textAnchor="end" className="fill-ink-muted text-[9px]">{Number((min + span * 0.1).toFixed(2))}</text>
        <text x={pad.l} y={H - 6} className="fill-ink-muted text-[9px]">{formatDate(series.points[0].at)}</text>
        <text x={W - pad.r} y={H - 6} textAnchor="end" className="fill-ink-muted text-[9px]">{formatDate(last.at)}</text>
        <path d={path} fill="none" stroke="currentColor" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
        {series.points.map((p, i) => (
          <g key={`${p.at}-${i}`} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
            {/* Hit target larger than the mark. */}
            <circle cx={x(times[i])} cy={y(p.value)} r={10} fill="transparent" />
            <circle cx={x(times[i])} cy={y(p.value)} r={4} className="fill-current stroke-surface" strokeWidth={2} />
            <title>{`${formatDate(p.at)}: ${p.display}${series.unit ? ` ${series.unit}` : ""} — ${LAB_FLAG[p.flag]?.label ?? p.flag}`}</title>
          </g>
        ))}
      </svg>
      <table className="mt-2 w-full text-xs">
        <caption className="sr-only">{series.title} qiymatlari</caption>
        <tbody>
          {[...series.points].reverse().map((p, i) => (
            <tr key={`${p.at}-${i}`} className="border-t border-hairline">
              <td className="py-0.5 text-ink-muted">{formatDate(p.at)}</td>
              <td className="font-numeric py-0.5 text-foreground">{p.display}</td>
              <td className="py-0.5 text-ink-muted">{LAB_FLAG[p.flag]?.label ?? p.flag}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}

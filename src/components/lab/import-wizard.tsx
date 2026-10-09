"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ABadge, AButton, AError, ASelect, Card, PageHeader, StatCard } from "@/components/admin/ui";
import { adminApi, AdminApiError, formatDateTime } from "@/lib/admin/client";
import { IMPORT_FIELD_LABELS, REQUIRED_FIELDS, type ImportField, type ImportMapping } from "@/lib/labs/import/mapping";
import { IMPORT_BATCH_STATUS_LABELS, IMPORT_ERROR_LABELS, IMPORT_STATUS_LABELS, WARNING_CODES } from "@/lib/labs/import/labels";
import { formatDay } from "@/lib/labs/format-day";
import { Download } from "lucide-react";

/**
 * One historical import (Phase 13): map the columns, analyse (validation,
 * patient matching, duplicates), check the rows, try a dry run, and have a
 * SECOND lab staff member confirm. Nothing reaches patient records before
 * that confirmation; nothing existing is replaced.
 */

type Batch = {
  id: string;
  sourceSystem: string;
  fileName: string;
  status: keyof typeof IMPORT_BATCH_STATUS_LABELS;
  rows: number;
  headers: string[];
  mapping: ImportMapping;
  fields: ImportField[];
  preparedBy: string;
  confirmedBy: string | null;
  createdAt: string;
  analysedAt: string | null;
  confirmedAt: string | null;
  completedAt: string | null;
  cancelledAt: string | null;
  summary: { rows: number; byStatus: Record<string, number>; readyResults: number; readyPatients: number };
  dryRun: { at: string; checked: number; wouldImport: number; failed: number; byCode: Record<string, number>; complete: boolean } | null;
  can: { analyse: boolean; dryRun: boolean; confirm: boolean; run: boolean; finish: boolean; cancel: boolean };
  preparer: boolean;
  analysisStale: boolean;
};

type Person = { id: string; name: string | null; age: number | null; phone: string | null };
type Row = {
  rowNumber: number;
  status: keyof typeof IMPORT_STATUS_LABELS;
  errors: string[];
  patientKey: string | null;
  patient: Person | null;
  candidates: Person[];
  test: string | null;
  parameter: string | null;
  unit: string | null;
  value: string | null;
  performedAt: string | null;
  accession: string | null;
};
type RowsPage = { total: number; offset: number; pageSize: number; rows: Row[] };
type RunReport = { imported: number; duplicate: number; failed: number; byCode: Record<string, number>; remaining: number; status: string };

const STATUS_TONE: Record<string, "green" | "red" | "amber" | "blue" | "gray" | "purple"> = {
  ready: "blue",
  imported: "green",
  invalid: "red",
  conflict: "red",
  failed: "red",
  unmatched: "amber",
  possible_match: "purple",
  duplicate: "gray",
  skipped: "gray",
  pending: "gray",
};
const FILTERS = [
  ["all", "Barchasi"],
  ["ready", "Tayyor"],
  ["possible_match", "Tasdiqlash kerak"],
  ["problems", "Muammoli"],
  ["imported", "Import qilingan"],
] as const;

const label = (code: string) => IMPORT_ERROR_LABELS[code as keyof typeof IMPORT_ERROR_LABELS] ?? code;
const personLine = (p: Person) => [p.name ?? "—", p.age !== null ? `${p.age} yosh` : null, p.phone].filter(Boolean).join(" · ");

export function LabImportWizard({ batchId }: { batchId: string }) {
  const [batch, setBatch] = useState<Batch | null>(null);
  const [mapping, setMapping] = useState<ImportMapping>({});
  const [filter, setFilter] = useState<(typeof FILTERS)[number][0]>("all");
  const [page, setPage] = useState<RowsPage | null>(null);
  const [offset, setOffset] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const b = await adminApi.get<Batch>(`/api/lab/imports/${batchId}`);
      setBatch(b);
      setMapping(b.mapping);
    } catch (e) {
      setError(e instanceof AdminApiError ? e.message : "Importni yuklab bo‘lmadi");
    }
  }, [batchId]);

  const loadRows = useCallback(async () => {
    try {
      setPage(await adminApi.get<RowsPage>(`/api/lab/imports/${batchId}/rows?filter=${filter}&offset=${offset}`));
    } catch (e) {
      setError(e instanceof AdminApiError ? e.message : "Qatorlarni yuklab bo‘lmadi");
    }
  }, [batchId, filter, offset]);

  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    if (batch && batch.status !== "uploaded") void loadRows();
  }, [batch, loadRows]);

  const act = async (action: string, body: Record<string, unknown> = {}, message?: (r: unknown) => string) => {
    setBusy(action);
    setError(null);
    setNotice(null);
    try {
      const result = await adminApi.post<unknown>(`/api/lab/imports/${batchId}`, { action, ...body });
      await load();
      if (message) setNotice(message(result));
    } catch (e) {
      setError(e instanceof AdminApiError ? e.message : "Amalni bajarib bo‘lmadi");
    } finally {
      setBusy(null);
    }
  };

  const runMessage = (r: unknown) => {
    const x = r as RunReport;
    return `Import qilindi: ${x.imported} natija. Takror: ${x.duplicate}. Xato: ${x.failed}.${x.remaining ? ` Qoldi: ${x.remaining} — “Davom ettirish”ni bosing.` : ""}`;
  };

  if (!batch) return error ? <AError message={error} /> : null;
  const s = batch.summary.byStatus;
  const editing = batch.can.analyse;

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <Link href="/lab/imports" className="text-sm text-pine">← Importlar</Link>
      <PageHeader
        title={batch.fileName}
        subtitle={`${batch.sourceSystem} · ${batch.rows} qator · tayyorladi: ${batch.preparedBy}${batch.confirmedBy ? ` · tasdiqladi: ${batch.confirmedBy}` : ""}`}
        action={<ABadge tone={batch.status === "completed" ? "green" : batch.status === "cancelled" ? "gray" : "blue"}>{IMPORT_BATCH_STATUS_LABELS[batch.status]}</ABadge>}
      />

      {error && <AError message={error} />}
      {notice && <p role="status" className="rounded-lg bg-pine-tint px-3 py-2 text-sm text-pine-deep">{notice}</p>}

      {editing && (
        <Card className="space-y-4">
          <h2 className="font-display text-base font-semibold">1. Ustunlarni moslash</h2>
          <p className="text-xs text-ink-muted">
            Har bir qator — bitta ko‘rsatkich qiymati. Tahlil va ko‘rsatkich katalogdagi kod yoki nom bo‘yicha topiladi; o‘lchov birliklari aylantirilmaydi.
          </p>
          <div className="grid gap-3 md:grid-cols-3" aria-label="Ustunlar moslamasi">
            {batch.fields.map((field) => (
              <label key={field} className="space-y-1 text-sm">
                <span className="font-medium">
                  {IMPORT_FIELD_LABELS[field]}
                  {REQUIRED_FIELDS.includes(field) ? " *" : ""}
                </span>
                <ASelect
                  aria-label={IMPORT_FIELD_LABELS[field]}
                  value={mapping[field] === undefined ? "" : String(mapping[field])}
                  onChange={(v) => setMapping((m) => {
                    const next = { ...m };
                    if (v === "") delete next[field];
                    else next[field] = Number(v);
                    return next;
                  })}
                  options={[{ value: "", label: "— yo‘q —" }, ...batch.headers.map((h, i) => ({ value: String(i), label: h }))]}
                />
              </label>
            ))}
          </div>
          <AButton loading={busy === "analyse"} onClick={() => act("analyse", { mapping }, () => "Fayl tahlil qilindi. Natijalarni pastda tekshiring.")}>
            Tahlil qilish
          </AButton>
        </Card>
      )}

      {batch.status !== "uploaded" && (
        <section aria-label="Xulosa" className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <StatCard label="Import uchun tayyor natijalar" value={`${batch.summary.readyResults}`} tone="pine" />
          <StatCard label="Bemorni tasdiqlash kerak (qator)" value={`${s.possible_match ?? 0}`} tone="info" />
          <StatCard label="Muammoli qatorlar" value={`${(s.invalid ?? 0) + (s.unmatched ?? 0) + (s.conflict ?? 0) + (s.failed ?? 0)}`} tone="clay" />
          <StatCard label="Import qilingan qatorlar" value={`${s.imported ?? 0}`} />
        </section>
      )}

      {batch.status !== "uploaded" && (
        <Card className="space-y-3">
          <h2 className="font-display text-base font-semibold">2. Tekshirish va tasdiqlash</h2>
          <p className="text-sm text-ink-muted">
            {Object.entries(s)
              .map(([k, n]) => `${IMPORT_STATUS_LABELS[k as keyof typeof IMPORT_STATUS_LABELS] ?? k}: ${n}`)
              .join(" · ")}
          </p>
          {batch.analysedAt && <p className="text-xs text-ink-muted">Tahlil: {formatDateTime(batch.analysedAt)}</p>}
          {batch.analysisStale && <p className="text-sm text-danger">Tahlil 24 soatdan eski — tayyorlovchi faylni qayta tahlil qilsin.</p>}
          {batch.dryRun && (
            <p className="text-sm" aria-label="Sinov natijasi">
              Sinov importi ({formatDateTime(batch.dryRun.at)}): {batch.dryRun.wouldImport} natija import bo‘ladi, {batch.dryRun.failed} bo‘lmaydi
              {Object.keys(batch.dryRun.byCode).length ? ` (${Object.entries(batch.dryRun.byCode).map(([c, n]) => `${label(c)}: ${n}`).join("; ")})` : ""}
              {batch.dryRun.complete ? "" : " — sinov to‘liq tugamadi"}.
            </p>
          )}
          {batch.status === "analysed" && batch.preparer && (
            <p className="text-sm text-ink-muted">Importni boshqa laboratoriya xodimi tasdiqlashi kerak — siz faylni tayyorlagansiz.</p>
          )}
          <div className="flex flex-wrap gap-2">
            {batch.can.dryRun && (
              <AButton variant="outline" loading={busy === "dry_run"} onClick={() => act("dry_run", {}, () => "Sinov importi tugadi — hech narsa saqlanmadi.")}>
                Sinov importi
              </AButton>
            )}
            {batch.can.confirm && (
              <AButton loading={busy === "confirm"} onClick={() => act("confirm", {}, runMessage)}>
                Tasdiqlash va import qilish ({batch.summary.readyResults} natija)
              </AButton>
            )}
            {batch.can.run && (s.ready ?? 0) > 0 && (
              <AButton loading={busy === "continue"} onClick={() => act("continue", {}, runMessage)}>
                Davom ettirish
              </AButton>
            )}
            {batch.can.run && (s.failed ?? 0) > 0 && (
              <AButton variant="secondary" loading={busy === "retry_failed"} onClick={() => act("retry_failed", {}, runMessage)}>
                Xatolarni qayta urinish
              </AButton>
            )}
            {batch.can.finish && (
              <AButton variant="outline" loading={busy === "finish"} onClick={() => act("finish", {}, () => "Import yakunlandi.")}>
                Yakunlash
              </AButton>
            )}
            {batch.can.cancel && (
              <AButton variant="danger" loading={busy === "cancel"} onClick={() => act("cancel", {}, () => "Import bekor qilindi. Import qilingan natijalar saqlanadi.")}>
                Bekor qilish
              </AButton>
            )}
            <a href={`/api/lab/imports/${batch.id}/report`} className="inline-flex items-center gap-1.5 rounded-lg border border-hairline px-4 py-2 text-sm hover:bg-sand">
              <Download className="h-4 w-4" /> Hisobot (CSV)
            </a>
          </div>
        </Card>
      )}

      {batch.status !== "uploaded" && page && (
        <section aria-label="Qatorlar" className="space-y-3">
          <div className="flex flex-wrap gap-2" role="tablist" aria-label="Qatorlar filtri">
            {FILTERS.map(([value, text]) => (
              <AButton key={value} size="sm" variant={filter === value ? "primary" : "outline"} onClick={() => { setFilter(value); setOffset(0); }}>
                {text}
              </AButton>
            ))}
          </div>
          <div className="overflow-x-auto rounded-xl border border-hairline bg-surface">
            <table className="w-full text-left text-sm">
              <thead className="bg-sand text-xs text-ink-muted">
                <tr>
                  <th className="px-3 py-2">Qator</th>
                  <th className="px-3 py-2">Bemor</th>
                  <th className="px-3 py-2">Tahlil</th>
                  <th className="px-3 py-2">Qiymat</th>
                  <th className="px-3 py-2">Sana</th>
                  <th className="px-3 py-2">Holat</th>
                </tr>
              </thead>
              <tbody>
                {page.rows.map((r) => (
                  <tr key={r.rowNumber} className="border-t border-hairline align-top" data-row={r.rowNumber}>
                    <td className="px-3 py-2 font-numeric">{r.rowNumber}</td>
                    <td className="px-3 py-2">
                      {r.patient ? (
                        personLine(r.patient)
                      ) : r.candidates.length ? (
                        <div className="space-y-1">
                          {r.candidates.map((c) => (
                            <div key={c.id} className="flex flex-wrap items-center gap-2">
                              <span>{personLine(c)}</span>
                              {r.status === "possible_match" && batch.can.analyse && r.patientKey && (
                                <AButton size="sm" variant="secondary" loading={busy === `match-${r.rowNumber}`}
                                  onClick={() => act("confirm_match", { patientKey: r.patientKey, patientId: c.id }, () => "Bemor tasdiqlandi va fayl qayta tahlil qilindi.")}>
                                  Shu bemor
                                </AButton>
                              )}
                            </div>
                          ))}
                        </div>
                      ) : (
                        <span className="text-ink-muted">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2">{r.test ?? "—"}{r.parameter && r.parameter !== r.test ? ` · ${r.parameter}` : ""}</td>
                    <td className="px-3 py-2 font-numeric">{r.value ?? "—"}{r.unit ? ` ${r.unit}` : ""}</td>
                    <td className="px-3 py-2">{r.performedAt ? formatDay(r.performedAt) : "—"}</td>
                    <td className="px-3 py-2">
                      <ABadge tone={STATUS_TONE[r.status] ?? "gray"}>{IMPORT_STATUS_LABELS[r.status] ?? r.status}</ABadge>
                      {r.errors.length > 0 && (
                        <ul className="mt-1 space-y-0.5 text-xs">
                          {r.errors.map((e) => (
                            <li key={e} className={WARNING_CODES.has(e) ? "text-ink-muted" : "text-danger"}>{label(e)}</li>
                          ))}
                        </ul>
                      )}
                    </td>
                  </tr>
                ))}
                {page.rows.length === 0 && (
                  <tr>
                    <td colSpan={6} className="px-3 py-6 text-center text-ink-muted">Qator yo‘q</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <div className="flex items-center gap-2 text-sm">
            <AButton size="sm" variant="outline" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - page.pageSize))}>Oldingi</AButton>
            <span>{page.total ? `${offset + 1}–${Math.min(offset + page.pageSize, page.total)} / ${page.total}` : "0"}</span>
            <AButton size="sm" variant="outline" disabled={offset + page.pageSize >= page.total} onClick={() => setOffset(offset + page.pageSize)}>Keyingi</AButton>
          </div>
        </section>
      )}
    </div>
  );
}

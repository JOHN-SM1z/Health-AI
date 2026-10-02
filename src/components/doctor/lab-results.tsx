"use client";

import { useEffect, useState } from "react";
import { ABadge, AButton, AError, AModal, Card, LoadingRow } from "@/components/admin/ui";
import { adminApi, AdminApiError, formatDateTime } from "@/lib/admin/client";
import { DOCUMENT_KIND_LABELS, FLAG_LABELS, formatBytes } from "@/components/lab/flags";
import type { LabResultDetail, LabResultSummary, LabValueView, LabVersionView } from "@/lib/labs/longitudinal";

/** One line of the patient's finalised laboratory results. */
export function LabResultCard({ result, onOpen }: { result: LabResultSummary; onOpen: () => void }) {
  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-sm font-medium text-foreground">
            {result.testName} <span className="font-numeric text-xs font-normal text-ink-muted">{result.testCode}</span>
          </p>
          <p className="text-xs text-ink-muted">
            Natija: {formatDateTime(result.resultAt)}
            {result.collectedAt ? ` · namuna: ${formatDateTime(result.collectedAt)}` : ""} · buyurtma: {formatDateTime(result.orderedAt)}
            {result.orderedBy ? ` · ${result.isOwnOrder ? "siz buyurtma qilgansiz" : result.orderedBy}` : ""}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {result.outsideCount > 0 ? <ABadge tone="amber">{result.outsideCount} ta qiymat me‘yordan tashqarida</ABadge> : <ABadge tone="green">Barcha qiymatlar me‘yorda yoki baholanmagan</ABadge>}
          {result.version > 1 && <ABadge tone="blue">Tuzatilgan (v{result.version})</ABadge>}
          {result.documentCount > 0 && <ABadge tone="neutral">{result.documentCount} hujjat</ABadge>}
          <AButton size="sm" variant="outline" onClick={onOpen}>
            Ko‘rish
          </AButton>
        </div>
      </div>
    </Card>
  );
}

function ValueRows({ values }: { values: LabValueView[] }) {
  return (
    <ul className="divide-y divide-hairline/70 rounded-lg border border-hairline">
      {values.map((v) => (
        <li key={v.code} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
          <span className="text-foreground">{v.name}</span>
          <span className="flex items-center gap-2">
            <span className="font-numeric font-medium text-foreground">
              {v.comparator ?? ""}
              {v.value} {v.unit ?? ""}
            </span>
            <span className="text-xs text-ink-muted">{v.refLow !== null || v.refHigh !== null ? `(${v.refLow ?? "…"} – ${v.refHigh ?? "…"})` : ""}</span>
            <ABadge tone={FLAG_LABELS[v.flag]?.tone ?? "gray"}>{FLAG_LABELS[v.flag]?.label ?? v.flag}</ABadge>
          </span>
        </li>
      ))}
    </ul>
  );
}

function VersionBlock({ v, title }: { v: LabVersionView; title: string }) {
  return (
    <div>
      <p className="mb-1 text-sm font-bold text-foreground">{title}</p>
      <p className="mb-2 text-xs text-ink-muted">
        Kiritgan: {v.enteredBy ?? "—"} · {formatDateTime(v.enteredAt)} · tasdiqlagan: {v.verifiedBy ?? "—"} · {formatDateTime(v.verifiedAt)}
        {v.correctsVersion ? ` · v${v.correctsVersion} ni tuzatadi` : ""}
        {v.correctionReason ? ` · sabab: ${v.correctionReason}` : ""}
      </p>
      <ValueRows values={v.values} />
    </div>
  );
}

/**
 * A finalised result in full: values with the configured range and flag, earlier finalised versions, dates, who entered and who
 * verified, and the documents. Read-only: a doctor who reads a colleague's result cannot change it, and a different clinical reading
 * is the doctor's own record. Documents open through the authorised route - there is no link that works by itself.
 */
export function LabResultDialog({ patientId, itemId, onClose }: { patientId: string; itemId: string; onClose: () => void }) {
  const [detail, setDetail] = useState<LabResultDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    adminApi
      .get<{ result: LabResultDetail }>(`/api/doctor/patients/${patientId}/lab/results/${itemId}`)
      .then((r) => setDetail(r.result))
      .catch((e) => setError(e instanceof AdminApiError ? e.message : "Natijani yuklab bo‘lmadi"));
  }, [patientId, itemId]);

  return (
    <AModal title={detail ? detail.testName : "Tahlil natijasi"} onClose={onClose} maxWidth="max-w-2xl" footer={<AButton onClick={onClose}>Yopish</AButton>}>
      {error && <AError message={error} />}
      {!detail && !error && <LoadingRow />}
      {detail && (
        <div className="flex flex-col gap-4">
          <p className="text-xs text-ink-muted">
            Buyurtma: {formatDateTime(detail.orderedAt)}
            {detail.orderedBy ? ` (${detail.orderedBy})` : ""} · namuna: {detail.collectedAt ? formatDateTime(detail.collectedAt) : "—"} · natija: {formatDateTime(detail.resultAt)}
          </p>
          <p className="text-xs text-ink-muted">Belgi faqat sozlangan me‘yor bilan solishtirish natijasi; bu tashxis emas. Natijani faqat laboratoriya o‘zgartiradi — sizning xulosangiz o‘z klinik yozuvingizda bo‘ladi.</p>
          <VersionBlock v={detail.current} title={`Joriy natija · versiya ${detail.current.version}`} />
          {detail.documents.length > 0 && (
            <div>
              <p className="mb-1 text-sm font-bold text-foreground">Hujjatlar</p>
              <ul className="divide-y divide-hairline/70 rounded-lg border border-hairline text-sm">
                {detail.documents.map((d) => (
                  <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
                    <span>
                      {DOCUMENT_KIND_LABELS[d.kind] ?? d.kind} · {d.contentType.replace("application/", "").replace("image/", "").toUpperCase()} · {formatBytes(d.sizeBytes)}
                    </span>
                    <a href={`/api/doctor/patients/${patientId}/lab/documents/${d.id}`} target="_blank" rel="noopener noreferrer" className="font-medium text-pine hover:underline">
                      Ochish
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {detail.previous.length > 0 && (
            <div className="flex flex-col gap-3 border-t border-hairline pt-3">
              <p className="text-sm font-bold text-foreground">Oldingi tasdiqlangan versiyalar</p>
              {detail.previous.map((v) => (
                <VersionBlock key={v.version} v={v} title={`Versiya ${v.version} · almashtirilgan`} />
              ))}
            </div>
          )}
        </div>
      )}
    </AModal>
  );
}

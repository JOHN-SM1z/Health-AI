"use client";

import { useEffect, useState } from "react";
import { ABadge, AError, LoadingRow } from "@/components/admin/ui";
import { adminApi, AdminApiError, formatDateTime } from "@/lib/admin/client";

type RecordVersion = {
  id: string;
  version: number;
  status: "current" | "superseded";
  summary: string;
  details: string | null;
  code: string | null;
  createdAt: string;
  author: { id: string; name: string | null };
  supersededAt: string | null;
};

/**
 * Every version of one record, oldest first — read-only. The normal views
 * show only the current version; this is where an authorized doctor sees
 * what a correction changed, who made it and when.
 */
export function RecordHistory({ patientId, recordId }: { patientId: string; recordId: string }) {
  const [versions, setVersions] = useState<RecordVersion[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    adminApi
      .get<{ history: { versions: RecordVersion[] } }>(`/api/doctor/patients/${patientId}/records/${recordId}/history`)
      .then((res) => live && setVersions(res.history.versions))
      .catch((e) => live && setError(e instanceof AdminApiError ? e.message : "Yozuv tarixini yuklab bo‘lmadi"));
    return () => {
      live = false;
    };
  }, [patientId, recordId]);

  if (error) return <AError message={error} />;
  if (!versions) return <LoadingRow />;
  return (
    <ol className="mt-2 flex flex-col gap-2 border-l-2 border-hairline pl-3" aria-label="Yozuv tarixi">
      {versions.map((v) => (
        <li key={v.id} className="text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-medium text-ink-muted">{v.version}-versiya</span>
            <ABadge tone={v.status === "current" ? "green" : "gray"}>{v.status === "current" ? "Amaldagi" : "Almashtirilgan"}</ABadge>
          </div>
          <p className={v.status === "current" ? "font-medium text-foreground" : "text-ink-muted"}>
            {v.summary}
            {v.code && <span className="font-numeric text-xs"> · {v.code}</span>}
          </p>
          {v.details && <p className="whitespace-pre-wrap text-xs text-ink-muted">{v.details}</p>}
          <p className="text-xs text-ink-muted">
            {v.author.name ?? "—"} · {formatDateTime(v.createdAt)}
          </p>
        </li>
      ))}
    </ol>
  );
}

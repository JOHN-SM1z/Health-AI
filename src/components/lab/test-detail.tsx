"use client";

import { ABadge } from "@/components/admin/ui";
import { DATA_TYPE_LABELS, formatRange, type LabTestDetail } from "@/components/lab/types";

/** Read-only view of one test's parameters and reference ranges (the technician's reference, and the preview in configuration). */
export function TestParametersView({ test }: { test: LabTestDetail }) {
  if (test.parameters.length === 0) return <p className="text-sm text-ink-muted">Parametrlar hali qo‘shilmagan</p>;
  return (
    <ul className="flex flex-col gap-2">
      {test.parameters.map((p) => (
        <li key={p.id} className="rounded-lg border border-hairline bg-surface px-3 py-2 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-foreground">{p.name}</span>
            <span className="font-numeric text-xs text-ink-muted">{p.code}</span>
            {p.unit && <span className="text-xs text-ink-muted">{p.unit}</span>}
            <ABadge tone="gray">{DATA_TYPE_LABELS[p.data_type]}</ABadge>
            {!p.active && <ABadge tone="amber">Nofaol</ABadge>}
          </div>
          {p.data_type === "choice" && p.choices && <p className="mt-1 text-xs text-ink-muted">Variantlar: {p.choices.join(", ")}</p>}
          {p.ranges.filter((r) => r.active).map((r) => (
            <p key={r.id} className="mt-1 text-xs text-ink-muted">
              Me‘yor: {formatRange(r)}
              {r.note ? ` — ${r.note}` : ""}
            </p>
          ))}
        </li>
      ))}
    </ul>
  );
}

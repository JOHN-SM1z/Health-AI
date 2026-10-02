"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { FlaskConical } from "lucide-react";
import { PageHeader, Card, ABadge, AEmpty, AError, AButton, LoadingRow } from "@/components/admin/ui";
import { adminApi, AdminApiError, formatDateTime } from "@/lib/admin/client";
import type { ResultListItem } from "@/lib/labs/results";

type Filter = "todo" | "review" | "verified" | "all";
const FILTERS: Array<{ key: Filter; label: string }> = [
  { key: "todo", label: "Kiritish kerak" },
  { key: "review", label: "Tasdiq kutmoqda" },
  { key: "verified", label: "Tasdiqlangan" },
  { key: "all", label: "Hammasi" },
];
const STATE: Record<string, { label: string; tone: "neutral" | "amber" | "green" | "blue" }> = {
  none: { label: "Natija kiritilmagan", tone: "neutral" },
  draft: { label: "Qoralama", tone: "amber" },
  pending_verification: { label: "Tasdiq kutmoqda", tone: "blue" },
  verified: { label: "Tasdiqlangan", tone: "green" },
};

/** The bench's results: ordered tests whose samples were collected, by state — values are opened one test at a time. */
export default function LabResultsPage() {
  const [filter, setFilter] = useState<Filter>("todo");
  const [items, setItems] = useState<ResultListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setItems(null);
    adminApi
      .get<{ items: ResultListItem[] }>(`/api/lab/results?filter=${filter}`)
      .then((r) => {
        setItems(r.items);
        setError(null);
      })
      .catch((e) => setError(e instanceof AdminApiError ? e.message : "Natijalarni yuklab bo‘lmadi"));
  }, [filter]);

  return (
    <div>
      <PageHeader title="Natijalar" subtitle="Natija kiritish, tasdiqlash va tuzatish" />
      <div className="mb-4 flex flex-wrap gap-2" role="tablist" aria-label="Natija holati">
        {FILTERS.map((f) => (
          <AButton key={f.key} size="sm" variant={filter === f.key ? "primary" : "outline"} onClick={() => setFilter(f.key)}>
            {f.label}
          </AButton>
        ))}
      </div>
      {error && <AError message={error} />}
      {items === null ? (
        <Card>
          <LoadingRow />
        </Card>
      ) : items.length === 0 ? (
        <Card>
          <AEmpty title="Bu bo‘limda tahlil yo‘q" subtitle="Namuna olingach, tahlil natijasini shu yerda kiritasiz" icon={<FlaskConical className="h-6 w-6" />} />
        </Card>
      ) : (
        <ul className="flex flex-col gap-2">
          {items.map((i) => (
            <li key={i.itemId}>
              <Card>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <p className="text-sm font-bold text-foreground">
                      {i.testName} <span className="font-numeric text-xs font-normal text-ink-muted">{i.testCode}</span>
                    </p>
                    <p className="text-xs text-ink-muted">
                      {i.patientName ?? "—"} · {formatDateTime(i.createdAt)}
                      {i.enteredBy ? ` · ${i.enteredBy}` : ""}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    {i.priority === "urgent" && <ABadge tone="red">Shoshilinch</ABadge>}
                    {i.orphaned && <ABadge tone="amber">Egasi faol emas</ABadge>}
                    <ABadge tone={STATE[i.state]?.tone ?? "neutral"}>{STATE[i.state]?.label ?? i.state}</ABadge>
                    <Link href={`/lab/results/${i.itemId}`} className="inline-flex items-center rounded-lg border border-hairline px-3 py-1.5 text-sm font-medium text-foreground hover:bg-sand">
                      Ochish
                    </Link>
                  </div>
                </div>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

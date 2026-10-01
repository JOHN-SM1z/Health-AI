"use client";

import { useEffect, useState } from "react";
import { FlaskConical } from "lucide-react";
import { PageHeader, Card, ABadge, ATable, AEmpty, AError, AButton, LoadingRow } from "@/components/admin/ui";
import { adminApi, AdminApiError } from "@/lib/admin/client";
import { TestParametersView } from "@/components/lab/test-detail";
import { formatTurnaround, type LabTest, type LabTestDetail } from "@/components/lab/types";

/**
 * The technician's landing page: the clinic's laboratory catalog, read-only. Samples, results and
 * verification arrive in later phases; patients, bookings and money are never part of this workspace.
 */
export default function LabHomePage() {
  const [tests, setTests] = useState<LabTest[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<LabTestDetail | null>(null);

  useEffect(() => {
    adminApi
      .get<{ tests: LabTest[] }>("/api/admin/lab/tests")
      .then((r) => setTests(r.tests))
      .catch((e) => setError(e instanceof AdminApiError ? e.message : "Tahlillarni yuklab bo‘lmadi"));
  }, []);

  const show = async (id: string) => {
    try {
      const res = await adminApi.get<{ test: LabTestDetail }>(`/api/admin/lab/tests?id=${id}`);
      setOpen(res.test);
    } catch (e) {
      setError(e instanceof AdminApiError ? e.message : "Tahlilni yuklab bo‘lmadi");
    }
  };

  return (
    <div>
      <PageHeader title="Tahlillar" subtitle="Klinikada o‘tkaziladigan tahlillar, namuna turlari va me‘yorlar" />
      {error && <AError message={error} />}
      {tests === null ? (
        <Card>
          <LoadingRow />
        </Card>
      ) : tests.length === 0 ? (
        <Card>
          <AEmpty title="Tahlillar sozlanmagan" subtitle="Klinika rahbariyati tahlillarni qo‘shgach shu yerda ko‘rinadi" icon={<FlaskConical className="h-6 w-6" />} />
        </Card>
      ) : (
        <div className="grid gap-4 lg:grid-cols-5">
          <div className="lg:col-span-3">
            <ATable headers={["Kod", "Nomi", "Bo‘lim", "Namuna", "Muddat", ""]}>
              {tests.map((t) => (
                <tr key={t.id} className="hover:bg-sand">
                  <td className="font-numeric px-4 py-3 text-xs">{t.code}</td>
                  <td className="px-4 py-3 font-medium text-foreground">{t.name}</td>
                  <td className="px-4 py-3 text-ink-muted">{t.category?.name ?? "—"}</td>
                  <td className="px-4 py-3 text-ink-muted">{t.sample_type ?? "—"}</td>
                  <td className="px-4 py-3 text-ink-muted">{formatTurnaround(t.turnaround_minutes)}</td>
                  <td className="px-4 py-3">
                    <AButton size="sm" variant="outline" onClick={() => void show(t.id)}>Ko‘rish</AButton>
                  </td>
                </tr>
              ))}
            </ATable>
          </div>
          <div className="lg:col-span-2">
            <Card>
              {open ? (
                <>
                  <p className="font-display text-base font-bold text-foreground">{open.name}</p>
                  <div className="my-2 flex flex-wrap gap-2">
                    {open.sample_type && <ABadge tone="gray">{open.sample_type}</ABadge>}
                    <ABadge tone="gray">{formatTurnaround(open.turnaround_minutes)}</ABadge>
                  </div>
                  {open.preparation_text && <p className="mb-3 text-sm text-ink-muted">Tayyorgarlik: {open.preparation_text}</p>}
                  <TestParametersView test={open} />
                </>
              ) : (
                <p className="text-sm text-ink-muted">Tahlilni tanlang</p>
              )}
            </Card>
          </div>
        </div>
      )}
    </div>
  );
}

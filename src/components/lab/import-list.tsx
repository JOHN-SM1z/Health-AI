"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ABadge, AButton, AEmpty, AError, AInput, Card, PageHeader } from "@/components/admin/ui";
import { adminApi, AdminApiError, formatDateTime } from "@/lib/admin/client";
import { IMPORT_BATCH_STATUS_LABELS } from "@/lib/labs/import/labels";
import { Upload } from "lucide-react";

/**
 * Historical lab imports (Phase 13): upload a CSV file exported from the
 * previous system, then map, check and confirm it on the import's page.
 * Uploading imports nothing.
 */

type Batch = { id: string; sourceSystem: string; fileName: string; status: keyof typeof IMPORT_BATCH_STATUS_LABELS; rows: number; createdAt: string; preparedByMe: boolean };

const TONE: Record<string, "amber" | "blue" | "green" | "gray" | "purple"> = { uploaded: "amber", analysed: "blue", confirmed: "purple", completed: "green", cancelled: "gray" };
const MAX_MB = 2;

export function LabImportList() {
  const router = useRouter();
  const [batches, setBatches] = useState<Batch[] | null>(null);
  const [source, setSource] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const load = async () => {
    try {
      setBatches((await adminApi.get<{ batches: Batch[] }>("/api/lab/imports")).batches);
    } catch (e) {
      setError(e instanceof AdminApiError ? e.message : "Importlarni yuklab bo‘lmadi");
    }
  };
  useEffect(() => {
    void load();
  }, []);

  const upload = async () => {
    const file = fileInput.current?.files?.[0];
    setError(null);
    if (!source.trim()) return setError("Manba tizimini yozing (masalan: MedPlus)");
    if (!file) return setError("CSV faylni tanlang");
    if (file.size > MAX_MB * 1024 * 1024) return setError(`Fayl ${MAX_MB} MB dan katta — uni bir necha qismga bo‘ling`);
    setBusy(true);
    try {
      const form = new FormData();
      form.set("file", file);
      form.set("sourceSystem", source.trim());
      const res = await fetch("/api/lab/imports", { method: "POST", body: form, credentials: "same-origin" });
      const body = (await res.json().catch(() => null)) as { ok?: boolean; error?: string; code?: string; data?: { id: string } } | null;
      if (!res.ok || !body?.ok || !body.data) throw new AdminApiError(res.status, body?.error ?? "Faylni yuklab bo‘lmadi", body?.code);
      router.push(`/lab/imports/${body.data.id}`);
    } catch (e) {
      setError(e instanceof AdminApiError ? e.message : "Faylni yuklab bo‘lmadi");
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <PageHeader title="Tarixiy natijalar importi" subtitle="Oldingi tizimdan (MedPlus, Excel va boshqalar) eksport qilingan CSV fayl" />

      <Card className="space-y-4">
        <div className="grid gap-3 md:grid-cols-[1fr_1fr_auto] md:items-end">
          <label className="space-y-1 text-sm">
            <span className="font-medium">Manba tizimi</span>
            <AInput value={source} onChange={setSource} placeholder="MedPlus" aria-label="Manba tizimi" />
          </label>
          <label className="space-y-1 text-sm">
            <span className="font-medium">CSV fayl (UTF-8, 2 MB gacha, 5000 qatorgacha)</span>
            <input ref={fileInput} type="file" accept=".csv,.tsv,.txt,text/csv" aria-label="CSV fayl" className="block w-full text-sm" />
          </label>
          <AButton onClick={upload} loading={busy}>
            <Upload className="h-4 w-4" /> Yuklash
          </AButton>
        </div>
        <ul className="list-disc space-y-1 pl-5 text-xs text-ink-muted">
          <li>Har bir qator — bitta ko‘rsatkich qiymati: bemor, tahlil, ko‘rsatkich, qiymat, sana.</li>
          <li>Excel faylni “CSV UTF-8” sifatida saqlang. PDF hisobotlardan jadval o‘qilmaydi.</li>
          <li>Yuklash hech narsani import qilmaydi: avval ustunlar moslanadi, tekshiriladi va ikkinchi xodim tasdiqlaydi.</li>
          <li>Bemorlar faqat aniq identifikator (JShShIR, pasport, bemor ID) bo‘yicha moslanadi; faqat ism bo‘yicha hech qachon. Yangi bemor yaratilmaydi, kartalar birlashtirilmaydi.</li>
        </ul>
        {error && <AError message={error} />}
      </Card>

      <section aria-label="Importlar" className="space-y-2">
        {batches === null ? null : batches.length === 0 ? (
          <AEmpty title="Hali import yo‘q" />
        ) : (
          batches.map((b) => (
            <Link key={b.id} href={`/lab/imports/${b.id}`} className="block">
              <Card className="flex flex-wrap items-center justify-between gap-3 hover:bg-sand">
                <div>
                  <p className="text-sm font-medium">{b.fileName}</p>
                  <p className="text-xs text-ink-muted">
                    {b.sourceSystem} · {b.rows} qator · {formatDateTime(b.createdAt)}
                    {b.preparedByMe ? " · siz tayyorlagansiz" : ""}
                  </p>
                </div>
                <ABadge tone={TONE[b.status]}>{IMPORT_BATCH_STATUS_LABELS[b.status]}</ABadge>
              </Card>
            </Link>
          ))
        )}
      </section>
    </div>
  );
}

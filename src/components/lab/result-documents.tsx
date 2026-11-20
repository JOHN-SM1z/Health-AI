"use client";

import { useEffect, useRef, useState } from "react";
import { ABadge, AButton, AError, ASelect, ATextArea } from "@/components/admin/ui";
import { adminApi, AdminApiError, formatDateTime } from "@/lib/admin/client";
import { Paperclip, Upload } from "lucide-react";

/**
 * Attachments of a lab result (Phase 11): the report / scan / image files of
 * this result version and of its order. Files are uploaded while the result
 * is a draft or in review; a verified version's evidence is final. Files open
 * through a 60-second signed link and are withdrawn with a reason — never
 * deleted.
 */

type Doc = {
  id: string;
  resultId: string | null;
  resultVersion: number | null;
  kind: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: string;
  uploadedByName: string | null;
  withdrawnAt: string | null;
  withdrawReason: string | null;
};

const KIND: Record<string, string> = { report: "Hisobot (PDF)", scan: "Skan", image: "Rasm", import_source: "Import manbasi" };
const MAX_MB = 20;
const errorText = (e: unknown, fallback: string) => (e instanceof AdminApiError ? e.message : fallback);

export function ResultDocuments({ orderId, resultId, canUpload }: { orderId: string; resultId: string | null; canUpload: boolean }) {
  const [docs, setDocs] = useState<Doc[] | null>(null);
  const [kind, setKind] = useState("report");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [withdrawing, setWithdrawing] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);

  const load = async () => {
    try {
      const res = await adminApi.get<{ documents: Doc[] }>(`/api/lab/orders/${orderId}/documents`);
      setDocs(res.documents);
    } catch (e) {
      setError(errorText(e, "Hujjatlarni yuklab bo‘lmadi"));
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reload per order
  }, [orderId]);

  const upload = async (file: File) => {
    setError(null);
    if (file.size > MAX_MB * 1024 * 1024) {
      setError(`Fayl ${MAX_MB} MB dan katta`);
      return;
    }
    setBusy(true);
    try {
      const form = new FormData();
      form.set("file", file);
      form.set("kind", kind);
      if (resultId) form.set("resultId", resultId);
      // Multipart, so not through adminApi (which sends JSON).
      const res = await fetch(`/api/lab/orders/${orderId}/documents`, { method: "POST", body: form, credentials: "same-origin" });
      const body = (await res.json().catch(() => null)) as { ok?: boolean; error?: string; code?: string } | null;
      if (!res.ok || !body?.ok) throw new AdminApiError(res.status, body?.error ?? "Faylni yuklab bo‘lmadi", body?.code);
      await load();
    } catch (e) {
      setError(errorText(e, "Faylni yuklab bo‘lmadi"));
    } finally {
      setBusy(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  };

  // Opened synchronously in the click so the browser does not block the tab.
  const open = async (id: string) => {
    setError(null);
    const tab = window.open("about:blank", "_blank");
    if (tab) tab.opener = null;
    try {
      const res = await adminApi.get<{ url: string }>(`/api/lab/documents/${id}`);
      if (tab) tab.location.href = res.url;
      else window.location.assign(res.url);
    } catch (e) {
      tab?.close();
      setError(errorText(e, "Hujjatni ochib bo‘lmadi"));
    }
  };

  const confirmWithdraw = async (id: string) => {
    setError(null);
    try {
      await adminApi.post(`/api/lab/documents/${id}`, { action: "withdraw", reason: reason.trim() });
      setWithdrawing(null);
      setReason("");
      await load();
    } catch (e) {
      setError(errorText(e, "Hujjatni olib tashlab bo‘lmadi"));
    }
  };

  // Every file of the order, each labelled with the result version it belongs to.
  const shown = docs ?? [];

  return (
    <div className="flex flex-col gap-2 rounded-xl border border-hairline p-3" role="group" aria-label="Ilovalar">
      <p className="text-sm font-medium text-foreground">Ilovalar</p>
      {error && <AError message={error} />}
      {docs === null ? (
        <div className="h-2 w-full animate-pulse rounded bg-hairline" />
      ) : shown.length === 0 ? (
        <p className="text-xs text-ink-muted">Hali fayl biriktirilmagan.</p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {shown.map((d) => (
            <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 text-sm">
              <span className={d.withdrawnAt ? "text-ink-muted line-through" : "text-foreground"}>
                <Paperclip className="mr-1 inline h-4 w-4" />
                {KIND[d.kind] ?? d.kind} · {Math.max(1, Math.round(d.sizeBytes / 1024))} KB
                <span className="text-xs text-ink-muted">
                  {" · "}
                  {d.resultVersion ? `${d.resultVersion}-versiya` : "buyurtmaga"} · {d.uploadedByName ?? "—"} · {formatDateTime(d.createdAt)}
                </span>
              </span>
              {d.withdrawnAt ? (
                <ABadge tone="gray">Olib tashlangan: {d.withdrawReason}</ABadge>
              ) : (
                <span className="flex gap-1">
                  <AButton size="sm" variant="outline" onClick={() => void open(d.id)}>Ochish</AButton>
                  <AButton size="sm" variant="ghost" onClick={() => { setWithdrawing(d.id); setReason(""); }}>Olib tashlash</AButton>
                </span>
              )}
              {withdrawing === d.id && (
                <div className="flex w-full flex-col gap-2">
                  <ATextArea value={reason} onChange={setReason} rows={2} placeholder="Sabab (masalan: boshqa bemorning fayli)" aria-label="Olib tashlash sababi" />
                  <div className="flex gap-2">
                    <AButton size="sm" variant="danger" disabled={!reason.trim()} onClick={() => void confirmWithdraw(d.id)}>Olib tashlash</AButton>
                    <AButton size="sm" variant="ghost" onClick={() => setWithdrawing(null)}>Bekor qilish</AButton>
                  </div>
                  <p className="text-xs text-ink-muted">Fayl o‘chirilmaydi: u saqlanib qoladi, lekin endi ko‘rsatilmaydi.</p>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {canUpload ? (
        <div className="flex flex-wrap items-center gap-2">
          <div className="w-44">
            <ASelect
              value={kind}
              onChange={setKind}
              options={Object.entries(KIND).map(([value, label]) => ({ value, label }))}
              aria-label="Hujjat turi"
            />
          </div>
          <input
            ref={fileInput}
            type="file"
            accept="application/pdf,image/jpeg,image/png,image/webp"
            className="hidden"
            aria-label="Fayl tanlash"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void upload(file);
            }}
          />
          <AButton size="sm" variant="outline" loading={busy} onClick={() => fileInput.current?.click()}>
            <Upload className="h-4 w-4" /> Fayl biriktirish
          </AButton>
          <span className="text-xs text-ink-muted">PDF, JPEG, PNG yoki WebP · {MAX_MB} MB gacha</span>
        </div>
      ) : (
        <p className="text-xs text-ink-muted">Tasdiqlangan natijaga fayl qo‘shilmaydi — kerak bo‘lsa tuzatish (yangi versiya) bilan biriktiring.</p>
      )}
    </div>
  );
}

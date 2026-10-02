"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { PageHeader, Card, ABadge, AError, AButton, AInput, ASelect, ATextArea, AModal, LoadingRow } from "@/components/admin/ui";
import { adminApi, AdminApiError, formatDateTime } from "@/lib/admin/client";
import { DOCUMENT_KIND_LABELS, formatBytes } from "@/components/lab/flags";
import type { ResultDetail, ValueView, ParameterView } from "@/lib/labs/results";

const FLAGS: Record<string, { label: string; tone: "green" | "amber" | "red" | "gray" }> = {
  normal: { label: "Me‘yorda", tone: "green" },
  low: { label: "Me‘yordan past", tone: "amber" },
  high: { label: "Me‘yordan yuqori", tone: "amber" },
  critical_low: { label: "Kritik past", tone: "red" },
  critical_high: { label: "Kritik yuqori", tone: "red" },
  unclassified: { label: "Me‘yor belgilanmagan", tone: "gray" },
};
const VERSION_LABELS: Record<string, string> = { draft: "Qoralama", pending_verification: "Tasdiq kutmoqda", verified: "Tasdiqlangan", superseded: "Almashtirilgan", cancelled: "Bekor qilingan" };

const rangeText = (p: ParameterView["range"]) => {
  if (!p) return "Me‘yor belgilanmagan";
  const parts = [p.low !== null || p.high !== null ? `${p.low ?? "…"} – ${p.high ?? "…"}` : null, p.criticalLow !== null ? `kritik < ${p.criticalLow}` : null, p.criticalHigh !== null ? `kritik > ${p.criticalHigh}` : null];
  return `Me‘yor: ${parts.filter(Boolean).join("; ")}`;
};

function ValueTable({ values }: { values: ValueView[] }) {
  return (
    <ul className="divide-y divide-hairline/70 rounded-lg border border-hairline">
      {values.map((v) => (
        <li key={v.parameterId} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
          <span className="text-foreground">{v.name}</span>
          <span className="flex items-center gap-2">
            <span className="font-numeric font-medium text-foreground">
              {v.comparator ?? ""}{v.value} {v.unit ?? ""}
            </span>
            <span className="text-xs text-ink-muted">
              {v.refLow !== null || v.refHigh !== null ? `(${v.refLow ?? "…"} – ${v.refHigh ?? "…"})` : ""}
            </span>
            <ABadge tone={FLAGS[v.flag]?.tone ?? "gray"}>{FLAGS[v.flag]?.label ?? v.flag}</ABadge>
          </span>
        </li>
      ))}
    </ul>
  );
}

/**
 * One ordered test's result: enter (the author), submit, verify, return, and correct. The configured parameters and
 * ranges come from the server; the flag shown is the database's comparison with the configured range ("outside the
 * configured reference range") — never an interpretation. Every button only asks; a refusal is shown as it is.
 */
export default function LabResultPage() {
  const { itemId } = useParams<{ itemId: string }>();
  const [detail, setDetail] = useState<ResultDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [correcting, setCorrecting] = useState(false);
  const [reason, setReason] = useState("");
  const [abandoning, setAbandoning] = useState(false);
  const [docKind, setDocKind] = useState("report");
  const [docFile, setDocFile] = useState<File | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await adminApi.get<{ detail: ResultDetail }>(`/api/lab/results/${itemId}`);
      setDetail(res.detail);
      setForm(Object.fromEntries((res.detail.working?.values ?? []).map((v) => [v.parameterId, String(v.value)])));
    } catch (e) {
      setError(e instanceof AdminApiError ? e.message : "Natijani yuklab bo‘lmadi");
    }
  }, [itemId]);

  useEffect(() => {
    void load();
  }, [load]);

  const run = async (key: string, call: () => Promise<string | void>) => {
    setBusy(key);
    setError(null);
    setNotice(null);
    try {
      const message = await call();
      if (message) setNotice(message);
    } catch (e) {
      setError(e instanceof AdminApiError ? e.message : "Amalni bajarib bo‘lmadi");
    } finally {
      await load();
      setBusy(null);
    }
  };

  if (!detail) return error ? <AError message={error} /> : <LoadingRow />;
  const { working, verified } = detail;
  const editable = detail.canEnter;
  const filled = detail.parameters.every((p) => (form[p.id] ?? "").trim() !== "");

  const save = () =>
    run("save", async () => {
      await adminApi.put(`/api/lab/results/${itemId}`, {
        values: detail.parameters.filter((p) => (form[p.id] ?? "").trim() !== "").map((p) => ({ parameterId: p.id, value: form[p.id].trim() })),
      });
      return "Qoralama saqlandi.";
    });
  const step = (versionId: string, action: "submit" | "verify" | "return" | "take_over", message: string) =>
    run(action, async () => {
      await adminApi.post(`/api/lab/results/versions/${versionId}`, { action });
      return message;
    });

  const upload = () =>
    run("upload", async () => {
      if (!docFile) return;
      const body = new FormData();
      body.set("file", docFile);
      body.set("kind", docKind);
      const res = await fetch(`/api/lab/results/${itemId}/documents`, { method: "POST", body });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new AdminApiError(res.status, json?.error ?? "Hujjatni yuklab bo‘lmadi", json?.code);
      setDocFile(null);
      return "Hujjat qo‘shildi.";
    });

  return (
    <div>
      <PageHeader title={detail.item.testName} subtitle={`${detail.item.patientName ?? "—"} · ${detail.item.testCode}`} action={<Link href="/lab/results" className="text-sm font-medium text-pine hover:underline">← Natijalar</Link>} />
      {error && <AError message={error} />}
      {notice && <p className="mb-3 text-sm text-pine-deep" role="status">{notice}</p>}
      <p className="mb-3 text-xs text-ink-muted">Belgi faqat sozlangan me‘yor bilan solishtirish natijasi (“belgilangan me‘yordan tashqarida”); bu tashxis emas.</p>

      {working && (
        <Card>
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-bold text-foreground">
              Versiya {working.version} · {VERSION_LABELS[working.status]}
              {working.correctsVersion ? ` (${working.correctsVersion}-versiyani tuzatadi)` : ""}
            </p>
            <p className="text-xs text-ink-muted">
              Kiritgan: {working.enteredBy.name ?? "—"} · {formatDateTime(working.enteredAt)}
            </p>
          </div>
          {working.correctionReason && <p className="mb-3 text-sm text-ink-muted">Tuzatish sababi: {working.correctionReason}</p>}
          {working.orphaned && (
            <div className="mb-3 rounded-lg border border-clay/40 bg-clay-tint p-3 text-sm text-clay-deep" role="status">
              <p className="font-medium">Bu qoralamaning egasi endi laboratoriyada faol emas.</p>
              <p className="mt-1">Muallif ({working.enteredBy.name ?? "—"}) va yaratilgan vaqt saqlanadi; qoralamani olsangiz, yangi egasi va vaqti qayd etiladi.</p>
              <div className="mt-2 flex flex-wrap gap-2">
                {working.canTakeOver && (
                  <AButton size="sm" loading={busy === "take_over"} onClick={() => void step(working.id, "take_over", "Qoralama sizga o‘tdi.")}>
                    Qoralamani olish
                  </AButton>
                )}
              </div>
            </div>
          )}

          {working.status === "draft" && editable && working.mine ? (
            <div className="flex flex-col gap-3">
              {detail.parameters.map((p) => (
                <div key={p.id} className="grid gap-1 sm:grid-cols-[1fr_2fr] sm:items-center">
                  <label className="text-sm text-foreground" htmlFor={`p-${p.id}`}>
                    {p.name} {p.unit ? <span className="text-xs text-ink-muted">({p.unit})</span> : null}
                    <span className="block text-xs text-ink-muted">{p.dataType === "numeric" ? rangeText(p.range) : ""}</span>
                  </label>
                  {p.dataType === "choice" ? (
                    <ASelect value={form[p.id] ?? ""} onChange={(v) => setForm({ ...form, [p.id]: v })} options={[{ value: "", label: "Tanlang" }, ...(p.choices ?? []).map((c) => ({ value: c, label: c }))]} aria-label={p.name} />
                  ) : (
                    <AInput value={form[p.id] ?? ""} onChange={(v) => setForm({ ...form, [p.id]: v })} aria-label={p.name} />
                  )}
                </div>
              ))}
              <div className="flex flex-wrap gap-2">
                <AButton loading={busy === "save"} disabled={!detail.parameters.some((p) => (form[p.id] ?? "").trim() !== "")} onClick={() => void save()}>
                  Qoralamani saqlash
                </AButton>
                <AButton variant="outline" disabled={!filled || !working.canSubmit} loading={busy === "submit"} onClick={() => void save().then(() => step(working.id, "submit", detail.settings.verificationRequired ? "Tekshiruvga yuborildi." : "Natija yakunlandi."))}>
                  {detail.settings.verificationRequired ? "Tekshiruvga yuborish" : "Yakunlash"}
                </AButton>
              </div>
              {working.values.length > 0 && <ValueTable values={working.values} />}
            </div>
          ) : (
            <>
              <ValueTable values={working.values} />
              {working.status === "draft" && !working.mine && <p className="mt-2 text-sm text-ink-muted">Bu qoralama boshqa xodimniki — uni faqat muallifi tahrirlaydi.</p>}
              {working.status === "pending_verification" && (
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <AButton disabled={!working.canVerify} loading={busy === "verify"} onClick={() => void step(working.id, "verify", "Natija tasdiqlandi.")}>
                    Tasdiqlash
                  </AButton>
                  <AButton variant="outline" disabled={!working.canReturn} loading={busy === "return"} onClick={() => void step(working.id, "return", "Qoralamaga qaytarildi.")}>
                    Qoralamaga qaytarish
                  </AButton>
                  {!working.canVerify && detail.settings.separateVerifier && <p className="text-sm text-ink-muted">Natijani kiritgan xodimdan boshqa xodim tasdiqlashi kerak.</p>}
                </div>
              )}
            </>
          )}
          {working.canAbandon && (
            <div className="mt-3 border-t border-hairline pt-3">
              <AButton size="sm" variant="ghost" onClick={() => { setReason(""); setAbandoning(true); }}>
                Qoralamani bekor qilish
              </AButton>
              <span className="ml-2 text-xs text-ink-muted">O‘chirilmaydi: sabab bilan bekor qilingan deb qoladi.</span>
            </div>
          )}
        </Card>
      )}

      {!working && detail.canEnter && (
        <Card>
          <p className="mb-3 text-sm text-ink-muted">Natija hali kiritilmagan.</p>
          <div className="flex flex-col gap-3">
            {detail.parameters.map((p) => (
              <div key={p.id} className="grid gap-1 sm:grid-cols-[1fr_2fr] sm:items-center">
                <label className="text-sm text-foreground" htmlFor={`p-${p.id}`}>
                  {p.name} {p.unit ? <span className="text-xs text-ink-muted">({p.unit})</span> : null}
                  <span className="block text-xs text-ink-muted">{p.dataType === "numeric" ? rangeText(p.range) : ""}</span>
                </label>
                {p.dataType === "choice" ? (
                  <ASelect value={form[p.id] ?? ""} onChange={(v) => setForm({ ...form, [p.id]: v })} options={[{ value: "", label: "Tanlang" }, ...(p.choices ?? []).map((c) => ({ value: c, label: c }))]} aria-label={p.name} />
                ) : (
                  <AInput value={form[p.id] ?? ""} onChange={(v) => setForm({ ...form, [p.id]: v })} aria-label={p.name} />
                )}
              </div>
            ))}
            <div>
              <AButton loading={busy === "save"} disabled={!detail.parameters.some((p) => (form[p.id] ?? "").trim() !== "")} onClick={() => void save()}>
                Qoralamani saqlash
              </AButton>
            </div>
          </div>
        </Card>
      )}
      {!working && !verified && !detail.canEnter && <Card><p className="text-sm text-ink-muted">Natija kiritish uchun namuna olingan bo‘lishi kerak.</p></Card>}

      {verified && (
        <div className="mt-4">
          <Card>
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm font-bold text-foreground">Tasdiqlangan natija · versiya {verified.version}</p>
              <p className="text-xs text-ink-muted">
                Kiritgan: {verified.enteredBy.name ?? "—"} · Tasdiqlagan: {verified.verifiedBy?.name ?? "—"} · {verified.verifiedAt ? formatDateTime(verified.verifiedAt) : ""}
              </p>
            </div>
            <ValueTable values={verified.values} />
            {detail.canCorrect && (
              <div className="mt-3">
                <AButton variant="outline" onClick={() => { setReason(""); setCorrecting(true); }}>
                  Tuzatish kiritish
                </AButton>
              </div>
            )}
          </Card>
        </div>
      )}

      {detail.history.length > 1 && (
        <div className="mt-4">
          <p className="mb-2 text-sm font-bold text-foreground">Versiyalar tarixi</p>
          <ul className="divide-y divide-hairline/70 rounded-lg border border-hairline text-sm">
            {detail.history.map((h) => (
              <li key={h.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
                <span>
                  Versiya {h.version} · {VERSION_LABELS[h.status]}
                  {h.correctsVersion ? ` · ${h.correctsVersion}-versiyani tuzatadi` : ""}
                  {h.correctionReason ? ` · sabab: ${h.correctionReason}` : ""}
                  {h.cancelledAt ? ` · bekor qilgan: ${h.cancelledBy?.name ?? "—"}, ${formatDateTime(h.cancelledAt)}, sabab: ${h.cancellationReason ?? ""}` : ""}
                </span>
                <span className="text-xs text-ink-muted">
                  {h.enteredBy.name ?? "—"} · {formatDateTime(h.enteredAt)}
                  {h.verifiedBy ? ` → ${h.verifiedBy.name ?? "—"} · ${h.verifiedAt ? formatDateTime(h.verifiedAt) : ""}` : ""}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {(detail.documents.length > 0 || detail.canAttach) && (
        <div className="mt-4">
          <p className="mb-2 text-sm font-bold text-foreground">Hujjatlar</p>
          <Card>
            {detail.documents.length > 0 && (
              <ul className="mb-3 divide-y divide-hairline/70 text-sm">
                {detail.documents.map((d) => (
                  <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                    <span>
                      {DOCUMENT_KIND_LABELS[d.kind] ?? d.kind} · {formatBytes(d.sizeBytes)} · {d.uploadedBy ?? "—"} · {formatDateTime(d.addedAt)}
                    </span>
                    <a href={`/api/lab/documents/${d.id}`} target="_blank" rel="noopener noreferrer" className="font-medium text-pine hover:underline">
                      Ochish
                    </a>
                  </li>
                ))}
              </ul>
            )}
            {detail.canAttach ? (
              <div className="flex flex-wrap items-end gap-2">
                <div className="w-48">
                  <p className="mb-1 text-xs font-medium text-ink-muted">Hujjat turi</p>
                  <ASelect value={docKind} onChange={setDocKind} options={Object.entries(DOCUMENT_KIND_LABELS).map(([value, label]) => ({ value, label }))} aria-label="Hujjat turi" />
                </div>
                <div>
                  <p className="mb-1 text-xs font-medium text-ink-muted">Fayl (PDF, PNG, JPEG · 10 MB gacha)</p>
                  <input type="file" accept="application/pdf,image/png,image/jpeg" aria-label="Hujjat fayli" onChange={(e) => setDocFile(e.target.files?.[0] ?? null)} className="text-sm" />
                </div>
                <AButton disabled={!docFile} loading={busy === "upload"} onClick={() => void upload()}>
                  Yuklash
                </AButton>
              </div>
            ) : (
              <p className="text-xs text-ink-muted">Tasdiqlangan natijaga hujjat qo‘shish uchun avval tuzatish kiriting.</p>
            )}
          </Card>
        </div>
      )}

      {detail.events.length > 0 && (
        <div className="mt-4">
          <p className="mb-2 text-sm font-bold text-foreground">Qoralama harakatlari</p>
          <ul className="divide-y divide-hairline/70 rounded-lg border border-hairline text-sm">
            {detail.events.map((e, i) => (
              <li key={i} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
                <span>
                  Versiya {e.version} · {e.kind === "takeover" ? `qoralama ${e.from?.name ?? "—"} dan ${e.by.name ?? "—"} ga o‘tdi` : `${e.by.name ?? "—"} bekor qildi (egasi: ${e.from?.name ?? "—"})`}
                </span>
                <span className="text-xs text-ink-muted">{formatDateTime(e.at)}{e.reason ? ` · sabab: ${e.reason}` : ""}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {abandoning && working && (
        <AModal
          title="Qoralamani bekor qilish"
          onClose={() => setAbandoning(false)}
          footer={
            <>
              <AButton variant="ghost" onClick={() => setAbandoning(false)}>
                Orqaga
              </AButton>
              <AButton
                disabled={reason.trim().length < 3}
                onClick={() => {
                  setAbandoning(false);
                  void run("abandon", async () => {
                    await adminApi.post(`/api/lab/results/versions/${working.id}`, { action: "abandon", reason: reason.trim() });
                    return "Qoralama bekor qilindi (saqlanib qoladi).";
                  });
                }}
              >
                Bekor qilish
              </AButton>
            </>
          }
        >
          <p className="mb-2 text-sm text-ink-muted">Qoralama o‘chirilmaydi: kim, qachon va nima sababdan bekor qilgani saqlanadi, lekin u tasdiqlana olmaydi. Sababni qisqa yozing (kasallik haqida emas).</p>
          <ATextArea value={reason} onChange={setReason} rows={3} aria-label="Bekor qilish sababi" />
        </AModal>
      )}

      {correcting && verified && (
        <AModal
          title="Natijani tuzatish"
          onClose={() => setCorrecting(false)}
          footer={
            <>
              <AButton variant="ghost" onClick={() => setCorrecting(false)}>
                Bekor qilish
              </AButton>
              <AButton
                disabled={reason.trim().length < 3}
                loading={busy === "correct"}
                onClick={() => {
                  setCorrecting(false);
                  void run("correct", async () => {
                    await adminApi.post(`/api/lab/results/${itemId}/correction`, { expectedVersion: verified.version, reason: reason.trim() });
                    return "Tuzatish qoralamasi yaratildi. Eski versiya o‘zgarmaydi.";
                  });
                }}
              >
                Tuzatishni boshlash
              </AButton>
            </>
          }
        >
          <p className="mb-2 text-sm text-ink-muted">Eski versiya saqlanadi; tuzatilgan natija yangi versiya bo‘lib, tasdiqlangach o‘rnini oladi. Sababni qisqa yozing (kasallik haqida emas).</p>
          <ATextArea value={reason} onChange={setReason} rows={3} aria-label="Tuzatish sababi" />
        </AModal>
      )}
    </div>
  );
}

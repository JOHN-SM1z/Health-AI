"use client";

import { useCallback, useEffect, useState } from "react";
import { ABadge, AButton, AError, AInput, ATextArea, Card, PageHeader } from "@/components/admin/ui";
import { adminApi, AdminApiError, formatDateTime } from "@/lib/admin/client";
import {
  DUPLICATE_REASON_LABELS,
  MERGE_BLOCKER_LABELS,
  MERGE_COUNT_LABELS,
  MERGE_FIELD_LABELS,
  MERGE_PLAN_LABELS,
  MERGE_WARNING_LABELS,
} from "@/lib/patients/merge-labels";
import { formatDay } from "@/lib/labs/format-day";
import { ArrowLeftRight } from "lucide-react";

/**
 * Patient merge (Phase 14): review possible duplicates, preview a merge in
 * full, merge with a reason, and undo a merge. A merge links the records;
 * nothing recorded for either is moved, changed or deleted.
 */

/** Name, age and phone — the date of birth and documents stay on the server (owner decision 2026-10-08). */
type Person = { id: string; name: string | null; age: number | null; phone: string | null; telegram?: boolean; createdAt?: string; hasMergedRecords?: boolean };
type Pair = { a: Person; b: Person; reasons: string[] };
type Side = {
  id: string;
  full_name: string | null;
  phone: string | null;
  age: number | null;
  has_date_of_birth: boolean;
  has_sex: boolean;
  has_pinfl: boolean;
  has_document: boolean;
  has_telegram: boolean;
  created_at: string;
  counts: Record<string, number>;
};
type Preview = {
  canonical: Side;
  duplicate: Side;
  plan: Record<string, string>;
  doctors_gaining_access: Array<{ doctor_id: string; name: string; from: string }>;
  blockers: string[];
  warnings: string[];
  fingerprint: string;
};
type Merge = {
  id: string;
  canonical: { name: string | null; age: number | null; phone: string | null } | null;
  duplicate: { name: string | null; age: number | null; phone: string | null } | null;
  reason: string;
  mergedAt: string;
  mergedBy: string | null;
  movedFields: string[];
  copiedFields: string[];
  unmergedAt: string | null;
  unmergedBy: string | null;
  unmergeReason: string | null;
};
type SearchPatient = { id: string; full_name: string | null; phone: string | null };

const err = (e: unknown, fallback: string) => (e instanceof AdminApiError ? e.message : fallback);
const who = (p: { name: string | null; age: number | null; phone?: string | null } | null) =>
  p ? [p.name ?? "—", p.age !== null ? `${p.age} yosh` : null, p.phone ?? null].filter(Boolean).join(" · ") : "—";

function PatientPicker({ label, value, onPick }: { label: string; value: SearchPatient | null; onPick: (p: SearchPatient) => void }) {
  const [q, setQ] = useState("");
  const [found, setFound] = useState<SearchPatient[]>([]);
  useEffect(() => {
    if (q.trim().length < 2) return;
    const t = setTimeout(async () => {
      try {
        setFound((await adminApi.get<{ patients: SearchPatient[] }>(`/api/admin/patients?q=${encodeURIComponent(q.trim())}`)).patients.slice(0, 8));
      } catch {
        setFound([]);
      }
    }, 250);
    return () => clearTimeout(t);
  }, [q]);
  return (
    <div className="space-y-2" role="group" aria-label={label}>
      <p className="text-sm font-medium">{label}</p>
      {value ? (
        <p className="text-sm">{value.full_name ?? "—"} {value.phone ? `· ${value.phone}` : ""}</p>
      ) : (
        <>
          <AInput value={q} onChange={setQ} placeholder="Ism yoki telefon" aria-label={`${label}: qidirish`} />
          <ul className="space-y-1">
            {q.trim().length >= 2 && found.map((p) => (
              <li key={p.id}>
                <button type="button" className="text-left text-sm text-pine hover:underline" onClick={() => onPick(p)}>
                  {p.full_name ?? "—"} {p.phone ? `· ${p.phone}` : ""}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

export function PatientMerge() {
  const [pairs, setPairs] = useState<Pair[] | null>(null);
  const [merges, setMerges] = useState<Merge[] | null>(null);
  const [canonical, setCanonical] = useState<SearchPatient | null>(null);
  const [duplicate, setDuplicate] = useState<SearchPatient | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [reason, setReason] = useState("");
  const [samePerson, setSamePerson] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [undo, setUndo] = useState<{ id: string; reason: string } | null>(null);

  const loadLists = useCallback(async () => {
    try {
      const [p, m] = await Promise.all([
        adminApi.get<{ pairs: Pair[] }>("/api/admin/patients/duplicates"),
        adminApi.get<{ merges: Merge[] }>("/api/admin/patients/merges"),
      ]);
      setPairs(p.pairs);
      setMerges(m.merges);
    } catch (e) {
      setError(err(e, "Ma’lumotlarni yuklab bo‘lmadi"));
    }
  }, []);
  useEffect(() => {
    void loadLists();
  }, [loadLists]);

  const loadPreview = async (c: string, d: string) => {
    setBusy("preview");
    setError(null);
    setNotice(null);
    setSamePerson(false);
    try {
      setPreview(await adminApi.get<Preview>(`/api/admin/patients/merge?canonical=${c}&duplicate=${d}`));
    } catch (e) {
      setPreview(null);
      setError(err(e, "Ko‘rib chiqib bo‘lmadi"));
    } finally {
      setBusy(null);
    }
  };

  const choose = (c: Person, d: Person) => {
    setCanonical({ id: c.id, full_name: c.name, phone: null });
    setDuplicate({ id: d.id, full_name: d.name, phone: null });
    void loadPreview(c.id, d.id);
  };

  const merge = async () => {
    if (!preview) return;
    setBusy("merge");
    setError(null);
    try {
      await adminApi.post("/api/admin/patients/merge", {
        canonicalId: preview.canonical.id,
        duplicateId: preview.duplicate.id,
        reason,
        fingerprint: preview.fingerprint,
        confirmSamePerson: samePerson,
      });
      setNotice("Kartalar birlashtirildi. Hech bir yozuv o‘chirilmadi yoki o‘zgartirilmadi; kerak bo‘lsa birlashtirishni bekor qilish mumkin.");
      setPreview(null);
      setCanonical(null);
      setDuplicate(null);
      setReason("");
      await loadLists();
    } catch (e) {
      setError(err(e, "Birlashtirib bo‘lmadi"));
    } finally {
      setBusy(null);
    }
  };

  const unmerge = async () => {
    if (!undo) return;
    setBusy("unmerge");
    setError(null);
    try {
      const report = await adminApi.post<{ restored_fields: string[]; left_on_canonical: string[] }>(`/api/admin/patients/merges/${undo.id}`, { action: "unmerge", reason: undo.reason });
      setNotice(
        `Birlashtirish bekor qilindi.${report.restored_fields.length ? ` Qaytarildi: ${report.restored_fields.map((f) => MERGE_FIELD_LABELS[f] ?? f).join(", ")}.` : ""}${report.left_on_canonical.length ? ` O‘zgargani uchun asosiy kartada qoldi: ${report.left_on_canonical.map((f) => MERGE_FIELD_LABELS[f] ?? f).join(", ")}.` : ""}`,
      );
      setUndo(null);
      await loadLists();
    } catch (e) {
      setError(err(e, "Bekor qilib bo‘lmadi"));
    } finally {
      setBusy(null);
    }
  };

  const sideCard = (title: string, s: Side) => (
    <div className="space-y-1 rounded-lg border border-hairline p-3 text-sm">
      <p className="text-xs font-medium uppercase tracking-wide text-ink-muted">{title}</p>
      <p className="font-medium">{s.full_name ?? "—"}</p>
      <p>{[s.age !== null ? `${s.age} yosh` : "tug‘ilgan sana yo‘q", s.phone ?? "telefon yo‘q"].join(" · ")}</p>
      <p className="text-xs text-ink-muted">
        {[s.has_pinfl && "JShShIR", s.has_document && "pasport", s.has_telegram && "Telegram"].filter(Boolean).join(", ") || "identifikator yo‘q"} · yaratilgan {formatDay(s.created_at)}
      </p>
    </div>
  );

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <PageHeader title="Bemor kartalarini birlashtirish" subtitle="Bir odamning ikki kartasi bitta uzluksiz tibbiy tarixga aylanadi. Hech narsa o‘chirilmaydi." />
      {error && <AError message={error} />}
      {notice && <p role="status" className="rounded-lg bg-pine-tint px-3 py-2 text-sm text-pine-deep">{notice}</p>}

      <Card className="space-y-4">
        <h2 className="font-display text-base font-semibold">Ehtimoliy takror kartalar</h2>
        {pairs === null ? null : pairs.length === 0 ? (
          <p className="text-sm text-ink-muted">Takror kartalar topilmadi.</p>
        ) : (
          <ul className="space-y-2" aria-label="Ehtimoliy takror kartalar">
            {pairs.map((p) => (
              <li key={`${p.a.id}-${p.b.id}`} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-hairline p-3 text-sm">
                <div>
                  <p>{who(p.a)} {p.a.telegram ? "(Telegram)" : ""} ↔ {who(p.b)} {p.b.telegram ? "(Telegram)" : ""}</p>
                  <p className="text-xs text-ink-muted">{p.reasons.map((r) => DUPLICATE_REASON_LABELS[r] ?? r).join("; ")}</p>
                </div>
                {/* Suggested canonical: a record others were merged into, else the older one; it can be swapped. */}
                <AButton size="sm" variant="outline" onClick={() => (p.b.hasMergedRecords || (!p.a.hasMergedRecords && p.b.createdAt! < p.a.createdAt!) ? choose(p.b, p.a) : choose(p.a, p.b))}>
                  Ko‘rib chiqish
                </AButton>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card className="space-y-4">
        <h2 className="font-display text-base font-semibold">Birlashtirish</h2>
        <div className="grid gap-4 md:grid-cols-2">
          <PatientPicker label="Asosiy karta (qoladi)" value={canonical} onPick={(p) => { setCanonical(p); setPreview(null); }} />
          <PatientPicker label="Takror karta (asosiyga bog‘lanadi)" value={duplicate} onPick={(p) => { setDuplicate(p); setPreview(null); }} />
        </div>
        <div className="flex flex-wrap gap-2">
          <AButton disabled={!canonical || !duplicate} loading={busy === "preview"} onClick={() => canonical && duplicate && loadPreview(canonical.id, duplicate.id)}>
            Ko‘rib chiqish
          </AButton>
          {canonical && duplicate && (
            <AButton variant="outline" onClick={() => { setCanonical(duplicate); setDuplicate(canonical); void loadPreview(duplicate.id, canonical.id); }}>
              <ArrowLeftRight className="h-4 w-4" /> Almashtirish
            </AButton>
          )}
          {(canonical || duplicate) && (
            <AButton variant="ghost" onClick={() => { setCanonical(null); setDuplicate(null); setPreview(null); }}>
              Tozalash
            </AButton>
          )}
        </div>

        {preview && (
          <section aria-label="Birlashtirish oldidan ko‘rib chiqish" className="space-y-4">
            <div className="grid gap-3 md:grid-cols-2">
              {sideCard("Asosiy karta", preview.canonical)}
              {sideCard("Takror karta", preview.duplicate)}
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="text-xs text-ink-muted">
                  <tr><th className="py-1 pr-3">Ma’lumot</th><th className="py-1 pr-3">Asosiy</th><th className="py-1 pr-3">Takror</th><th className="py-1">Natija</th></tr>
                </thead>
                <tbody>
                  {Object.entries(MERGE_COUNT_LABELS).map(([k, l]) => (
                    <tr key={k} className="border-t border-hairline">
                      <td className="py-1 pr-3">{l}</td>
                      <td className="py-1 pr-3 font-numeric">{preview.canonical.counts[k] ?? 0}</td>
                      <td className="py-1 pr-3 font-numeric">{preview.duplicate.counts[k] ?? 0}</td>
                      <td className="py-1 text-xs text-ink-muted">o‘z kartasida qoladi, birgalikda ko‘rinadi</td>
                    </tr>
                  ))}
                  {Object.entries(preview.plan).map(([field, plan]) => (
                    <tr key={field} className="border-t border-hairline">
                      <td className="py-1 pr-3">{MERGE_FIELD_LABELS[field] ?? field}</td>
                      <td className="py-1 pr-3" colSpan={2}></td>
                      <td className="py-1 text-xs">{MERGE_PLAN_LABELS[plan] ?? plan}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {preview.blockers.length > 0 && (
              <div className="rounded-lg border border-danger/40 p-3" role="alert" aria-label="To‘siqlar">
                <p className="text-sm font-medium text-danger">Birlashtirib bo‘lmaydi:</p>
                <ul className="list-disc pl-5 text-sm text-danger">
                  {preview.blockers.map((b) => <li key={b}>{MERGE_BLOCKER_LABELS[b] ?? b}</li>)}
                </ul>
              </div>
            )}
            {preview.warnings.length > 0 && (
              <div className="rounded-lg border border-hairline bg-sand p-3" aria-label="Ogohlantirishlar">
                <ul className="list-disc pl-5 text-sm">
                  {preview.warnings.map((w) => <li key={w}>{MERGE_WARNING_LABELS[w] ?? w}</li>)}
                </ul>
                {preview.doctors_gaining_access.length > 0 && (
                  <p className="mt-1 text-sm">Shifokorlar: {preview.doctors_gaining_access.map((d) => d.name).join(", ")}</p>
                )}
              </div>
            )}

            {preview.blockers.length === 0 && (
              <div className="space-y-3">
                <ATextArea value={reason} onChange={setReason} placeholder="Sabab (masalan: qabulxonada va Telegramda ochilgan bir odamning kartalari; pasport bilan tekshirildi)" aria-label="Birlashtirish sababi" />
                <label className="flex items-start gap-2 text-sm">
                  <input type="checkbox" checked={samePerson} onChange={(e) => setSamePerson(e.target.checked)} />
                  <span>Bu bir odam ekanini hujjat bo‘yicha tekshirdim. Takror karta asosiyga bog‘lanadi; uning yozuvlari o‘zgarmaydi.</span>
                </label>
                <AButton variant="danger" disabled={!samePerson || reason.trim().length < 3} loading={busy === "merge"} onClick={merge}>
                  Birlashtirish
                </AButton>
              </div>
            )}
          </section>
        )}
      </Card>

      <Card className="space-y-3">
        <h2 className="font-display text-base font-semibold">Birlashtirishlar jurnali</h2>
        {merges === null ? null : merges.length === 0 ? (
          <p className="text-sm text-ink-muted">Hali birlashtirish yo‘q.</p>
        ) : (
          <ul className="space-y-2" aria-label="Birlashtirishlar jurnali">
            {merges.map((m) => (
              <li key={m.id} className="space-y-1 rounded-lg border border-hairline p-3 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p>{who(m.duplicate)} → {who(m.canonical)}</p>
                  {m.unmergedAt ? <ABadge tone="gray">Bekor qilingan</ABadge> : <ABadge tone="green">Faol</ABadge>}
                </div>
                <p className="text-xs text-ink-muted">
                  {formatDateTime(m.mergedAt)} · {m.mergedBy ?? "—"} · {m.reason}
                  {m.movedFields.length ? ` · ko‘chirildi: ${m.movedFields.map((f) => MERGE_FIELD_LABELS[f] ?? f).join(", ")}` : ""}
                  {m.copiedFields.length ? ` · nusxa: ${m.copiedFields.map((f) => MERGE_FIELD_LABELS[f === "consent_given" ? "consent" : f] ?? f).join(", ")}` : ""}
                </p>
                {m.unmergedAt && <p className="text-xs text-ink-muted">Bekor qilindi: {formatDateTime(m.unmergedAt)} · {m.unmergedBy ?? "—"} · {m.unmergeReason}</p>}
                {!m.unmergedAt && (undo?.id === m.id ? (
                  <div className="space-y-2">
                    <ATextArea value={undo.reason} onChange={(v) => setUndo({ id: m.id, reason: v })} placeholder="Bekor qilish sababi" aria-label="Bekor qilish sababi" />
                    <AButton size="sm" variant="danger" disabled={undo.reason.trim().length < 3} loading={busy === "unmerge"} onClick={unmerge}>Bekor qilishni tasdiqlash</AButton>
                  </div>
                ) : (
                  <AButton size="sm" variant="outline" onClick={() => setUndo({ id: m.id, reason: "" })}>Bekor qilish</AButton>
                ))}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

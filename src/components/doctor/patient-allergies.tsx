"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle } from "lucide-react";
import { ABadge, AButton, AError, AInput, ASelect, Card } from "@/components/admin/ui";
import { adminApi, AdminApiError, formatDateTime } from "@/lib/admin/client";
import { newIdempotencyKey } from "@/lib/idempotency-key";
import {
  ALLERGY_KINDS,
  ALLERGY_KIND_LABELS,
  ALLERGY_SEVERITIES,
  ALLERGY_SEVERITY_LABELS,
  type AllergyKind,
  type AllergySeverity,
} from "@/lib/prescribing/options";

export type Allergy = {
  id: string;
  substance: string;
  substanceKind: AllergyKind;
  drugId: string | null;
  reaction: string | null;
  severity: AllergySeverity;
  recordedAt: string;
  recordedBy: { doctorId: string; name: string | null };
  mine: boolean;
  active: boolean;
  inactiveAt: string | null;
  inactiveReason: string | null;
};

const SEVERITY_TONES: Record<AllergySeverity, "red" | "amber" | "neutral"> = {
  severe: "red",
  moderate: "amber",
  mild: "amber",
  unknown: "neutral",
};

/**
 * The allergies on the patient card, shown at the top of every visit
 * (specification DW-03). Recorded by the doctor; a recorded allergy is never
 * edited — it is marked inactive with a reason and a new one is written. The
 * list is also what the prescription's allergy warning is matched against.
 */
export function PatientAllergies({ patientId, onLoaded }: { patientId: string; onLoaded?: (allergies: Allergy[]) => void }) {
  const [allergies, setAllergies] = useState<Allergy[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [saving, setSaving] = useState(false);
  const [substance, setSubstance] = useState("");
  const [kind, setKind] = useState<AllergyKind>("inn");
  const [reaction, setReaction] = useState("");
  const [severity, setSeverity] = useState<AllergySeverity>("unknown");
  const [key, setKey] = useState(newIdempotencyKey);
  const [retiring, setRetiring] = useState<string | null>(null);
  const [retireReason, setRetireReason] = useState("");
  const [showHistory, setShowHistory] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await adminApi.get<{ allergies: Allergy[] }>(`/api/doctor/patients/${patientId}/allergies`);
      setAllergies(res.allergies);
      onLoaded?.(res.allergies);
      setError(null);
    } catch (e) {
      // Never "no allergies" on a failed load: the doctor must see that the list is unknown.
      setAllergies(null);
      setError(e instanceof AdminApiError ? e.message : "Allergiyalarni yuklab bo‘lmadi");
    }
  }, [patientId, onLoaded]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async () => {
    if (!substance.trim() || saving) return;
    setSaving(true);
    setError(null);
    try {
      await adminApi.post(`/api/doctor/patients/${patientId}/allergies`, {
        idempotencyKey: key,
        substance: substance.trim(),
        substanceKind: kind,
        reaction: reaction.trim() || undefined,
        severity,
      });
      setSubstance("");
      setReaction("");
      setSeverity("unknown");
      setKind("inn");
      setKey(newIdempotencyKey());
      setAdding(false);
      await load();
    } catch (e) {
      setError(e instanceof AdminApiError ? e.message : "Allergiyani saqlab bo‘lmadi");
    } finally {
      setSaving(false);
    }
  };

  const retire = async (id: string) => {
    if (retireReason.trim().length < 3 || saving) return;
    setSaving(true);
    setError(null);
    try {
      await adminApi.patch(`/api/doctor/patients/${patientId}/allergies/${id}`, { reason: retireReason.trim() });
      setRetiring(null);
      setRetireReason("");
      await load();
    } catch (e) {
      setError(e instanceof AdminApiError ? e.message : "Allergiyani o‘zgartirib bo‘lmadi");
    } finally {
      setSaving(false);
    }
  };

  const active = allergies?.filter((a) => a.active) ?? [];
  const inactive = allergies?.filter((a) => !a.active) ?? [];

  return (
    <Card className={`mb-6 ${active.length > 0 ? "border-danger/40" : ""}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
          <AlertTriangle className={`h-4 w-4 ${active.length > 0 ? "text-danger" : "text-ink-muted"}`} aria-hidden />
          Allergiyalar
        </p>
        {!adding && (
          <AButton variant="outline" size="sm" onClick={() => setAdding(true)}>
            + Allergiya qo‘shish
          </AButton>
        )}
      </div>

      {error && (
        <div className="mt-2">
          <AError message={error} />
        </div>
      )}

      {allergies === null && !error && <p className="mt-2 text-sm text-ink-muted">Yuklanmoqda…</p>}
      {allergies !== null && active.length === 0 && <p className="mt-2 text-sm text-ink-muted">Qayd etilgan allergiya yo‘q.</p>}

      {active.length > 0 && (
        <ul className="mt-3 flex flex-col gap-2" aria-label="Faol allergiyalar">
          {active.map((a) => (
            <li key={a.id} className="rounded-lg bg-danger-tint/40 px-3 py-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm text-foreground">
                  <span className="font-semibold">{a.substance}</span>{" "}
                  <ABadge tone={SEVERITY_TONES[a.severity]}>{ALLERGY_SEVERITY_LABELS[a.severity]}</ABadge>
                  {a.reaction && <span className="ml-1 text-ink-muted">— {a.reaction}</span>}
                </p>
                {retiring !== a.id && (
                  <button type="button" className="text-xs font-medium text-pine hover:underline" onClick={() => setRetiring(a.id)}>
                    Faol emas deb belgilash
                  </button>
                )}
              </div>
              <p className="mt-0.5 text-xs text-ink-muted">
                {ALLERGY_KIND_LABELS[a.substanceKind]} · {a.mine ? "Siz" : (a.recordedBy.name ?? "—")} · {formatDateTime(a.recordedAt)}
              </p>
              {retiring === a.id && (
                <div className="mt-2 flex flex-wrap items-end gap-2">
                  <div className="min-w-56 flex-1">
                    <p className="mb-1 text-xs font-medium text-ink-muted">Sababi (yozuv o‘chirilmaydi, tarixda qoladi)</p>
                    <AInput value={retireReason} onChange={setRetireReason} aria-label="Faol emas deb belgilash sababi" maxLength={300} />
                  </div>
                  <AButton size="sm" loading={saving} disabled={retireReason.trim().length < 3} onClick={() => void retire(a.id)}>
                    Tasdiqlash
                  </AButton>
                  <AButton
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setRetiring(null);
                      setRetireReason("");
                    }}
                  >
                    Bekor
                  </AButton>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {adding && (
        <div className="mt-3 grid gap-3 sm:grid-cols-2" aria-label="Yangi allergiya">
          <div className="sm:col-span-2">
            <p className="mb-1 text-xs font-medium text-ink-muted">Modda yoki dorilar guruhi (bemor yoki hujjat bo‘yicha)</p>
            <AInput value={substance} onChange={setSubstance} aria-label="Allergiya chaqiruvchi modda" maxLength={160} placeholder="Masalan: penitsillin" />
          </div>
          <div>
            <p className="mb-1 text-xs font-medium text-ink-muted">Turi</p>
            <ASelect
              value={kind}
              onChange={(v) => setKind(v as AllergyKind)}
              options={ALLERGY_KINDS.map((k) => ({ value: k, label: ALLERGY_KIND_LABELS[k] }))}
              aria-label="Allergiya turi"
            />
          </div>
          <div>
            <p className="mb-1 text-xs font-medium text-ink-muted">Og‘irligi (qayd etilganidek)</p>
            <ASelect
              value={severity}
              onChange={(v) => setSeverity(v as AllergySeverity)}
              options={ALLERGY_SEVERITIES.map((s) => ({ value: s, label: ALLERGY_SEVERITY_LABELS[s] }))}
              aria-label="Allergiya og‘irligi"
            />
          </div>
          <div className="sm:col-span-2">
            <p className="mb-1 text-xs font-medium text-ink-muted">Reaksiya (ixtiyoriy)</p>
            <AInput value={reaction} onChange={setReaction} aria-label="Reaksiya" maxLength={300} placeholder="Masalan: toshma, nafas qisishi" />
          </div>
          <div className="flex gap-2 sm:col-span-2">
            <AButton loading={saving} disabled={!substance.trim()} onClick={() => void save()}>
              Saqlash
            </AButton>
            <AButton variant="ghost" disabled={saving} onClick={() => setAdding(false)}>
              Bekor qilish
            </AButton>
          </div>
        </div>
      )}

      {inactive.length > 0 && (
        <div className="mt-3">
          <button type="button" className="text-xs font-medium text-pine hover:underline" onClick={() => setShowHistory((v) => !v)}>
            {showHistory ? "Tarixni yashirish" : `Faol bo‘lmagan yozuvlar (${inactive.length})`}
          </button>
          {showHistory && (
            <ul className="mt-2 flex flex-col gap-1">
              {inactive.map((a) => (
                <li key={a.id} className="text-xs text-ink-muted">
                  <span className="line-through">{a.substance}</span> — {a.inactiveReason}
                  {a.inactiveAt ? ` (${formatDateTime(a.inactiveAt)})` : ""}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Card>
  );
}

"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ABadge, AButton, AError, AInput, ASelect, LoadingRow } from "@/components/admin/ui";
import { adminApi, AdminApiError, formatDateTime } from "@/lib/admin/client";
import { newIdempotencyKey } from "@/lib/idempotency-key";
import { SearchPicker } from "@/components/doctor/search-picker";
import type { Allergy } from "@/components/doctor/patient-allergies";
import {
  DOSE_UNITS,
  FREQUENCY_CHIPS,
  MAX_PRESCRIPTION_ITEMS,
  PRESCRIPTION_STATUS_LABELS,
  ROUTES,
  TIMINGS,
  TIMING_LABELS,
  courseQuantity,
  drugLabel,
  type Timing,
} from "@/lib/prescribing/options";

type Drug = {
  id: string;
  inn: string;
  innLatin: string | null;
  tradeName: string | null;
  form: string | null;
  strength: string | null;
  rxOnly: boolean;
  controlled: boolean;
  inFormulary: boolean;
  recent: boolean;
};

type Item = {
  id: string;
  position: number;
  drugId: string;
  inn: string;
  tradeName: string | null;
  form: string | null;
  strength: string | null;
  rxOnly: boolean;
  dose: number;
  doseUnit: string;
  route: string;
  frequency: string;
  timing: Timing;
  days: number;
  quantity: number;
  instructions: string | null;
  allergyOverrideReason: string | null;
};

type Prescription = {
  id: string;
  status: "draft" | "signed" | "replaced" | "cancelled";
  appointmentId: string;
  createdAt: string;
  signedAt: string | null;
  author: { id: string; name: string | null };
  mine: boolean;
  replacesId: string | null;
  replaceReason: string | null;
  replacedById: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  nationalRxNumber: string | null;
  nationalRxRequired: boolean;
  items: Item[];
};

type Catalogue = {
  sources: Array<{ source: string; version: string; importedAt: string }>;
  clinicEntries: number;
};

type TemplateItem = {
  drugId: string;
  dose: number;
  doseUnit: string;
  route: string;
  frequency: string;
  timing: Timing;
  days: number;
  quantity: number;
  instructions?: string;
  inn: string | null;
  tradeName: string | null;
  form: string | null;
  strength: string | null;
  rxOnly: boolean;
  available: boolean;
};

type Template = { id: string; name: string; items: TemplateItem[] };

/** One medicine being written: everything but the medicine itself is the doctor's own entry. */
type Line = {
  key: string;
  drugId: string;
  label: string;
  rxOnly: boolean;
  dose: string;
  doseUnit: string;
  route: string;
  frequency: string;
  timing: Timing;
  days: string;
  quantity: string;
  /** The doctor typed the quantity: it is no longer recalculated. */
  quantityEdited: boolean;
  instructions: string;
  allergyOverrideReason: string;
};

const STATUS_TONES: Record<Prescription["status"], "amber" | "green" | "gray" | "red"> = {
  draft: "amber",
  signed: "green",
  replaced: "gray",
  cancelled: "red",
};

const toNumber = (value: string) => Number(value.replace(",", "."));

function withQuantity(line: Line): Line {
  if (line.quantityEdited) return line;
  const quantity = courseQuantity(toNumber(line.dose), line.frequency, Number(line.days));
  return { ...line, quantity: quantity === null ? "" : String(quantity) };
}

const lineFromItem = (item: Item | TemplateItem, keepOverride: boolean): Line => ({
  key: newIdempotencyKey(),
  drugId: item.drugId,
  label: drugLabel({ inn: item.inn ?? "—", tradeName: item.tradeName, form: item.form, strength: item.strength }),
  rxOnly: item.rxOnly,
  dose: String(item.dose),
  doseUnit: item.doseUnit,
  route: item.route,
  frequency: item.frequency,
  timing: item.timing,
  days: String(item.days),
  quantity: String(item.quantity),
  quantityEdited: true,
  instructions: item.instructions ?? "",
  allergyOverrideReason: keepOverride && "allergyOverrideReason" in item ? (item.allergyOverrideReason ?? "") : "",
});

/** What the doctor copies into the national Elektron retsept system for one prescription-only item (RX-05). */
const nationalLine = (item: Item) =>
  [
    item.inn,
    [item.form, item.strength].filter(Boolean).join(" "),
    `${item.dose} ${item.doseUnit}, ${item.route}, ${item.frequency}${item.timing === "any" ? "" : `, ${TIMING_LABELS[item.timing].toLowerCase()}`}`,
    `${item.days} kun`,
    `jami ${item.quantity}`,
  ]
    .filter(Boolean)
    .join("; ");

/**
 * The "Retsept" part of the doctor's workspace (specification §9.3): type two
 * letters to find a medicine, fill dose and schedule, sign. Nothing here is
 * suggested by a model — the list is the catalogue, templates and recents are
 * the doctor's own, and the allergy warning is an exact match of recorded
 * data. Controlled medicines cannot be added; prescription-only items are
 * copied by the doctor into the national Elektron retsept system and its
 * number is recorded here. "Imzolandi" is shown only after the server confirmed.
 */
export function PrescriptionWorkspace({
  patientId,
  appointmentId,
  allergies,
}: {
  patientId: string;
  /** The doctor's consultation under way, if any: prescriptions are written only there. */
  appointmentId: string | null;
  /** The patient's allergies as loaded for the header; null while unknown. */
  allergies: Allergy[] | null;
}) {
  const [prescriptions, setPrescriptions] = useState<Prescription[] | null>(null);
  const [catalogue, setCatalogue] = useState<Catalogue | null>(null);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [lines, setLines] = useState<Line[]>([]);
  const [draftId, setDraftId] = useState<string | null>(null);
  const [replacesId, setReplacesId] = useState<string | null>(null);
  const [replaceReason, setReplaceReason] = useState("");
  const [key, setKey] = useState(newIdempotencyKey);
  /** Item position → the allergy rows the server matched; signing is blocked until each has a reason. */
  const [conflicts, setConflicts] = useState<Record<number, string[]>>({});
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [templateName, setTemplateName] = useState("");
  const [cancelling, setCancelling] = useState<string | null>(null);
  const [cancelReason, setCancelReason] = useState("");
  const [nationalNumbers, setNationalNumbers] = useState<Record<string, string>>({});
  const inFlight = useRef(false);

  const load = useCallback(async () => {
    try {
      const res = await adminApi.get<{ prescriptions: Prescription[]; catalogue: Catalogue }>(`/api/doctor/patients/${patientId}/prescriptions`);
      setPrescriptions(res.prescriptions);
      setCatalogue(res.catalogue);
    } catch (e) {
      setPrescriptions(null);
      setError(e instanceof AdminApiError ? e.message : "Retseptlarni yuklab bo‘lmadi");
    }
  }, [patientId]);

  const loadTemplates = useCallback(async () => {
    try {
      const res = await adminApi.get<{ templates: Template[] }>("/api/doctor/prescription-templates");
      setTemplates(res.templates);
    } catch {
      // Templates are a convenience: the screen works without them.
      setTemplates([]);
    }
  }, []);

  useEffect(() => {
    void load();
    void loadTemplates();
  }, [load, loadTemplates]);

  const allergyNames = useMemo(() => new Map((allergies ?? []).map((a) => [a.id, a.substance])), [allergies]);

  const resetComposer = () => {
    setLines([]);
    setDraftId(null);
    setReplacesId(null);
    setReplaceReason("");
    setConflicts({});
    setKey(newIdempotencyKey());
  };

  const addDrug = (drug: Drug) => {
    setNotice(null);
    if (drug.controlled) {
      setError(
        `${drug.inn}: nazoratdagi (giyohvandlik yoki psixotrop) dori Health AI orqali yozilmaydi. Buning uchun maxsus blanka yoki milliy tartib talab qilinadi.`,
      );
      return;
    }
    if (lines.length >= MAX_PRESCRIPTION_ITEMS) {
      setError(`Bitta retseptda ${MAX_PRESCRIPTION_ITEMS} tadan ko‘p dori bo‘lmaydi`);
      return;
    }
    setError(null);
    setLines((current) => [
      ...current,
      {
        key: newIdempotencyKey(),
        drugId: drug.id,
        label: drugLabel(drug),
        rxOnly: drug.rxOnly,
        dose: "",
        doseUnit: "",
        route: "",
        frequency: "",
        timing: "any",
        days: "",
        quantity: "",
        quantityEdited: false,
        instructions: "",
        allergyOverrideReason: "",
      },
    ]);
  };

  const patchLine = (lineKey: string, patch: Partial<Line>) =>
    setLines((current) => current.map((line) => (line.key === lineKey ? withQuantity({ ...line, ...patch }) : line)));

  const removeLine = (lineKey: string) => {
    setLines((current) => current.filter((line) => line.key !== lineKey));
    // Positions shift: the server's list of conflicts no longer points at the right lines.
    setConflicts({});
  };

  /** The request items, or the first thing the doctor still has to fill in. */
  const buildItems = (): { items: unknown[] } | { problem: string } => {
    if (lines.length === 0) return { problem: "Kamida bitta dori qo‘shing" };
    const items = [];
    for (const [index, line] of lines.entries()) {
      const n = index + 1;
      const dose = toNumber(line.dose);
      const days = Number(line.days);
      const quantity = toNumber(line.quantity);
      if (!Number.isFinite(dose) || dose <= 0) return { problem: `${n}-dori: dozani kiriting` };
      if (!line.doseUnit.trim()) return { problem: `${n}-dori: doza birligini tanlang` };
      if (!line.route.trim()) return { problem: `${n}-dori: qabul yo‘lini tanlang` };
      if (!line.frequency.trim()) return { problem: `${n}-dori: qabul tartibini tanlang` };
      if (!Number.isInteger(days) || days < 1 || days > 365) return { problem: `${n}-dori: kunlar sonini kiriting` };
      if (!Number.isFinite(quantity) || quantity <= 0) return { problem: `${n}-dori: umumiy miqdorni kiriting` };
      items.push({
        drugId: line.drugId,
        dose,
        doseUnit: line.doseUnit.trim(),
        route: line.route.trim(),
        frequency: line.frequency.trim(),
        timing: line.timing,
        days,
        quantity,
        instructions: line.instructions.trim() || undefined,
        allergyOverrideReason: line.allergyOverrideReason.trim() || undefined,
      });
    }
    return { items };
  };

  const saveDraft = async (): Promise<string | null> => {
    if (!appointmentId) return null;
    const built = buildItems();
    if ("problem" in built) {
      setError(built.problem);
      return null;
    }
    const res = await adminApi.post<{ prescription: { id: string } }>(`/api/doctor/patients/${patientId}/prescriptions`, {
      idempotencyKey: key,
      appointmentId,
      prescriptionId: draftId ?? undefined,
      replacesId: replacesId ?? undefined,
      items: built.items,
    });
    setDraftId(res.prescription.id);
    return res.prescription.id;
  };

  const run = async (action: () => Promise<void>) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await action();
    } catch (e) {
      if (e instanceof AdminApiError && e.code === "allergy_conflict") {
        const list = (e.details?.conflicts ?? []) as Array<{ position: number; allergyIds: string[] }>;
        setConflicts(Object.fromEntries(list.map((c) => [c.position, c.allergyIds])));
      }
      setError(e instanceof AdminApiError ? e.message : "Amalni bajarib bo‘lmadi");
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  const onSaveDraft = () =>
    run(async () => {
      if ((await saveDraft()) === null) return;
      setNotice("Qoralama saqlandi. Retsept hali imzolanmagan.");
      await load();
    });

  const onSign = () =>
    run(async () => {
      if (replacesId && replaceReason.trim().length < 3) {
        setError("Retseptni almashtirish sababini yozing");
        return;
      }
      const id = await saveDraft();
      if (id === null) return;
      const res = await adminApi.post<{ prescription: { nationalRxRequired: boolean } }>(`/api/doctor/prescriptions/${id}/sign`, {
        replaceReason: replacesId ? replaceReason.trim() : undefined,
      });
      // Only now: the server wrote the record and froze the prescription.
      resetComposer();
      setNotice(
        res.prescription.nationalRxRequired
          ? "Retsept imzolandi. Retsept bilan beriladigan dorilarni «Elektron retsept» tizimida rasmiylashtiring va raqamini shu yerga kiriting."
          : "Retsept imzolandi.",
      );
      await load();
    });

  const onSaveTemplate = () =>
    run(async () => {
      const built = buildItems();
      if ("problem" in built) {
        setError(built.problem);
        return;
      }
      await adminApi.post("/api/doctor/prescription-templates", {
        name: templateName.trim(),
        // The allergy reason belongs to one patient's prescription, never to a template.
        items: (built.items as Array<Record<string, unknown>>).map((item) => {
          const stored = { ...item };
          delete stored.allergyOverrideReason;
          return stored;
        }),
      });
      setTemplateName("");
      setNotice("Shablon saqlandi.");
      await loadTemplates();
    });

  const applyTemplate = (templateId: string) => {
    const template = templates.find((t) => t.id === templateId);
    if (!template) return;
    const usable = template.items.filter((i) => i.available);
    const skipped = template.items.length - usable.length;
    setLines((current) => [...current, ...usable.map((item) => lineFromItem(item, false))].slice(0, MAX_PRESCRIPTION_ITEMS));
    setConflicts({});
    setError(null);
    setNotice(skipped > 0 ? `Shablondagi ${skipped} ta dori endi ro‘yxatda yo‘q yoki nazoratga olingan — qo‘shilmadi.` : null);
  };

  const editDraft = (p: Prescription) => {
    setLines(p.items.map((item) => lineFromItem(item, true)));
    setDraftId(p.id);
    setReplacesId(p.replacesId);
    setReplaceReason("");
    setConflicts({});
    setKey(newIdempotencyKey());
    setError(null);
    setNotice(null);
  };

  const startReplacement = (p: Prescription) => {
    setLines(p.items.map((item) => lineFromItem(item, false)));
    setDraftId(null);
    setReplacesId(p.id);
    setReplaceReason("");
    setConflicts({});
    setKey(newIdempotencyKey());
    setError(null);
    setNotice("Yangi retsept eski retsept o‘rniga yoziladi. Eski retsept o‘zgarmaydi — imzolangandan keyin «Almashtirilgan» deb belgilanadi.");
  };

  const onDeleteDraft = (p: Prescription) =>
    run(async () => {
      await adminApi.del(`/api/doctor/prescriptions/${p.id}`);
      if (draftId === p.id) resetComposer();
      await load();
    });

  const onCancel = (p: Prescription) =>
    run(async () => {
      await adminApi.post(`/api/doctor/prescriptions/${p.id}/cancel`, { reason: cancelReason.trim() });
      setCancelling(null);
      setCancelReason("");
      setNotice("Retsept bekor qilindi.");
      await load();
    });

  const onSaveNationalNumber = (p: Prescription) =>
    run(async () => {
      await adminApi.put(`/api/doctor/prescriptions/${p.id}/national-number`, { number: (nationalNumbers[p.id] ?? "").trim() });
      setNotice("Milliy retsept raqami saqlandi.");
      await load();
    });

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setNotice("Nusxa olindi.");
    } catch {
      setError("Nusxa olib bo‘lmadi — matnni qo‘lda belgilab ko‘chiring.");
    }
  };

  const catalogueEmpty = catalogue !== null && catalogue.sources.length === 0 && catalogue.clinicEntries === 0;

  return (
    <div className="flex flex-col gap-4">
      {error && <AError message={error} />}
      {notice && <p className="rounded-lg bg-pine-tint/60 px-3 py-2 text-sm font-medium text-pine-deep">{notice}</p>}

      {appointmentId ? (
        <div className="flex flex-col gap-3" aria-label="Yangi retsept">
          {replacesId && (
            <div className="rounded-lg border border-clay/40 bg-clay-tint/40 p-3">
              <p className="mb-1 text-xs font-medium text-ink-muted">Almashtirish sababi (majburiy)</p>
              <AInput value={replaceReason} onChange={setReplaceReason} aria-label="Almashtirish sababi" maxLength={300} />
              <button type="button" className="mt-2 text-xs font-medium text-pine hover:underline" onClick={resetComposer}>
                Almashtirishni bekor qilish
              </button>
            </div>
          )}

          {catalogueEmpty && (
            <p className="rounded-lg border border-hairline bg-sand/60 px-3 py-2 text-sm text-ink-muted">
              Dorilar ro‘yxati hali yuklanmagan. Klinika ma’muri «Dorilar ro‘yxati» bo‘limida dorilarni kiritishi yoki rasmiy reyestr yuklanishi kerak.
              Ungacha retseptni «Yangi yozuv» orqali matn ko‘rinishida yozishingiz mumkin.
            </p>
          )}

          <div>
            <p className="mb-1 text-xs font-medium text-ink-muted">+ Dori qo‘shish (kamida 2 ta harf: xalqaro nomi yoki savdo nomi, lotin yoki kirill)</p>
            <SearchPicker<Drug>
              endpoint="/api/doctor/drugs"
              resultKey="drugs"
              itemKey={(d) => d.id}
              onPick={addDrug}
              placeholder="Masalan: an"
              ariaLabel="Dori qidirish"
              emptyText="Bu harflar bilan dori topilmadi"
              renderItem={(d) => (
                <span className="flex flex-wrap items-center gap-1.5">
                  <span className="font-semibold text-foreground">{d.inn}</span>
                  {d.tradeName && <span className="text-ink-muted">· {d.tradeName}</span>}
                  {(d.form || d.strength) && <span className="text-ink-muted">· {[d.form, d.strength].filter(Boolean).join(" ")}</span>}
                  {d.rxOnly && <ABadge tone="blue">Retsept bilan</ABadge>}
                  {d.controlled && <ABadge tone="red">Nazoratdagi</ABadge>}
                  {d.inFormulary && <ABadge tone="green">Klinika ro‘yxati</ABadge>}
                  {d.recent && <ABadge tone="neutral">Yaqinda yozilgan</ABadge>}
                </span>
              )}
            />
          </div>

          {templates.length > 0 && (
            <div>
              <p className="mb-1 text-xs font-medium text-ink-muted">Mening shablonlarim</p>
              <ASelect
                value=""
                onChange={(id) => id && applyTemplate(id)}
                options={[{ value: "", label: "Shablonni tanlang" }, ...templates.map((t) => ({ value: t.id, label: `${t.name} (${t.items.length})` }))]}
                aria-label="Shablon"
              />
            </div>
          )}

          {lines.map((line, index) => {
            const position = index + 1;
            const matched = conflicts[position];
            const chip = (FREQUENCY_CHIPS as readonly string[]).includes(line.frequency);
            return (
              <div key={line.key} className={`rounded-lg border p-3 ${matched ? "border-danger" : "border-hairline"}`} aria-label={`${position}-dori`}>
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <p className="text-sm font-semibold text-foreground">
                    {position}. {line.label} {line.rxOnly && <ABadge tone="blue">Retsept bilan</ABadge>}
                  </p>
                  <button type="button" className="text-xs font-medium text-danger hover:underline" onClick={() => removeLine(line.key)}>
                    Olib tashlash
                  </button>
                </div>

                {matched && (
                  <div className="mt-2 rounded-lg bg-danger-tint/60 p-2" role="alert">
                    <p className="text-sm font-semibold text-danger">
                      Bemorda allergiya qayd etilgan: {matched.map((id) => allergyNames.get(id) ?? "qayd etilgan modda").join(", ")}
                    </p>
                    <p className="mb-1 mt-1 text-xs text-ink-muted">Shu dorini baribir yozish sababini kiriting (retseptda saqlanadi):</p>
                    <AInput
                      value={line.allergyOverrideReason}
                      onChange={(v) => patchLine(line.key, { allergyOverrideReason: v })}
                      aria-label={`${position}-dori: allergiyaga qaramay yozish sababi`}
                      maxLength={300}
                    />
                  </div>
                )}

                <div className="mt-3 grid gap-3 sm:grid-cols-4">
                  <div>
                    <p className="mb-1 text-xs font-medium text-ink-muted">Doza</p>
                    <AInput value={line.dose} onChange={(v) => patchLine(line.key, { dose: v })} inputMode="decimal" aria-label={`${position}-dori dozasi`} />
                  </div>
                  <div>
                    <p className="mb-1 text-xs font-medium text-ink-muted">Birlik</p>
                    <ASelect
                      value={line.doseUnit}
                      onChange={(v) => patchLine(line.key, { doseUnit: v })}
                      options={[{ value: "", label: "Tanlang" }, ...DOSE_UNITS.map((u) => ({ value: u, label: u }))]}
                      aria-label={`${position}-dori doza birligi`}
                    />
                  </div>
                  <div className="sm:col-span-2">
                    <p className="mb-1 text-xs font-medium text-ink-muted">Qabul yo‘li</p>
                    <ASelect
                      value={line.route}
                      onChange={(v) => patchLine(line.key, { route: v })}
                      options={[{ value: "", label: "Tanlang" }, ...ROUTES.map((r) => ({ value: r, label: r }))]}
                      aria-label={`${position}-dori qabul yo‘li`}
                    />
                  </div>
                </div>

                <div className="mt-3">
                  <p className="mb-1 text-xs font-medium text-ink-muted">Kuniga necha mahal</p>
                  <div className="flex flex-wrap items-center gap-2">
                    {FREQUENCY_CHIPS.map((f) => (
                      <button
                        key={f}
                        type="button"
                        aria-pressed={line.frequency === f}
                        onClick={() => patchLine(line.key, { frequency: f })}
                        className={`rounded-full border px-3 py-1 text-xs font-medium ${
                          line.frequency === f ? "border-pine bg-pine text-white" : "border-hairline text-foreground hover:bg-sand"
                        }`}
                      >
                        {f}
                      </button>
                    ))}
                    <div className="min-w-40 flex-1">
                      <AInput
                        value={chip ? "" : line.frequency}
                        onChange={(v) => patchLine(line.key, { frequency: v })}
                        placeholder="Boshqa tartib (masalan: har 8 soatda)"
                        aria-label={`${position}-dori: boshqa qabul tartibi`}
                        maxLength={40}
                      />
                    </div>
                  </div>
                </div>

                <div className="mt-3 grid gap-3 sm:grid-cols-4">
                  <div className="sm:col-span-2">
                    <p className="mb-1 text-xs font-medium text-ink-muted">Ovqatga nisbatan</p>
                    <ASelect
                      value={line.timing}
                      onChange={(v) => patchLine(line.key, { timing: v as Timing })}
                      options={TIMINGS.map((t) => ({ value: t, label: TIMING_LABELS[t] }))}
                      aria-label={`${position}-dori: ovqatga nisbatan`}
                    />
                  </div>
                  <div>
                    <p className="mb-1 text-xs font-medium text-ink-muted">Necha kun</p>
                    <AInput value={line.days} onChange={(v) => patchLine(line.key, { days: v })} inputMode="numeric" aria-label={`${position}-dori: kunlar soni`} />
                  </div>
                  <div>
                    <p className="mb-1 text-xs font-medium text-ink-muted">Jami miqdor{line.doseUnit ? ` (${line.doseUnit})` : ""}</p>
                    <AInput
                      value={line.quantity}
                      onChange={(v) => patchLine(line.key, { quantity: v, quantityEdited: true })}
                      inputMode="decimal"
                      aria-label={`${position}-dori: jami miqdor`}
                    />
                  </div>
                </div>
                {!line.quantityEdited && line.quantity && (
                  <p className="mt-1 text-xs text-ink-muted">Jami miqdor = doza × kuniga necha mahal × kunlar. O‘zgartirishingiz mumkin.</p>
                )}

                <div className="mt-3">
                  <p className="mb-1 text-xs font-medium text-ink-muted">Bemorga ko‘rsatma (ixtiyoriy)</p>
                  <AInput
                    value={line.instructions}
                    onChange={(v) => patchLine(line.key, { instructions: v })}
                    placeholder="Masalan: ovqatdan keyin, ko‘p suv bilan"
                    aria-label={`${position}-dori: ko‘rsatma`}
                    maxLength={500}
                  />
                </div>
              </div>
            );
          })}

          {lines.length > 0 && (
            <>
              <div className="flex flex-wrap gap-2">
                <AButton loading={busy} onClick={() => void onSign()}>
                  Imzolash
                </AButton>
                <AButton variant="outline" loading={busy} onClick={() => void onSaveDraft()}>
                  Qoralamani saqlash
                </AButton>
                <AButton variant="ghost" disabled={busy} onClick={resetComposer}>
                  Tozalash
                </AButton>
              </div>
              <div className="flex flex-wrap items-end gap-2">
                <div className="min-w-56 flex-1">
                  <p className="mb-1 text-xs font-medium text-ink-muted">Shu to‘plamni shablon sifatida saqlash (faqat sizga ko‘rinadi)</p>
                  <AInput value={templateName} onChange={setTemplateName} placeholder="Masalan: Angina — kattalar" aria-label="Shablon nomi" maxLength={80} />
                </div>
                <AButton variant="outline" size="sm" loading={busy} disabled={!templateName.trim()} onClick={() => void onSaveTemplate()}>
                  Shablonni saqlash
                </AButton>
              </div>
              <p className="text-xs text-ink-muted">
                Imzolangan retsept o‘zgartirilmaydi: uni faqat almashtirish yoki bekor qilish mumkin. Dorilarning o‘zaro ta’siri bu yerda
                tekshirilmaydi.
              </p>
            </>
          )}
        </div>
      ) : (
        <p className="text-sm text-ink-muted">Retsept faqat boshlangan qabul ichida yoziladi.</p>
      )}

      <div>
        <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-muted">Retseptlar</p>
        {prescriptions === null ? (
          error ? null : (
            <LoadingRow />
          )
        ) : prescriptions.length === 0 ? (
          <p className="text-sm text-ink-muted">Bu bemorga hali retsept yozilmagan.</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {prescriptions.map((p) => {
              const rxOnlyItems = p.items.filter((i) => i.rxOnly);
              return (
                <li key={p.id} className="rounded-lg border border-hairline p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-sm text-foreground">
                      <ABadge tone={STATUS_TONES[p.status]}>{PRESCRIPTION_STATUS_LABELS[p.status]}</ABadge>{" "}
                      <span className="ml-1 text-ink-muted">
                        {formatDateTime(p.signedAt ?? p.createdAt)} · {p.mine ? "Siz" : (p.author.name ?? "—")}
                      </span>
                    </p>
                    <div className="flex flex-wrap gap-2">
                      {p.mine && p.status === "draft" && p.appointmentId === appointmentId && (
                        <>
                          <AButton size="sm" variant="outline" disabled={busy} onClick={() => editDraft(p)}>
                            Davom ettirish
                          </AButton>
                          <AButton size="sm" variant="ghost" disabled={busy} onClick={() => void onDeleteDraft(p)}>
                            O‘chirish
                          </AButton>
                        </>
                      )}
                      {p.mine && p.status !== "draft" && (
                        <a
                          href={`/doctor/prescriptions/${p.id}/print`}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center rounded-lg border border-hairline bg-surface px-2.5 py-1.5 text-xs font-medium text-foreground hover:bg-sand"
                        >
                          Chop etish
                        </a>
                      )}
                      {p.mine && p.status === "signed" && appointmentId && (
                        <AButton size="sm" variant="outline" disabled={busy} onClick={() => startReplacement(p)}>
                          Almashtirish
                        </AButton>
                      )}
                      {p.mine && p.status === "signed" && cancelling !== p.id && (
                        <AButton size="sm" variant="ghost" disabled={busy} onClick={() => setCancelling(p.id)}>
                          Bekor qilish
                        </AButton>
                      )}
                    </div>
                  </div>

                  <ol className="mt-2 flex flex-col gap-1">
                    {p.items.map((item) => (
                      <li key={item.id} className="text-sm text-foreground">
                        <span className="font-medium">
                          {item.position}. {drugLabel(item)}
                        </span>{" "}
                        {item.rxOnly && <ABadge tone="blue">Retsept bilan</ABadge>}
                        <span className="block text-xs text-ink-muted">
                          {item.dose} {item.doseUnit}, {item.route}, {item.frequency}
                          {item.timing === "any" ? "" : `, ${TIMING_LABELS[item.timing].toLowerCase()}`}, {item.days} kun, jami {item.quantity}
                          {item.instructions ? ` · ${item.instructions}` : ""}
                        </span>
                        {item.allergyOverrideReason && (
                          <span className="block text-xs text-danger">Allergiya qayd etilgan — shifokor izohi: {item.allergyOverrideReason}</span>
                        )}
                      </li>
                    ))}
                  </ol>

                  {p.status === "replaced" && <p className="mt-2 text-xs text-ink-muted">Bu retsept yangisi bilan almashtirilgan.</p>}
                  {p.replacesId && p.replaceReason && <p className="mt-2 text-xs text-ink-muted">Oldingi retsept o‘rniga. Sabab: {p.replaceReason}</p>}
                  {p.status === "cancelled" && (
                    <p className="mt-2 text-xs text-ink-muted">
                      Bekor qilingan{p.cancelledAt ? ` (${formatDateTime(p.cancelledAt)})` : ""}. Sabab: {p.cancelReason}
                    </p>
                  )}

                  {cancelling === p.id && (
                    <div className="mt-2 flex flex-wrap items-end gap-2">
                      <div className="min-w-56 flex-1">
                        <p className="mb-1 text-xs font-medium text-ink-muted">Bekor qilish sababi (majburiy)</p>
                        <AInput value={cancelReason} onChange={setCancelReason} aria-label="Bekor qilish sababi" maxLength={300} />
                      </div>
                      <AButton size="sm" variant="danger" loading={busy} disabled={cancelReason.trim().length < 3} onClick={() => void onCancel(p)}>
                        Bekor qilishni tasdiqlash
                      </AButton>
                      <AButton
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          setCancelling(null);
                          setCancelReason("");
                        }}
                      >
                        Yopish
                      </AButton>
                    </div>
                  )}

                  {p.status === "signed" && rxOnlyItems.length > 0 && (
                    <div className="mt-3 rounded-lg border border-info/30 bg-info-tint/40 p-3" aria-label="Elektron retsept">
                      <p className="text-sm font-semibold text-foreground">
                        Elektron retsept {p.nationalRxRequired ? <ABadge tone="amber">Milliy e-retsept talab qilinadi</ABadge> : <ABadge tone="green">Raqam kiritilgan</ABadge>}
                      </p>
                      <p className="mt-1 text-xs text-ink-muted">
                        Retsept bilan beriladigan dorilar uchun yuridik kuchga ega retsept — Sog‘liqni saqlash vazirligining «Elektron retsept» tizimidagi
                        yozuv. Quyidagi ma’lumotni o‘z login-parolingiz bilan o‘sha tizimga kiriting va u bergan raqamni shu yerga yozing.
                      </p>
                      <ul className="mt-2 flex flex-col gap-1">
                        {rxOnlyItems.map((item) => (
                          <li key={item.id} className="flex flex-wrap items-center justify-between gap-2 text-xs text-foreground">
                            <span>{nationalLine(item)}</span>
                            <button type="button" className="font-medium text-pine hover:underline" onClick={() => void copy(nationalLine(item))}>
                              Nusxa olish
                            </button>
                          </li>
                        ))}
                      </ul>
                      {p.mine && (
                        <div className="mt-2 flex flex-wrap items-end gap-2">
                          <div className="min-w-48 flex-1">
                            <p className="mb-1 text-xs font-medium text-ink-muted">Milliy retsept raqami</p>
                            <AInput
                              value={nationalNumbers[p.id] ?? p.nationalRxNumber ?? ""}
                              onChange={(v) => setNationalNumbers((current) => ({ ...current, [p.id]: v }))}
                              aria-label="Milliy retsept raqami"
                              maxLength={40}
                            />
                          </div>
                          <AButton
                            size="sm"
                            variant="outline"
                            loading={busy}
                            disabled={!(nationalNumbers[p.id] ?? "").trim() || (nationalNumbers[p.id] ?? "").trim() === p.nationalRxNumber}
                            onClick={() => void onSaveNationalNumber(p)}
                          >
                            Raqamni saqlash
                          </AButton>
                        </div>
                      )}
                      {!p.mine && p.nationalRxNumber && <p className="mt-2 text-xs text-ink-muted">Milliy retsept raqami: {p.nationalRxNumber}</p>}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {catalogue && !catalogueEmpty && (
        <p className="text-xs text-ink-muted">
          Dorilar ro‘yxati manbasi:{" "}
          {[
            ...catalogue.sources.map((s) => `${s.source}, ${s.version}`),
            ...(catalogue.clinicEntries > 0 ? [`klinika ro‘yxati (${catalogue.clinicEntries} ta)`] : []),
          ].join(" · ")}
          . Dorilarning o‘zaro ta’siri tekshirilmaydi.
        </p>
      )}
    </div>
  );
}

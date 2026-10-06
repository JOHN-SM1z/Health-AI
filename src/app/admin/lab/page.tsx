"use client";

import { useEffect, useMemo, useState } from "react";
import { PageHeader, Card, ABadge, ATable, AEmpty, AError, AButton, AInput, ATextArea, ASelect, AModal } from "@/components/admin/ui";
import { adminApi, AdminApiError, formatPrice } from "@/lib/admin/client";
import { LabProvidersTab } from "@/components/admin/lab-providers";

/**
 * Clinic laboratory configuration (Phase 4): tests grouped by category, their
 * parameters and configured reference ranges, panels, and the lab workflow
 * settings. Management only — every write is authorized on the server
 * (catalog.configure). Nothing is deleted: rows are deactivated, so ordered
 * history keeps working. Reference ranges are clinic configuration; the app
 * never interprets a result beyond "outside the configured range".
 */

type Category = { id: string; name: string; sort_order: number; active: boolean };
type Test = {
  id: string;
  category_id: string | null;
  code: string;
  name: string;
  sample_type: string;
  preparation_text: string | null;
  turnaround_hours: number | null;
  price: number;
  sort_order: number;
  active: boolean;
};
type ValueType = "numeric" | "text" | "boolean" | "choice";
type Parameter = {
  id: string;
  test_id: string;
  code: string;
  name: string;
  value_type: ValueType;
  unit: string | null;
  decimals: number | null;
  choices: string[] | null;
  sort_order: number;
  active: boolean;
};
type Range = {
  id: string;
  parameter_id: string;
  sex: "female" | "male" | null;
  age_min_days: number | null;
  age_max_days: number | null;
  low: number | null;
  high: number | null;
  critical_low: number | null;
  critical_high: number | null;
  normal_text: string | null;
  method_label: string | null;
  active: boolean;
};
type Panel = { id: string; code: string; name: string; price: number; sort_order: number; active: boolean; test_ids: string[] };
type Catalog = { categories: Category[]; tests: Test[]; parameters: Parameter[]; ranges: Range[]; panels: Panel[] };
type Settings = {
  paymentPolicy: "not_required" | "before_collection";
  releaseToPatient: boolean;
  verifiers: "lab_and_doctor" | "lab_only" | "doctor_only";
  notifyStaff: boolean;
  notifyPatientOnCancel: boolean;
  aiSummaries: boolean;
};

const VALUE_TYPE_LABELS: Record<ValueType, string> = {
  numeric: "Son",
  text: "Matn",
  boolean: "Ha / yo‘q",
  choice: "Tanlov",
};
const SEX_LABELS = { female: "Ayol", male: "Erkak" } as const;
const TABS = [
  { id: "tests", label: "Tahlillar" },
  { id: "panels", label: "Panellar" },
  { id: "settings", label: "Sozlamalar" },
  { id: "providers", label: "Tashqi laboratoriyalar" },
] as const;

const errorText = (e: unknown, fallback: string) => (e instanceof AdminApiError ? e.message : fallback);
const numberOrNull = (v: string) => (v.trim() === "" ? null : Number(v));

function ageLabel(r: Range): string {
  const years = (d: number | null) => (d == null ? null : Math.round((d / 365) * 10) / 10);
  const min = years(r.age_min_days);
  const max = years(r.age_max_days);
  if (min == null && max == null) return "Har qanday yosh";
  if (max == null) return `${min} yoshdan`;
  if (min == null) return `${max} yoshgacha`;
  return `${min}–${max} yosh`;
}

function boundsLabel(r: Range, unit: string | null): string {
  if (r.normal_text) return `Kutilgan: ${r.normal_text}`;
  const u = unit ? ` ${unit}` : "";
  const normal = r.low != null && r.high != null ? `${r.low}–${r.high}${u}` : r.low != null ? `≥ ${r.low}${u}` : `≤ ${r.high}${u}`;
  const critical = [r.critical_low != null ? `< ${r.critical_low}` : null, r.critical_high != null ? `> ${r.critical_high}` : null]
    .filter(Boolean)
    .join(", ");
  return critical ? `${normal} (kritik: ${critical})` : normal;
}

export default function LabConfigurationPage() {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<(typeof TABS)[number]["id"]>("tests");
  const [editingCategory, setEditingCategory] = useState<Category | null>(null);
  const [editingTest, setEditingTest] = useState<Test | null>(null);
  const [parametersOf, setParametersOf] = useState<Test | null>(null);
  const [editingPanel, setEditingPanel] = useState<Panel | null>(null);

  const load = async () => {
    try {
      setCatalog(await adminApi.get<Catalog>("/api/admin/lab/catalog"));
    } catch (e) {
      setError(errorText(e, "Laboratoriya katalogini yuklab bo‘lmadi"));
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const open = <T,>(set: (v: T) => void) => (v: T) => {
    setError(null);
    set(v);
  };

  const saved = () => {
    setEditingCategory(null);
    setEditingTest(null);
    setEditingPanel(null);
    setError(null);
    void load();
  };

  const newTest: Test = {
    id: "",
    category_id: null,
    code: "",
    name: "",
    sample_type: "",
    preparation_text: "",
    turnaround_hours: null,
    price: 0,
    sort_order: 0,
    active: true,
  };

  return (
    <div>
      <PageHeader
        title="Laboratoriya"
        subtitle="Tahlillar, ko‘rsatkichlar, me’yorlar, panellar va narxlar"
        action={
          tab === "tests" ? (
            <div className="flex flex-wrap gap-2">
              <AButton variant="outline" onClick={() => setEditingCategory({ id: "", name: "", sort_order: 0, active: true })}>
                + Bo‘lim
              </AButton>
              <AButton onClick={() => setEditingTest(newTest)}>+ Tahlil</AButton>
            </div>
          ) : tab === "panels" ? (
            <AButton onClick={() => setEditingPanel({ id: "", code: "", name: "", price: 0, sort_order: 0, active: true, test_ids: [] })}>
              + Panel
            </AButton>
          ) : undefined
        }
      />

      <div className="mb-4 flex gap-1 rounded-xl bg-surface p-1 text-sm" role="tablist" aria-label="Laboratoriya sozlamalari">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => setTab(t.id)}
            className={`flex-1 rounded-lg px-3 py-2 font-medium ${tab === t.id ? "bg-pine text-white" : "text-ink-muted hover:bg-sand"}`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {error && <AError message={error} />}

      {catalog === null ? (
        <Card><div className="h-2 w-full animate-pulse rounded bg-hairline" /></Card>
      ) : tab === "tests" ? (
        <TestsTab
          catalog={catalog}
          onEditCategory={open(setEditingCategory)}
          onEditTest={open(setEditingTest)}
          onParameters={open(setParametersOf)}
        />
      ) : tab === "panels" ? (
        <PanelsTab catalog={catalog} onEdit={open(setEditingPanel)} />
      ) : tab === "providers" ? (
        <LabProvidersTab tests={catalog.tests} parameters={catalog.parameters} />
      ) : (
        <SettingsTab onError={setError} />
      )}

      {editingCategory && (
        <CategoryModal error={error} category={editingCategory} onClose={() => setEditingCategory(null)} onSaved={saved} onError={setError} />
      )}
      {editingTest && catalog && (
        <TestModal error={error} test={editingTest} categories={catalog.categories} onClose={() => setEditingTest(null)} onSaved={saved} onError={setError} />
      )}
      {parametersOf && catalog && (
        <ParametersModal
          error={error}
          test={parametersOf}
          catalog={catalog}
          onClose={() => setParametersOf(null)}
          onChanged={() => {
            setError(null);
            void load();
          }}
          onError={setError}
        />
      )}
      {editingPanel && catalog && (
        <PanelModal error={error} panel={editingPanel} tests={catalog.tests} onClose={() => setEditingPanel(null)} onSaved={saved} onError={setError} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

function TestsTab({
  catalog,
  onEditCategory,
  onEditTest,
  onParameters,
}: {
  catalog: Catalog;
  onEditCategory: (c: Category) => void;
  onEditTest: (t: Test) => void;
  onParameters: (t: Test) => void;
}) {
  if (catalog.tests.length === 0 && catalog.categories.length === 0) {
    return (
      <Card>
        <AEmpty title="Tahlillar hali sozlanmagan" subtitle="Avval bo‘lim (masalan, “Qon tahlili”), so‘ng tahlil qo‘shing" />
      </Card>
    );
  }
  const groups: Array<{ category: Category | null; tests: Test[] }> = [
    ...catalog.categories.map((c) => ({ category: c, tests: catalog.tests.filter((t) => t.category_id === c.id) })),
    { category: null, tests: catalog.tests.filter((t) => !t.category_id) },
  ].filter((g) => g.category || g.tests.length > 0);

  return (
    <div className="flex flex-col gap-6">
      {groups.map(({ category, tests }) => (
        <section key={category?.id ?? "none"}>
          <div className="mb-2 flex items-center gap-2">
            <h2 className="font-display text-base font-bold tracking-tight text-foreground">{category?.name ?? "Bo‘limsiz"}</h2>
            {category && !category.active && <ABadge tone="gray">Nofaol</ABadge>}
            {category && (
              <AButton size="sm" variant="ghost" onClick={() => onEditCategory(category)}>
                Tahrirlash
              </AButton>
            )}
          </div>
          {tests.length === 0 ? (
            <Card><AEmpty title="Bu bo‘limda tahlil yo‘q" /></Card>
          ) : (
            <ATable headers={["Kod", "Tahlil", "Namuna", "Ko‘rsatkichlar", "Narx", "Holat", "Amallar"]}>
              {tests.map((t) => {
                const params = catalog.parameters.filter((p) => p.test_id === t.id);
                return (
                  <tr key={t.id} className="hover:bg-sand">
                    <td className="font-numeric px-4 py-3 text-xs text-ink-muted">{t.code}</td>
                    <td className="px-4 py-3">
                      <p className="font-medium text-foreground">{t.name}</p>
                      {t.turnaround_hours && <p className="text-xs text-ink-muted">Natija: ~{t.turnaround_hours} soat</p>}
                    </td>
                    <td className="px-4 py-3 text-foreground">{t.sample_type}</td>
                    <td className="px-4 py-3 text-foreground">{params.filter((p) => p.active).length}</td>
                    <td className="px-4 py-3 font-semibold text-foreground">{formatPrice(t.price)}</td>
                    <td className="px-4 py-3"><ABadge tone={t.active ? "green" : "gray"}>{t.active ? "Faol" : "Nofaol"}</ABadge></td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap gap-1">
                        <AButton size="sm" variant="outline" onClick={() => onEditTest(t)}>Tahrirlash</AButton>
                        <AButton size="sm" variant="outline" onClick={() => onParameters(t)}>Ko‘rsatkichlar</AButton>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </ATable>
          )}
        </section>
      ))}
    </div>
  );
}

function CategoryModal({ error, category, onClose, onSaved, onError }: { error: string | null; category: Category; onClose: () => void; onSaved: () => void; onError: (m: string) => void }) {
  const [name, setName] = useState(category.name);
  const [active, setActive] = useState(category.active);
  const [saving, setSaving] = useState(false);
  const isEdit = Boolean(category.id);

  const save = async () => {
    setSaving(true);
    try {
      const body = { name: name.trim(), active };
      if (isEdit) await adminApi.patch(`/api/admin/lab/categories?id=${category.id}`, body);
      else await adminApi.post("/api/admin/lab/categories", body);
      onSaved();
    } catch (e) {
      onError(errorText(e, "Saqlab bo‘lmadi"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <AModal
      title={isEdit ? "Bo‘limni tahrirlash" : "Yangi bo‘lim"}
      onClose={onClose}
      footer={
        <>
          <AButton variant="ghost" onClick={onClose}>Bekor qilish</AButton>
          <AButton onClick={save} disabled={saving || !name.trim()}>Saqlash</AButton>
        </>
      }
    >
      {error && <AError message={error} />}
      <AInput value={name} onChange={setName} placeholder="Masalan: Qon tahlili, Bioximiya" aria-label="Bo‘lim nomi" />
      <ActiveToggle active={active} onChange={setActive} />
    </AModal>
  );
}

function TestModal({
  error,
  test,
  categories,
  onClose,
  onSaved,
  onError,
}: {
  error: string | null;
  test: Test;
  categories: Category[];
  onClose: () => void;
  onSaved: () => void;
  onError: (m: string) => void;
}) {
  const [code, setCode] = useState(test.code);
  const [name, setName] = useState(test.name);
  const [categoryId, setCategoryId] = useState(test.category_id ?? "");
  const [sampleType, setSampleType] = useState(test.sample_type);
  const [preparation, setPreparation] = useState(test.preparation_text ?? "");
  const [turnaround, setTurnaround] = useState(test.turnaround_hours == null ? "" : String(test.turnaround_hours));
  const [price, setPrice] = useState(String(test.price));
  const [active, setActive] = useState(test.active);
  const [saving, setSaving] = useState(false);
  const isEdit = Boolean(test.id);

  const save = async () => {
    const priceValue = Number(price);
    const turnaroundValue = numberOrNull(turnaround);
    if (!Number.isFinite(priceValue) || priceValue < 0) return onError("Narx noto‘g‘ri");
    if (turnaroundValue != null && (!Number.isInteger(turnaroundValue) || turnaroundValue < 1)) return onError("Natija muddati soatlarda, butun son");
    setSaving(true);
    try {
      const body = {
        code: code.trim(),
        name: name.trim(),
        categoryId: categoryId || null,
        sampleType: sampleType.trim(),
        preparationText: preparation.trim() || null,
        turnaroundHours: turnaroundValue,
        price: priceValue,
        active,
      };
      if (isEdit) await adminApi.patch(`/api/admin/lab/tests?id=${test.id}`, body);
      else await adminApi.post("/api/admin/lab/tests", body);
      onSaved();
    } catch (e) {
      onError(errorText(e, "Saqlab bo‘lmadi"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <AModal
      title={isEdit ? "Tahlilni tahrirlash" : "Yangi tahlil"}
      onClose={onClose}
      footer={
        <>
          <AButton variant="ghost" onClick={onClose}>Bekor qilish</AButton>
          <AButton onClick={save} disabled={saving || !code.trim() || !name.trim() || !sampleType.trim()}>Saqlash</AButton>
        </>
      }
    >
      {error && <AError message={error} />}
      <div className="grid grid-cols-3 gap-2">
        <AInput value={code} onChange={setCode} placeholder="Kod (CBC)" aria-label="Tahlil kodi" />
        <div className="col-span-2"><AInput value={name} onChange={setName} placeholder="Nomi (Umumiy qon tahlili)" aria-label="Tahlil nomi" /></div>
      </div>
      <ASelect
        value={categoryId}
        onChange={setCategoryId}
        options={[{ value: "", label: "Bo‘limsiz" }, ...categories.map((c) => ({ value: c.id, label: c.name }))]}
        aria-label="Bo‘lim"
      />
      <AInput value={sampleType} onChange={setSampleType} placeholder="Namuna turi (vena qoni, siydik…)" aria-label="Namuna turi" />
      <ATextArea value={preparation} onChange={setPreparation} placeholder="Bemor uchun tayyorgarlik (masalan, och qoringa)" aria-label="Tayyorgarlik" />
      <div className="grid grid-cols-2 gap-2">
        <AInput value={price} onChange={setPrice} type="number" placeholder="Narx (so‘m)" aria-label="Narx" />
        <AInput value={turnaround} onChange={setTurnaround} type="number" placeholder="Natija muddati (soat)" aria-label="Natija muddati, soat" />
      </div>
      {isEdit && <p className="text-xs text-ink-muted">Narx o‘zgarishi avvalgi buyurtmalarga ta’sir qilmaydi — ular buyurtma paytidagi narxni saqlaydi.</p>}
      <ActiveToggle active={active} onChange={setActive} hint="Nofaol tahlilga yangi buyurtma berib bo‘lmaydi; avvalgi natijalar saqlanadi." />
    </AModal>
  );
}

// ---------------------------------------------------------------------------
// Parameters and reference ranges
// ---------------------------------------------------------------------------

function ParametersModal({
  error,
  test,
  catalog,
  onClose,
  onChanged,
  onError,
}: {
  error: string | null;
  test: Test;
  catalog: Catalog;
  onClose: () => void;
  onChanged: () => void;
  onError: (m: string) => void;
}) {
  const parameters = catalog.parameters.filter((p) => p.test_id === test.id);
  const [adding, setAdding] = useState(false);
  const [rangeFor, setRangeFor] = useState<Parameter | null>(null);

  const toggleParameter = async (p: Parameter) => {
    try {
      await adminApi.patch(`/api/admin/lab/parameters?id=${p.id}`, { active: !p.active });
      onChanged();
    } catch (e) {
      onError(errorText(e, "Saqlab bo‘lmadi"));
    }
  };
  const toggleRange = async (r: Range) => {
    try {
      await adminApi.patch(`/api/admin/lab/ranges?id=${r.id}`, { active: !r.active });
      onChanged();
    } catch (e) {
      onError(errorText(e, "Saqlab bo‘lmadi"));
    }
  };

  return (
    <AModal title={`${test.name} — ko‘rsatkichlar`} onClose={onClose} maxWidth="max-w-3xl" footer={<AButton variant="ghost" onClick={onClose}>Yopish</AButton>}>
      {error && <AError message={error} />}
      <p className="text-xs text-ink-muted">
        Me’yorlar klinika tomonidan belgilanadi. Tizim faqat qiymat sozlangan me’yordan tashqarida ekanini ko‘rsatadi — tashxis qo‘ymaydi.
      </p>
      {parameters.length === 0 && <AEmpty title="Ko‘rsatkich yo‘q" subtitle="Bitta qiymatli tahlil uchun ham bitta ko‘rsatkich qo‘shing" />}
      {parameters.map((p) => {
        const ranges = catalog.ranges.filter((r) => r.parameter_id === p.id);
        return (
          <div key={p.id} className="rounded-xl border border-hairline p-3">
            <div className="flex flex-wrap items-center gap-2">
              <p className="font-medium text-foreground">{p.name}</p>
              <span className="font-numeric text-xs text-ink-muted">{p.code}</span>
              <ABadge tone="neutral">{VALUE_TYPE_LABELS[p.value_type]}{p.unit ? ` · ${p.unit}` : ""}</ABadge>
              {!p.active && <ABadge tone="gray">Nofaol</ABadge>}
              <div className="ml-auto flex gap-1">
                <AButton size="sm" variant="outline" onClick={() => setRangeFor(p)}>+ Me’yor</AButton>
                <AButton size="sm" variant="ghost" onClick={() => toggleParameter(p)}>{p.active ? "O‘chirish" : "Yoqish"}</AButton>
              </div>
            </div>
            {p.choices && <p className="mt-1 text-xs text-ink-muted">Variantlar: {p.choices.join(", ")}</p>}
            {ranges.length === 0 ? (
              <p className="mt-2 text-xs text-ink-muted">Me’yor sozlanmagan — natija “baholanmagan” deb ko‘rsatiladi.</p>
            ) : (
              <ul className="mt-2 flex flex-col gap-1">
                {ranges.map((r) => (
                  <li key={r.id} className={`flex flex-wrap items-center gap-2 text-sm ${r.active ? "text-foreground" : "text-ink-muted line-through"}`}>
                    <span>{r.sex ? SEX_LABELS[r.sex] : "Har ikki jins"}</span>
                    <span>·</span>
                    <span>{ageLabel(r)}</span>
                    <span>·</span>
                    <span className="font-numeric">{boundsLabel(r, p.unit)}</span>
                    {r.method_label && <span className="text-xs text-ink-muted">({r.method_label})</span>}
                    <AButton size="sm" variant="ghost" onClick={() => toggleRange(r)}>{r.active ? "O‘chirish" : "Yoqish"}</AButton>
                  </li>
                ))}
              </ul>
            )}
          </div>
        );
      })}

      {adding ? (
        <ParameterForm testId={test.id} onCancel={() => setAdding(false)} onSaved={() => { setAdding(false); onChanged(); }} onError={onError} />
      ) : (
        <AButton variant="outline" onClick={() => setAdding(true)}>+ Ko‘rsatkich qo‘shish</AButton>
      )}

      {rangeFor && (
        <RangeForm parameter={rangeFor} onCancel={() => setRangeFor(null)} onSaved={() => { setRangeFor(null); onChanged(); }} onError={onError} />
      )}
    </AModal>
  );
}

function ParameterForm({ testId, onCancel, onSaved, onError }: { testId: string; onCancel: () => void; onSaved: () => void; onError: (m: string) => void }) {
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [valueType, setValueType] = useState<ValueType>("numeric");
  const [unit, setUnit] = useState("");
  const [choices, setChoices] = useState("");
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    try {
      await adminApi.post("/api/admin/lab/parameters", {
        testId,
        code: code.trim(),
        name: name.trim(),
        valueType,
        unit: valueType === "numeric" ? unit.trim() || null : null,
        choices: valueType === "choice" ? choices.split(",").map((c) => c.trim()).filter(Boolean) : null,
      });
      onSaved();
    } catch (e) {
      onError(errorText(e, "Saqlab bo‘lmadi"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-2 rounded-xl bg-sand p-3">
      <p className="text-sm font-medium text-foreground">Yangi ko‘rsatkich</p>
      <div className="grid grid-cols-3 gap-2">
        <AInput value={code} onChange={setCode} placeholder="Kod (HGB)" aria-label="Ko‘rsatkich kodi" />
        <div className="col-span-2"><AInput value={name} onChange={setName} placeholder="Nomi (Gemoglobin)" aria-label="Ko‘rsatkich nomi" /></div>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <ASelect
          value={valueType}
          onChange={(v) => setValueType(v as ValueType)}
          options={(Object.keys(VALUE_TYPE_LABELS) as ValueType[]).map((v) => ({ value: v, label: VALUE_TYPE_LABELS[v] }))}
          aria-label="Qiymat turi"
        />
        {valueType === "numeric" && <AInput value={unit} onChange={setUnit} placeholder="Birlik (g/L)" aria-label="O‘lchov birligi" />}
        {valueType === "choice" && <AInput value={choices} onChange={setChoices} placeholder="Variantlar, vergul bilan" aria-label="Variantlar" />}
      </div>
      <p className="text-xs text-ink-muted">Kod va qiymat turi keyin o‘zgarmaydi — natijalar ular orqali saqlanadi.</p>
      <div className="flex justify-end gap-2">
        <AButton variant="ghost" onClick={onCancel}>Bekor qilish</AButton>
        <AButton onClick={save} disabled={saving || !code.trim() || !name.trim()}>Qo‘shish</AButton>
      </div>
    </div>
  );
}

function RangeForm({ parameter, onCancel, onSaved, onError }: { parameter: Parameter; onCancel: () => void; onSaved: () => void; onError: (m: string) => void }) {
  const numeric = parameter.value_type === "numeric";
  const [sex, setSex] = useState("");
  const [ageMin, setAgeMin] = useState("");
  const [ageMax, setAgeMax] = useState("");
  const [low, setLow] = useState("");
  const [high, setHigh] = useState("");
  const [criticalLow, setCriticalLow] = useState("");
  const [criticalHigh, setCriticalHigh] = useState("");
  const [normalText, setNormalText] = useState(parameter.value_type === "boolean" ? "false" : (parameter.choices?.[0] ?? ""));
  const [methodLabel, setMethodLabel] = useState("");
  const [saving, setSaving] = useState(false);

  // Ages are entered in years and stored in days (inclusive band).
  const days = (years: string) => (years.trim() === "" ? null : Math.round(Number(years) * 365));

  const save = async () => {
    const values = [ageMin, ageMax, low, high, criticalLow, criticalHigh].filter((v) => v.trim() !== "");
    if (values.some((v) => !Number.isFinite(Number(v)))) return onError("Raqamlarni to‘g‘ri kiriting");
    setSaving(true);
    try {
      await adminApi.post("/api/admin/lab/ranges", {
        parameterId: parameter.id,
        sex: sex || null,
        ageMinDays: days(ageMin),
        ageMaxDays: days(ageMax),
        ...(numeric
          ? { low: numberOrNull(low), high: numberOrNull(high), criticalLow: numberOrNull(criticalLow), criticalHigh: numberOrNull(criticalHigh) }
          : { normalText: normalText.trim() || null }),
        methodLabel: methodLabel.trim() || null,
      });
      onSaved();
    } catch (e) {
      onError(errorText(e, "Saqlab bo‘lmadi"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-2 rounded-xl bg-sand p-3">
      <p className="text-sm font-medium text-foreground">{parameter.name} — yangi me’yor</p>
      <div className="grid grid-cols-3 gap-2">
        <ASelect
          value={sex}
          onChange={setSex}
          options={[{ value: "", label: "Har ikki jins" }, { value: "female", label: "Ayol" }, { value: "male", label: "Erkak" }]}
          aria-label="Jins"
        />
        <AInput value={ageMin} onChange={setAgeMin} type="number" placeholder="Yosh, dan (yil)" aria-label="Yoshdan, yil" />
        <AInput value={ageMax} onChange={setAgeMax} type="number" placeholder="Yosh, gacha (yil)" aria-label="Yoshgacha, yil" />
      </div>
      {numeric ? (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <AInput value={low} onChange={setLow} type="number" placeholder="Me’yor, past" aria-label="Me’yor pastki chegarasi" />
          <AInput value={high} onChange={setHigh} type="number" placeholder="Me’yor, yuqori" aria-label="Me’yor yuqori chegarasi" />
          <AInput value={criticalLow} onChange={setCriticalLow} type="number" placeholder="Kritik, past" aria-label="Kritik pastki chegara" />
          <AInput value={criticalHigh} onChange={setCriticalHigh} type="number" placeholder="Kritik, yuqori" aria-label="Kritik yuqori chegara" />
        </div>
      ) : parameter.value_type === "boolean" ? (
        <ASelect value={normalText} onChange={setNormalText} options={[{ value: "false", label: "Me’yor: yo‘q" }, { value: "true", label: "Me’yor: ha" }]} aria-label="Kutilgan qiymat" />
      ) : parameter.value_type === "choice" ? (
        <ASelect value={normalText} onChange={setNormalText} options={(parameter.choices ?? []).map((c) => ({ value: c, label: `Me’yor: ${c}` }))} aria-label="Kutilgan qiymat" />
      ) : (
        <AInput value={normalText} onChange={setNormalText} placeholder="Kutilgan qiymat (masalan, manfiy)" aria-label="Kutilgan qiymat" />
      )}
      <AInput value={methodLabel} onChange={setMethodLabel} placeholder="Usul / uskuna (ixtiyoriy)" aria-label="Usul yoki uskuna" />
      <p className="text-xs text-ink-muted">Kritik chegaralar faqat ko‘rsatiladi; ogohlantirishlar hozircha yoqilmagan.</p>
      <div className="flex justify-end gap-2">
        <AButton variant="ghost" onClick={onCancel}>Bekor qilish</AButton>
        <AButton onClick={save} disabled={saving}>Qo‘shish</AButton>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Panels
// ---------------------------------------------------------------------------

function PanelsTab({ catalog, onEdit }: { catalog: Catalog; onEdit: (p: Panel) => void }) {
  const testName = (id: string) => catalog.tests.find((t) => t.id === id)?.name ?? "—";
  if (catalog.panels.length === 0) {
    return <Card><AEmpty title="Panellar yo‘q" subtitle="Bir nechta tahlilni bitta narxda birlashtiring" /></Card>;
  }
  return (
    <ATable headers={["Kod", "Panel", "Tahlillar", "Narx", "Holat", "Amallar"]}>
      {catalog.panels.map((p) => (
        <tr key={p.id} className="hover:bg-sand">
          <td className="font-numeric px-4 py-3 text-xs text-ink-muted">{p.code}</td>
          <td className="px-4 py-3 font-medium text-foreground">{p.name}</td>
          <td className="px-4 py-3 text-xs text-ink-muted">{p.test_ids.map(testName).join(", ")}</td>
          <td className="px-4 py-3 font-semibold text-foreground">{formatPrice(p.price)}</td>
          <td className="px-4 py-3"><ABadge tone={p.active ? "green" : "gray"}>{p.active ? "Faol" : "Nofaol"}</ABadge></td>
          <td className="px-4 py-3"><AButton size="sm" variant="outline" onClick={() => onEdit(p)}>Tahrirlash</AButton></td>
        </tr>
      ))}
    </ATable>
  );
}

function PanelModal({ error, panel, tests, onClose, onSaved, onError }: { error: string | null; panel: Panel; tests: Test[]; onClose: () => void; onSaved: () => void; onError: (m: string) => void }) {
  const [code, setCode] = useState(panel.code);
  const [name, setName] = useState(panel.name);
  const [price, setPrice] = useState(String(panel.price));
  const [testIds, setTestIds] = useState<string[]>(panel.test_ids);
  const [active, setActive] = useState(panel.active);
  const [saving, setSaving] = useState(false);
  const isEdit = Boolean(panel.id);
  const standalone = useMemo(() => tests.filter((t) => testIds.includes(t.id)).reduce((sum, t) => sum + Number(t.price), 0), [tests, testIds]);

  const toggle = (id: string) => setTestIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  const save = async () => {
    const priceValue = Number(price);
    if (!Number.isFinite(priceValue) || priceValue < 0) return onError("Narx noto‘g‘ri");
    setSaving(true);
    try {
      const body = { code: code.trim(), name: name.trim(), price: priceValue, testIds, active };
      if (isEdit) await adminApi.patch(`/api/admin/lab/panels?id=${panel.id}`, body);
      else await adminApi.post("/api/admin/lab/panels", body);
      onSaved();
    } catch (e) {
      onError(errorText(e, "Saqlab bo‘lmadi"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <AModal
      title={isEdit ? "Panelni tahrirlash" : "Yangi panel"}
      onClose={onClose}
      maxWidth="max-w-xl"
      footer={
        <>
          <AButton variant="ghost" onClick={onClose}>Bekor qilish</AButton>
          <AButton onClick={save} disabled={saving || !code.trim() || !name.trim() || testIds.length < 2}>Saqlash</AButton>
        </>
      }
    >
      {error && <AError message={error} />}
      <div className="grid grid-cols-3 gap-2">
        <AInput value={code} onChange={setCode} placeholder="Kod" aria-label="Panel kodi" />
        <div className="col-span-2"><AInput value={name} onChange={setName} placeholder="Nomi" aria-label="Panel nomi" /></div>
      </div>
      <div className="flex max-h-64 flex-col gap-1 overflow-y-auto rounded-xl border border-hairline p-2">
        {tests.filter((t) => t.active || testIds.includes(t.id)).map((t) => (
          <label key={t.id} className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={testIds.includes(t.id)} onChange={() => toggle(t.id)} />
            <span className="flex-1">{t.name}</span>
            <span className="font-numeric text-xs text-ink-muted">{formatPrice(t.price)}</span>
          </label>
        ))}
      </div>
      <AInput value={price} onChange={setPrice} type="number" placeholder="Panel narxi (so‘m)" aria-label="Panel narxi" />
      <p className="text-xs text-ink-muted">
        Alohida narxlar yig‘indisi: {formatPrice(standalone)}. Buyurtmada panel narxi tahlillar orasida ularning alohida narxiga mutanosib taqsimlanadi va
        buyurtma paytida saqlanadi.
      </p>
      <ActiveToggle active={active} onChange={setActive} />
    </AModal>
  );
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

function SettingsTab({ onError }: { onError: (m: string) => void }) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);

  useEffect(() => {
    adminApi
      .get<{ settings: Settings }>("/api/admin/lab/settings")
      .then((r) => setSettings(r.settings))
      .catch((e) => onError(errorText(e, "Sozlamalarni yuklab bo‘lmadi")));
  }, [onError]);

  if (!settings) return <Card><div className="h-2 w-full animate-pulse rounded bg-hairline" /></Card>;

  const save = async () => {
    setSaving(true);
    try {
      const r = await adminApi.put<{ settings: Settings }>("/api/admin/lab/settings", settings);
      setSettings(r.settings);
      setSavedAt(new Date().toLocaleTimeString("uz-UZ"));
    } catch (e) {
      onError(errorText(e, "Saqlab bo‘lmadi"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card className="flex flex-col gap-4 p-5">
      <div>
        <p className="font-medium text-foreground">To‘lov va namuna olish</p>
        <ASelect
          value={settings.paymentPolicy}
          onChange={(v) => setSettings({ ...settings, paymentPolicy: v as Settings["paymentPolicy"] })}
          options={[
            { value: "not_required", label: "Namuna to‘lovdan oldin ham olinadi" },
            { value: "before_collection", label: "Namuna faqat to‘lovdan keyin olinadi" },
          ]}
          aria-label="To‘lov siyosati"
        />
      </div>
      <label className="flex items-center gap-2 text-sm text-foreground">
        <input
          type="checkbox"
          checked={settings.releaseToPatient}
          onChange={(e) => setSettings({ ...settings, releaseToPatient: e.target.checked })}
        />
        Tasdiqlangan natijalarni bemorga Telegram ilovasida ko‘rsatish
      </label>
      <div>
        <p className="font-medium text-foreground">Natijani kim tasdiqlaydi</p>
        <ASelect
          value={settings.verifiers}
          onChange={(v) => setSettings({ ...settings, verifiers: v as Settings["verifiers"] })}
          options={[
            { value: "lab_and_doctor", label: "Laboratoriya xodimi yoki shifokor" },
            { value: "lab_only", label: "Faqat laboratoriya xodimi" },
            { value: "doctor_only", label: "Faqat shifokor (o‘z bemorlari)" },
          ]}
          aria-label="Tasdiqlovchilar"
        />
      </div>
      <p className="text-xs text-ink-muted">Har bir natijani kiritgan xodimdan boshqa vakolatli xodim tasdiqlaydi — bu o‘zgarmas qoida.</p>
      <label className="flex items-center gap-2 text-sm text-foreground">
        <input type="checkbox" checked={settings.notifyStaff} onChange={(e) => setSettings({ ...settings, notifyStaff: e.target.checked })} />
        Xodimlarga ilova ichida bildirishnoma (yangi buyurtma, namuna, tekshiruv, tasdiq, bekor qilish)
      </label>
      <label className="flex items-center gap-2 text-sm text-foreground">
        <input type="checkbox" checked={settings.notifyPatientOnCancel} onChange={(e) => setSettings({ ...settings, notifyPatientOnCancel: e.target.checked })} />
        Buyurtma bekor qilinganda bemorga Telegram orqali xabar berish
      </label>
      <label className="flex items-start gap-2 text-sm text-foreground">
        <input className="mt-1" type="checkbox" checked={settings.aiSummaries} onChange={(e) => setSettings({ ...settings, aiSummaries: e.target.checked })} />
        <span>
          Shifokorning laboratoriya xulosasini AI yordamida qayta yozish
          <span className="block text-xs text-ink-muted">
            AI provayderga faqat tasdiqlangan qiymatlardan hisoblangan bayonotlar yuboriladi (bemor ismi, izohlar va matnli qiymatlar yuborilmaydi). O‘chirilgan bo‘lsa, xulosa AIsiz tuziladi.
          </span>
        </span>
      </label>
      <div className="flex items-center justify-end gap-3">
        {savedAt && <span className="text-xs text-ink-muted">Saqlandi {savedAt}</span>}
        <AButton onClick={save} disabled={saving}>Saqlash</AButton>
      </div>
    </Card>
  );
}

function ActiveToggle({ active, onChange, hint }: { active: boolean; onChange: (v: boolean) => void; hint?: string }) {
  return (
    <div>
      <label className="flex items-center gap-2 text-sm text-foreground">
        <input type="checkbox" checked={active} onChange={(e) => onChange(e.target.checked)} />
        Faol
      </label>
      {hint && <p className="mt-1 text-xs text-ink-muted">{hint}</p>}
    </div>
  );
}

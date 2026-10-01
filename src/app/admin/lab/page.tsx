"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { FlaskConical } from "lucide-react";
import { PageHeader, Card, ABadge, ATable, AEmpty, AError, AButton, AInput, ASelect, ATextArea, AModal, LoadingRow } from "@/components/admin/ui";
import { adminApi, AdminApiError, formatPrice } from "@/lib/admin/client";
import { TestParametersView } from "@/components/lab/test-detail";
import {
  DATA_TYPE_LABELS,
  formatTurnaround,
  type LabCategory,
  type LabPanel,
  type LabSettings,
  type LabTest,
  type LabTestDetail,
} from "@/components/lab/types";

type Tab = "tests" | "panels" | "settings";
const TABS: Array<{ key: Tab; label: string }> = [
  { key: "tests", label: "Tahlillar" },
  { key: "panels", label: "Paketlar" },
  { key: "settings", label: "Ish tartibi" },
];

const errorText = (e: unknown, fallback: string) => (e instanceof AdminApiError ? e.message : fallback);
const numOrNull = (v: string): number | null => (v.trim() === "" ? null : Number(v));

function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="font-medium text-foreground">{label}</span>
      {children}
      {hint && <span className="text-xs text-ink-muted">{hint}</span>}
    </label>
  );
}

/**
 * Laboratory configuration for owner/admin/manager: tests, their parameters and reference ranges, panels
 * and the workflow policy. Configuration only — results and patients are not shown here (clinical data
 * never reaches operational staff). Every write goes through /api/admin/lab/*, which authorizes again.
 */
export default function AdminLabPage() {
  const [tab, setTab] = useState<Tab>("tests");
  return (
    <div>
      <PageHeader title="Laboratoriya" subtitle="Tahlillar, paketlar, me‘yorlar va ish tartibi" />
      <div className="mb-4 flex flex-wrap gap-2" role="tablist">
        {TABS.map((t) => (
          <AButton key={t.key} size="sm" variant={tab === t.key ? "primary" : "outline"} onClick={() => setTab(t.key)}>
            {t.label}
          </AButton>
        ))}
      </div>
      {tab === "tests" && <TestsTab />}
      {tab === "panels" && <PanelsTab />}
      {tab === "settings" && <SettingsTab />}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------- tests

function TestsTab() {
  const [tests, setTests] = useState<LabTest[] | null>(null);
  const [categories, setCategories] = useState<LabCategory[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [showInactive, setShowInactive] = useState(false);
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const [categoryName, setCategoryName] = useState("");

  const load = useCallback(async () => {
    try {
      const [t, c] = await Promise.all([
        adminApi.get<{ tests: LabTest[] }>(`/api/admin/lab/tests?includeInactive=${showInactive ? 1 : 0}`),
        adminApi.get<{ categories: LabCategory[] }>("/api/admin/lab/categories"),
      ]);
      setTests(t.tests);
      setCategories(c.categories);
      setError(null);
    } catch (e) {
      setError(errorText(e, "Tahlillarni yuklab bo‘lmadi"));
    }
  }, [showInactive]);

  useEffect(() => {
    void load();
  }, [load]);

  const addCategory = async () => {
    if (!categoryName.trim()) return;
    try {
      await adminApi.post("/api/admin/lab/categories", { name: categoryName.trim() });
      setCategoryName("");
      await load();
    } catch (e) {
      setError(errorText(e, "Bo‘limni qo‘shib bo‘lmadi"));
    }
  };

  return (
    <div>
      {error && <AError message={error} />}
      <Card>
        <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2">
            {categories.map((c) => (
              <ABadge key={c.id} tone={c.active ? "pine" : "gray"}>{c.name}</ABadge>
            ))}
            <div className="flex items-center gap-1.5">
              <AInput value={categoryName} onChange={setCategoryName} placeholder="Yangi bo‘lim (Qon, Siydik…)" aria-label="Yangi bo‘lim nomi" className="!w-52" />
              <AButton size="sm" variant="outline" onClick={() => void addCategory()}>Qo‘shish</AButton>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <label className="flex items-center gap-1.5 text-sm text-ink-muted">
              <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} /> Nofaollar ham
            </label>
            <AButton onClick={() => setEditing("new")}>Yangi tahlil</AButton>
          </div>
        </div>
        {tests === null ? (
          <LoadingRow />
        ) : tests.length === 0 ? (
          <AEmpty title="Tahlillar yo‘q" subtitle="Birinchi tahlilni qo‘shing" icon={<FlaskConical className="h-6 w-6" />} />
        ) : (
          <ATable headers={["Kod", "Nomi", "Bo‘lim", "Namuna", "Narx", "Muddat", "Parametr", "Holat", ""]}>
            {tests.map((t) => (
              <tr key={t.id} className="hover:bg-sand">
                <td className="font-numeric px-4 py-3 text-xs">{t.code}</td>
                <td className="px-4 py-3 font-medium text-foreground">{t.name}</td>
                <td className="px-4 py-3 text-ink-muted">{t.category?.name ?? "—"}</td>
                <td className="px-4 py-3 text-ink-muted">{t.sample_type ?? "—"}</td>
                <td className="px-4 py-3">{formatPrice(t.price)}</td>
                <td className="px-4 py-3 text-ink-muted">{formatTurnaround(t.turnaround_minutes)}</td>
                <td className="px-4 py-3 text-ink-muted">{t.parameterCount ?? 0}</td>
                <td className="px-4 py-3">
                  <ABadge tone={t.active ? "green" : "gray"}>{t.active ? "Faol" : "Nofaol"}</ABadge>
                </td>
                <td className="px-4 py-3">
                  <AButton size="sm" variant="outline" onClick={() => setEditing(t.id)}>Tahrirlash</AButton>
                </td>
              </tr>
            ))}
          </ATable>
        )}
      </Card>
      {editing && (
        <TestEditor
          testId={editing === "new" ? null : editing}
          categories={categories}
          onClose={() => setEditing(null)}
          onSaved={() => void load()}
        />
      )}
    </div>
  );
}

type TestForm = {
  code: string;
  name: string;
  categoryId: string;
  price: string;
  sampleType: string;
  turnaround: string;
  preparation: string;
  description: string;
  active: boolean;
};
const EMPTY_FORM: TestForm = { code: "", name: "", categoryId: "", price: "", sampleType: "", turnaround: "", preparation: "", description: "", active: true };

function TestEditor({ testId, categories, onClose, onSaved }: { testId: string | null; categories: LabCategory[]; onClose: () => void; onSaved: () => void }) {
  const [id, setId] = useState<string | null>(testId);
  const [form, setForm] = useState<TestForm>(EMPTY_FORM);
  const [detail, setDetail] = useState<LabTestDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof TestForm>(k: K, v: TestForm[K]) => setForm((f) => ({ ...f, [k]: v }));

  const loadDetail = useCallback(async (testIdToLoad: string) => {
    try {
      const res = await adminApi.get<{ test: LabTestDetail }>(`/api/admin/lab/tests?id=${testIdToLoad}`);
      setDetail(res.test);
      const t = res.test;
      setForm({
        code: t.code,
        name: t.name,
        categoryId: t.category_id ?? "",
        price: String(t.price),
        sampleType: t.sample_type ?? "",
        turnaround: t.turnaround_minutes ? String(t.turnaround_minutes) : "",
        preparation: t.preparation_text ?? "",
        description: t.description ?? "",
        active: t.active,
      });
    } catch (e) {
      setError(errorText(e, "Tahlilni yuklab bo‘lmadi"));
    }
  }, []);

  useEffect(() => {
    if (testId) void loadDetail(testId);
  }, [testId, loadDetail]);

  const save = async () => {
    setBusy(true);
    setSaved(null);
    try {
      const body = {
        code: form.code.trim(),
        name: form.name.trim(),
        categoryId: form.categoryId || null,
        price: Number(form.price),
        sampleType: form.sampleType.trim() || null,
        turnaroundMinutes: numOrNull(form.turnaround),
        preparationText: form.preparation.trim() || null,
        description: form.description.trim() || null,
        active: form.active,
      };
      if (id) {
        await adminApi.patch(`/api/admin/lab/tests?id=${id}`, body);
      } else {
        const res = await adminApi.post<{ test: LabTest }>("/api/admin/lab/tests", body);
        setId(res.test.id);
        await loadDetail(res.test.id);
      }
      setError(null);
      setSaved("Saqlandi");
      onSaved();
    } catch (e) {
      setError(errorText(e, "Saqlab bo‘lmadi"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AModal title={id ? "Tahlilni tahrirlash" : "Yangi tahlil"} onClose={onClose} maxWidth="max-w-3xl">
      {error && <AError message={error} />}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Kod" hint="Harf, raqam, nuqta, chiziq (masalan CBC)">
          <AInput value={form.code} onChange={(v) => set("code", v)} aria-label="Kod" />
        </Field>
        <Field label="Nomi">
          <AInput value={form.name} onChange={(v) => set("name", v)} aria-label="Nomi" />
        </Field>
        <Field label="Bo‘lim">
          <ASelect
            value={form.categoryId}
            onChange={(v) => set("categoryId", v)}
            options={[{ value: "", label: "—" }, ...categories.filter((c) => c.active).map((c) => ({ value: c.id, label: c.name }))]}
            aria-label="Bo‘lim"
          />
        </Field>
        <Field label="Narx (so‘m)">
          <AInput value={form.price} onChange={(v) => set("price", v)} type="number" aria-label="Narx" />
        </Field>
        <Field label="Namuna turi" hint="Qon, siydik…">
          <AInput value={form.sampleType} onChange={(v) => set("sampleType", v)} aria-label="Namuna turi" />
        </Field>
        <Field label="Bajarilish muddati (daqiqa)">
          <AInput value={form.turnaround} onChange={(v) => set("turnaround", v)} type="number" aria-label="Bajarilish muddati" />
        </Field>
      </div>
      <div className="mt-3 grid gap-3">
        <Field label="Tayyorgarlik ko‘rsatmasi (bemorga)">
          <ATextArea value={form.preparation} onChange={(v) => set("preparation", v)} rows={2} aria-label="Tayyorgarlik" />
        </Field>
        <Field label="Tavsif">
          <ATextArea value={form.description} onChange={(v) => set("description", v)} rows={2} aria-label="Tavsif" />
        </Field>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={form.active} onChange={(e) => set("active", e.target.checked)} />
          Faol — nofaol tahlil yangi buyurtmaga qo‘yilmaydi, avvalgi natijalar saqlanadi
        </label>
      </div>
      <div className="mt-4 flex items-center justify-end gap-3">
        {saved && <span className="text-sm text-pine-deep" role="status">{saved}</span>}
        <AButton variant="outline" onClick={onClose}>Yopish</AButton>
        <AButton loading={busy} onClick={() => void save()}>Saqlash</AButton>
      </div>

      {id && detail && (
        <div className="mt-6 border-t border-hairline pt-4">
          <p className="mb-2 font-display text-sm font-bold text-foreground">Parametrlar va me‘yorlar</p>
          <ParametersEditor detail={detail} reload={() => loadDetail(id)} />
        </div>
      )}
    </AModal>
  );
}

function ParametersEditor({ detail, reload }: { detail: LabTestDetail; reload: () => Promise<void> }) {
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({ code: "", name: "", unit: "", dataType: "numeric", choices: "" });
  const [rangeFor, setRangeFor] = useState<string | null>(null);
  const [range, setRange] = useState({ low: "", high: "", criticalLow: "", criticalHigh: "", ageMin: "", ageMax: "", note: "" });

  const run = async (action: () => Promise<unknown>, fallback: string) => {
    try {
      await action();
      setError(null);
      await reload();
    } catch (e) {
      setError(errorText(e, fallback));
    }
  };

  const addParameter = () =>
    run(async () => {
      await adminApi.post("/api/admin/lab/parameters", {
        testId: detail.id,
        code: form.code.trim(),
        name: form.name.trim(),
        unit: form.unit.trim() || null,
        dataType: form.dataType,
        choices: form.dataType === "choice" ? form.choices.split(",").map((c) => c.trim()).filter(Boolean) : null,
        displayOrder: detail.parameters.length + 1,
      });
      setForm({ code: "", name: "", unit: "", dataType: "numeric", choices: "" });
    }, "Parametrni qo‘shib bo‘lmadi");

  const addRange = (parameterId: string) =>
    run(async () => {
      await adminApi.post("/api/admin/lab/ranges", {
        parameterId,
        low: numOrNull(range.low),
        high: numOrNull(range.high),
        criticalLow: numOrNull(range.criticalLow),
        criticalHigh: numOrNull(range.criticalHigh),
        ageMinYears: numOrNull(range.ageMin),
        ageMaxYears: numOrNull(range.ageMax),
        note: range.note.trim() || null,
      });
      setRangeFor(null);
      setRange({ low: "", high: "", criticalLow: "", criticalHigh: "", ageMin: "", ageMax: "", note: "" });
    }, "Me‘yorni qo‘shib bo‘lmadi");

  return (
    <div className="flex flex-col gap-3">
      {error && <AError message={error} />}
      {detail.parameters.length === 0 && <p className="text-sm text-ink-muted">Parametrlar hali yo‘q — pastdan qo‘shing.</p>}
      {detail.parameters.map((p) => (
        <div key={p.id} className="rounded-lg border border-hairline bg-surface p-3 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-foreground">{p.name}</span>
            <span className="font-numeric text-xs text-ink-muted">{p.code}</span>
            {p.unit && <span className="text-xs text-ink-muted">{p.unit}</span>}
            <ABadge tone="gray">{DATA_TYPE_LABELS[p.data_type]}</ABadge>
            <ABadge tone={p.active ? "green" : "amber"}>{p.active ? "Faol" : "Nofaol"}</ABadge>
            <AButton size="sm" variant="outline" onClick={() => void run(() => adminApi.patch(`/api/admin/lab/parameters?id=${p.id}`, { active: !p.active }), "Holatni o‘zgartirib bo‘lmadi")}>
              {p.active ? "O‘chirish" : "Yoqish"}
            </AButton>
          </div>
          {p.data_type === "choice" && <p className="mt-1 text-xs text-ink-muted">Variantlar: {(p.choices ?? []).join(", ")}</p>}
          {p.data_type === "numeric" && (
            <div className="mt-2 flex flex-col gap-1.5">
              {p.ranges.map((r) => (
                <div key={r.id} className="flex flex-wrap items-center gap-2 text-xs text-ink-muted">
                  <span>
                    {r.low ?? "…"} – {r.high ?? "…"}
                    {(r.critical_low !== null || r.critical_high !== null) && ` · kritik < ${r.critical_low ?? "…"} / > ${r.critical_high ?? "…"}`}
                    {(r.age_min_years !== null || r.age_max_years !== null) && ` · ${r.age_min_years ?? 0}–${r.age_max_years ?? "…"} yosh`}
                    {r.note ? ` · ${r.note}` : ""}
                  </span>
                  <ABadge tone={r.active ? "green" : "gray"}>{r.active ? "Faol" : "Nofaol"}</ABadge>
                  <button type="button" className="text-pine hover:underline" onClick={() => void run(() => adminApi.patch(`/api/admin/lab/ranges?id=${r.id}`, { active: !r.active }), "Holatni o‘zgartirib bo‘lmadi")}>
                    {r.active ? "o‘chirish" : "yoqish"}
                  </button>
                </div>
              ))}
              {rangeFor === p.id ? (
                <div className="grid gap-2 sm:grid-cols-3">
                  {(
                    [
                      ["low", "Pastki chegara"],
                      ["high", "Yuqori chegara"],
                      ["criticalLow", "Kritik past"],
                      ["criticalHigh", "Kritik yuqori"],
                      ["ageMin", "Yosh dan"],
                      ["ageMax", "Yosh gacha"],
                    ] as const
                  ).map(([key, label]) => (
                    <Field key={key} label={label}>
                      <AInput value={range[key]} onChange={(v) => setRange((r) => ({ ...r, [key]: v }))} type="number" aria-label={label} />
                    </Field>
                  ))}
                  <div className="sm:col-span-3">
                    <Field label="Izoh">
                      <AInput value={range.note} onChange={(v) => setRange((r) => ({ ...r, note: v }))} aria-label="Izoh" />
                    </Field>
                  </div>
                  <div className="flex gap-2 sm:col-span-3">
                    <AButton size="sm" onClick={() => void addRange(p.id)}>Me‘yorni saqlash</AButton>
                    <AButton size="sm" variant="outline" onClick={() => setRangeFor(null)}>Bekor qilish</AButton>
                  </div>
                </div>
              ) : (
                <div>
                  <AButton size="sm" variant="ghost" onClick={() => setRangeFor(p.id)}>+ Me‘yor qo‘shish</AButton>
                </div>
              )}
            </div>
          )}
        </div>
      ))}
      <div className="grid gap-2 rounded-lg border border-dashed border-hairline p-3 sm:grid-cols-5">
        <Field label="Kod">
          <AInput value={form.code} onChange={(v) => setForm((f) => ({ ...f, code: v }))} aria-label="Parametr kodi" />
        </Field>
        <Field label="Nomi">
          <AInput value={form.name} onChange={(v) => setForm((f) => ({ ...f, name: v }))} aria-label="Parametr nomi" />
        </Field>
        <Field label="Birlik">
          <AInput value={form.unit} onChange={(v) => setForm((f) => ({ ...f, unit: v }))} aria-label="Birlik" />
        </Field>
        <Field label="Turi">
          <ASelect
            value={form.dataType}
            onChange={(v) => setForm((f) => ({ ...f, dataType: v }))}
            options={(["numeric", "text", "choice"] as const).map((v) => ({ value: v, label: DATA_TYPE_LABELS[v] }))}
            aria-label="Turi"
          />
        </Field>
        {form.dataType === "choice" ? (
          <Field label="Variantlar" hint="vergul bilan">
            <AInput value={form.choices} onChange={(v) => setForm((f) => ({ ...f, choices: v }))} aria-label="Variantlar" />
          </Field>
        ) : (
          <div />
        )}
        <div className="sm:col-span-5">
          <AButton size="sm" onClick={() => void addParameter()}>Parametr qo‘shish</AButton>
        </div>
      </div>
      <details className="text-sm text-ink-muted">
        <summary className="cursor-pointer">Texnik ko‘rinish</summary>
        <div className="mt-2">
          <TestParametersView test={detail} />
        </div>
      </details>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------- panels

function PanelsTab() {
  const [panels, setPanels] = useState<LabPanel[] | null>(null);
  const [tests, setTests] = useState<LabTest[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<LabPanel | "new" | null>(null);

  const load = useCallback(async () => {
    try {
      const [p, t] = await Promise.all([
        adminApi.get<{ panels: LabPanel[] }>("/api/admin/lab/panels?includeInactive=1"),
        adminApi.get<{ tests: LabTest[] }>("/api/admin/lab/tests"),
      ]);
      setPanels(p.panels);
      setTests(t.tests);
      setError(null);
    } catch (e) {
      setError(errorText(e, "Paketlarni yuklab bo‘lmadi"));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const testName = (id: string) => tests.find((t) => t.id === id)?.name ?? "—";

  return (
    <div>
      {error && <AError message={error} />}
      <Card>
        <div className="mb-3 flex justify-end">
          <AButton onClick={() => setEditing("new")}>Yangi paket</AButton>
        </div>
        {panels === null ? (
          <LoadingRow />
        ) : panels.length === 0 ? (
          <AEmpty title="Paketlar yo‘q" subtitle="Tahlillarni paketga birlashtiring" icon={<FlaskConical className="h-6 w-6" />} />
        ) : (
          <ATable headers={["Kod", "Nomi", "Tahlillar", "Narx", "Holat", ""]}>
            {panels.map((p) => (
              <tr key={p.id} className="hover:bg-sand">
                <td className="font-numeric px-4 py-3 text-xs">{p.code}</td>
                <td className="px-4 py-3 font-medium text-foreground">{p.name}</td>
                <td className="px-4 py-3 text-ink-muted">{p.testIds.map(testName).join(", ")}</td>
                <td className="px-4 py-3">{p.price === null ? "Tahlillar yig‘indisi" : formatPrice(p.price)}</td>
                <td className="px-4 py-3">
                  <ABadge tone={p.active ? "green" : "gray"}>{p.active ? "Faol" : "Nofaol"}</ABadge>
                </td>
                <td className="px-4 py-3">
                  <AButton size="sm" variant="outline" onClick={() => setEditing(p)}>Tahrirlash</AButton>
                </td>
              </tr>
            ))}
          </ATable>
        )}
      </Card>
      {editing && <PanelEditor panel={editing === "new" ? null : editing} tests={tests} onClose={() => setEditing(null)} onSaved={() => void load()} />}
    </div>
  );
}

function PanelEditor({ panel, tests, onClose, onSaved }: { panel: LabPanel | null; tests: LabTest[]; onClose: () => void; onSaved: () => void }) {
  const [code, setCode] = useState(panel?.code ?? "");
  const [name, setName] = useState(panel?.name ?? "");
  const [description, setDescription] = useState(panel?.description ?? "");
  const [price, setPrice] = useState(panel?.price === null || panel?.price === undefined ? "" : String(panel.price));
  const [active, setActive] = useState(panel?.active ?? true);
  const [selected, setSelected] = useState<string[]>(panel?.testIds ?? []);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const toggle = (id: string) => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));

  const save = async () => {
    setBusy(true);
    try {
      const body = { code: code.trim(), name: name.trim(), description: description.trim() || null, price: numOrNull(price), active, testIds: selected };
      if (panel) await adminApi.patch(`/api/admin/lab/panels?id=${panel.id}`, body);
      else await adminApi.post("/api/admin/lab/panels", body);
      onSaved();
      onClose();
    } catch (e) {
      setError(errorText(e, "Paketni saqlab bo‘lmadi"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AModal title={panel ? "Paketni tahrirlash" : "Yangi paket"} onClose={onClose} maxWidth="max-w-2xl">
      {error && <AError message={error} />}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Kod">
          <AInput value={code} onChange={setCode} aria-label="Paket kodi" />
        </Field>
        <Field label="Nomi">
          <AInput value={name} onChange={setName} aria-label="Paket nomi" />
        </Field>
        <Field label="Narx (bo‘sh: tahlillar yig‘indisi)">
          <AInput value={price} onChange={setPrice} type="number" aria-label="Paket narxi" />
        </Field>
        <Field label="Tavsif">
          <AInput value={description} onChange={setDescription} aria-label="Paket tavsifi" />
        </Field>
      </div>
      <p className="mb-1 mt-4 text-sm font-medium text-foreground">Tahlillar</p>
      <div className="grid max-h-56 gap-1 overflow-y-auto rounded-lg border border-hairline p-2 sm:grid-cols-2">
        {tests.map((t) => (
          <label key={t.id} className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={selected.includes(t.id)} onChange={() => toggle(t.id)} />
            {t.name} <span className="font-numeric text-xs text-ink-muted">{t.code}</span>
          </label>
        ))}
        {tests.length === 0 && <p className="text-sm text-ink-muted">Avval tahlillarni qo‘shing</p>}
      </div>
      <label className="mt-3 flex items-center gap-2 text-sm">
        <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /> Faol
      </label>
      <div className="mt-4 flex justify-end gap-3">
        <AButton variant="outline" onClick={onClose}>Yopish</AButton>
        <AButton loading={busy} onClick={() => void save()}>Saqlash</AButton>
      </div>
    </AModal>
  );
}

// ---------------------------------------------------------------------------------------------- settings

function SettingsTab() {
  const [settings, setSettings] = useState<LabSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    adminApi
      .get<{ settings: LabSettings }>("/api/admin/lab/settings")
      .then((r) => setSettings(r.settings))
      .catch((e) => setError(errorText(e, "Sozlamalarni yuklab bo‘lmadi")));
  }, []);

  const save = async () => {
    if (!settings) return;
    setBusy(true);
    setSaved(false);
    try {
      const res = await adminApi.put<{ settings: LabSettings }>("/api/admin/lab/settings", settings);
      setSettings(res.settings);
      setError(null);
      setSaved(true);
    } catch (e) {
      setError(errorText(e, "Saqlab bo‘lmadi"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      {error && <AError message={error} />}
      <Card>
        {settings === null ? (
          <LoadingRow />
        ) : (
          <div className="flex flex-col gap-4">
            <label className="flex items-start gap-3 text-sm">
              <input type="checkbox" className="mt-1" checked={settings.verification.required} onChange={(e) => setSettings({ ...settings, verification: { ...settings.verification, required: e.target.checked } })} />
              <span>
                <span className="font-medium text-foreground">Natija tekshiruvdan o‘tishi shart</span>
                <br />
                <span className="text-ink-muted">Yakuniy natija laborant tomonidan tasdiqlangandan keyingina tayyor hisoblanadi.</span>
              </span>
            </label>
            <label className="flex items-start gap-3 text-sm">
              <input type="checkbox" className="mt-1" checked={settings.verification.separateVerifier} onChange={(e) => setSettings({ ...settings, verification: { ...settings.verification, separateVerifier: e.target.checked } })} />
              <span>
                <span className="font-medium text-foreground">Tasdiqlovchi natijani kiritgan odamdan boshqa bo‘lsin</span>
                <br />
                <span className="text-ink-muted">Ikki laborant ishtirok etadi (kiritgan va tasdiqlagan).</span>
              </span>
            </label>
            <label className="flex items-start gap-3 text-sm">
              <input type="checkbox" className="mt-1" checked={settings.collection.requiresPayment} onChange={(e) => setSettings({ ...settings, collection: { requiresPayment: e.target.checked } })} />
              <span>
                <span className="font-medium text-foreground">Namuna olishdan oldin to‘lov shart</span>
                <br />
                <span className="text-ink-muted">Yoqilmasa, namuna to‘lovdan qat‘i nazar olinishi mumkin (to‘lov holati alohida saqlanadi).</span>
              </span>
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span className="font-medium text-foreground">Takroriy tahlil eslatmasi (kun)</span>
              <span className="text-ink-muted">
                Shifokor bemorga shu muddat ichida buyurilgan tahlilni yana buyursa, “o‘xshash tahlil bor” eslatmasi ko‘rinadi. Eslatma buyurtmani to‘smaydi. 0 — o‘chirilgan.
              </span>
              <AInput
                type="number"
                value={String(settings.ordering.recentTestWindowDays)}
                onChange={(v) => setSettings({ ...settings, ordering: { recentTestWindowDays: Math.max(0, Math.min(365, Math.round(Number(v) || 0))) } })}
                aria-label="Takroriy tahlil eslatmasi kunlari"
                className="!w-32"
              />
            </label>
            <div className="flex items-center gap-3">
              <AButton loading={busy} onClick={() => void save()}>Saqlash</AButton>
              {saved && <span className="text-sm text-pine-deep" role="status">Saqlandi</span>}
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}

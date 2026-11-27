"use client";

import { useCallback, useEffect, useState } from "react";
import { ABadge, AButton, AEmpty, AError, AInput, ASelect, ATable, Card, LoadingRow, PageHeader } from "@/components/admin/ui";
import { adminApi, AdminApiError } from "@/lib/admin/client";
import { SearchPicker } from "@/components/doctor/search-picker";
import { drugLabel } from "@/lib/prescribing/options";

type Entry = {
  drugId: string;
  inn: string;
  tradeName: string | null;
  form: string | null;
  strength: string | null;
  manufacturer: string | null;
  rxOnly: boolean;
  controlled: boolean;
  clinicOwned: boolean;
  drugActive: boolean;
  inFormulary: boolean;
  formularyActive: boolean;
  sortOrder: number;
  source: string;
  sourceVersion: string;
};

type Catalogue = { sources: Array<{ source: string; version: string; importedAt: string }>; clinicEntries: number };

type CatalogueDrug = { id: string; inn: string; tradeName: string | null; form: string | null; strength: string | null; rxOnly: boolean; controlled: boolean; inFormulary: boolean };

const YES_NO = [
  { value: "", label: "Tanlang" },
  { value: "yes", label: "Ha" },
  { value: "no", label: "Yo‘q" },
];

const EMPTY_FORM = { inn: "", innLatin: "", tradeName: "", form: "", strength: "", manufacturer: "", drugClass: "", aliases: "", rxOnly: "", controlled: "" };

/**
 * The clinic's formulary (specification RX-02): the medicines its doctors see
 * first, and — until an official or licensed catalogue is loaded — the entries
 * the clinic keeps itself. Every entry is typed or chosen by the clinic;
 * nothing is generated. "Retsept bilan" and "Nazoratdagi" must be answered
 * explicitly for each medicine the clinic adds: a controlled medicine can be
 * listed here but can never be prescribed through Health AI.
 */
export default function FormularyPage() {
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [catalogue, setCatalogue] = useState<Catalogue | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [orders, setOrders] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    try {
      const res = await adminApi.get<{ entries: Entry[]; catalogue: Catalogue }>("/api/admin/formulary");
      setEntries(res.entries);
      setCatalogue(res.catalogue);
      setOrders({});
    } catch (e) {
      setError(e instanceof AdminApiError ? e.message : "Dorilar ro‘yxatini yuklab bo‘lmadi");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const act = async (run: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await run();
      await load();
    } catch (e) {
      setError(e instanceof AdminApiError ? e.message : "Amalni bajarib bo‘lmadi");
    } finally {
      setBusy(false);
    }
  };

  const set = (field: keyof typeof EMPTY_FORM) => (value: string) => setForm((current) => ({ ...current, [field]: value }));
  const canCreate = form.inn.trim().length > 0 && form.rxOnly !== "" && form.controlled !== "";

  const create = () =>
    act(async () => {
      await adminApi.post("/api/admin/formulary", {
        inn: form.inn.trim(),
        innLatin: form.innLatin.trim() || undefined,
        tradeName: form.tradeName.trim() || undefined,
        form: form.form.trim() || undefined,
        strength: form.strength.trim() || undefined,
        manufacturer: form.manufacturer.trim() || undefined,
        drugClass: form.drugClass.trim() || undefined,
        aliases: form.aliases
          .split(",")
          .map((a) => a.trim())
          .filter(Boolean),
        rxOnly: form.rxOnly === "yes",
        controlled: form.controlled === "yes",
        sortOrder: 0,
      });
      setForm(EMPTY_FORM);
    });

  return (
    <div>
      <PageHeader
        title="Dorilar ro‘yxati"
        subtitle="Shifokorlar retsept yozishda shu ro‘yxatdagi dorilarni birinchi bo‘lib ko‘radi. Rasmiy reyestr yuklanmaguncha klinika dorilarni o‘zi kiritadi."
      />
      {error && <AError message={error} />}

      {catalogue && (
        <p className="mb-4 text-sm text-ink-muted">
          Umumiy ro‘yxat manbasi:{" "}
          {catalogue.sources.length > 0 ? catalogue.sources.map((s) => `${s.source}, ${s.version}`).join(" · ") : "hali yuklanmagan"} · Klinika
          kiritgan dorilar: {catalogue.clinicEntries} ta
        </p>
      )}

      {catalogue && catalogue.sources.length > 0 && (
        <Card className="mb-6">
          <p className="mb-2 text-sm font-semibold text-foreground">Umumiy ro‘yxatdan qo‘shish</p>
          <SearchPicker<CatalogueDrug>
            endpoint="/api/admin/formulary/search"
            resultKey="drugs"
            itemKey={(d) => d.id}
            onPick={(d) => void act(() => adminApi.post("/api/admin/formulary", { drugId: d.id, sortOrder: 0 }))}
            placeholder="Dori nomi (kamida 2 ta harf)"
            ariaLabel="Umumiy ro‘yxatdan dori qidirish"
            emptyText="Dori topilmadi"
            renderItem={(d) => (
              <span className="flex flex-wrap items-center gap-1.5">
                <span className="font-semibold text-foreground">{drugLabel(d)}</span>
                {d.rxOnly && <ABadge tone="blue">Retsept bilan</ABadge>}
                {d.controlled && <ABadge tone="red">Nazoratdagi</ABadge>}
                {d.inFormulary && <ABadge tone="green">Ro‘yxatda bor</ABadge>}
              </span>
            )}
          />
        </Card>
      )}

      <Card className="mb-6">
        <p className="mb-1 text-sm font-semibold text-foreground">Klinika o‘zi kiritadigan dori</p>
        <p className="mb-3 text-xs text-ink-muted">
          Ma’lumotni dori qadog‘i yoki yo‘riqnomasidan kiriting. «Retsept bilan» va «Nazoratdagi» savollariga har bir dori uchun aniq javob bering.
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <p className="mb-1 text-xs font-medium text-ink-muted">Xalqaro nomi (INN) *</p>
            <AInput value={form.inn} onChange={set("inn")} aria-label="Xalqaro nomi" maxLength={160} />
          </div>
          <div>
            <p className="mb-1 text-xs font-medium text-ink-muted">INN lotincha (ixtiyoriy)</p>
            <AInput value={form.innLatin} onChange={set("innLatin")} aria-label="INN lotincha" maxLength={160} />
          </div>
          <div>
            <p className="mb-1 text-xs font-medium text-ink-muted">Savdo nomi</p>
            <AInput value={form.tradeName} onChange={set("tradeName")} aria-label="Savdo nomi" maxLength={160} />
          </div>
          <div>
            <p className="mb-1 text-xs font-medium text-ink-muted">Ishlab chiqaruvchi</p>
            <AInput value={form.manufacturer} onChange={set("manufacturer")} aria-label="Ishlab chiqaruvchi" maxLength={160} />
          </div>
          <div>
            <p className="mb-1 text-xs font-medium text-ink-muted">Shakli (tabletka, kapsula…)</p>
            <AInput value={form.form} onChange={set("form")} aria-label="Dori shakli" maxLength={80} />
          </div>
          <div>
            <p className="mb-1 text-xs font-medium text-ink-muted">Dozasi (masalan 500 mg)</p>
            <AInput value={form.strength} onChange={set("strength")} aria-label="Dori dozasi" maxLength={80} />
          </div>
          <div>
            <p className="mb-1 text-xs font-medium text-ink-muted">Dorilar guruhi (allergiya ogohlantirishi uchun)</p>
            <AInput value={form.drugClass} onChange={set("drugClass")} aria-label="Dorilar guruhi" maxLength={120} />
          </div>
          <div>
            <p className="mb-1 text-xs font-medium text-ink-muted">Boshqa yozilishlari (vergul bilan)</p>
            <AInput value={form.aliases} onChange={set("aliases")} aria-label="Boshqa yozilishlari" />
          </div>
          <div>
            <p className="mb-1 text-xs font-medium text-ink-muted">Retsept bilan beriladimi? *</p>
            <ASelect value={form.rxOnly} onChange={set("rxOnly")} options={YES_NO} aria-label="Retsept bilan beriladimi" />
          </div>
          <div>
            <p className="mb-1 text-xs font-medium text-ink-muted">Nazoratdagi (giyohvandlik/psixotrop) dorimi? *</p>
            <ASelect value={form.controlled} onChange={set("controlled")} options={YES_NO} aria-label="Nazoratdagi dorimi" />
          </div>
        </div>
        <div className="mt-3">
          <AButton loading={busy} disabled={!canCreate} onClick={() => void create()}>
            Ro‘yxatga qo‘shish
          </AButton>
        </div>
      </Card>

      {entries === null ? (
        <Card>
          <LoadingRow />
        </Card>
      ) : entries.length === 0 ? (
        <Card>
          <AEmpty title="Ro‘yxat bo‘sh" subtitle="Yuqoridagi shakl orqali dorilarni qo‘shing." />
        </Card>
      ) : (
        <ATable headers={["Dori", "Belgilar", "Manba", "Tartib", ""]}>
          {entries.map((entry) => (
            <tr key={entry.drugId} className={entry.drugActive && entry.formularyActive ? undefined : "opacity-60"}>
              <td className="px-4 py-3">
                <p className="font-medium text-foreground">{drugLabel(entry)}</p>
                {entry.manufacturer && <p className="text-xs text-ink-muted">{entry.manufacturer}</p>}
              </td>
              <td className="px-4 py-3">
                <div className="flex flex-wrap gap-1">
                  {entry.rxOnly && <ABadge tone="blue">Retsept bilan</ABadge>}
                  {entry.controlled && <ABadge tone="red">Nazoratdagi — yozilmaydi</ABadge>}
                  {!entry.drugActive && <ABadge tone="gray">Ro‘yxatdan chiqarilgan</ABadge>}
                  {entry.drugActive && entry.inFormulary && !entry.formularyActive && <ABadge tone="gray">O‘chirilgan</ABadge>}
                </div>
              </td>
              <td className="px-4 py-3 text-xs text-ink-muted">{entry.clinicOwned ? `Klinika, ${entry.sourceVersion}` : `${entry.source}, ${entry.sourceVersion}`}</td>
              <td className="px-4 py-3">
                {entry.inFormulary && entry.drugActive && (
                  <div className="flex items-center gap-1">
                    <AInput
                      value={orders[entry.drugId] ?? String(entry.sortOrder)}
                      onChange={(v) => setOrders((current) => ({ ...current, [entry.drugId]: v }))}
                      inputMode="numeric"
                      className="w-20"
                      aria-label={`${entry.inn}: tartib raqami`}
                    />
                    {orders[entry.drugId] !== undefined && orders[entry.drugId] !== String(entry.sortOrder) && /^\d{1,6}$/.test(orders[entry.drugId]) && (
                      <AButton
                        size="sm"
                        variant="outline"
                        loading={busy}
                        onClick={() => void act(() => adminApi.patch(`/api/admin/formulary/${entry.drugId}`, { sortOrder: Number(orders[entry.drugId]) }))}
                      >
                        Saqlash
                      </AButton>
                    )}
                  </div>
                )}
              </td>
              <td className="px-4 py-3 text-right">
                {entry.drugActive && entry.inFormulary && (
                  <div className="flex justify-end gap-2">
                    <AButton
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() => void act(() => adminApi.patch(`/api/admin/formulary/${entry.drugId}`, { active: !entry.formularyActive }))}
                    >
                      {entry.formularyActive ? "O‘chirib qo‘yish" : "Yoqish"}
                    </AButton>
                    <AButton size="sm" variant="ghost" disabled={busy} onClick={() => void act(() => adminApi.del(`/api/admin/formulary/${entry.drugId}`))}>
                      Olib tashlash
                    </AButton>
                  </div>
                )}
              </td>
            </tr>
          ))}
        </ATable>
      )}
    </div>
  );
}

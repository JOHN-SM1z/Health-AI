"use client";

import { useEffect, useState } from "react";
import { ABadge, AButton, AError, AInput, ASelect, ATextArea, Card } from "@/components/admin/ui";
import { adminApi, AdminApiError } from "@/lib/admin/client";

/**
 * External laboratories (Phase 15): which adapter speaks to each, its
 * non-secret settings, the NAME of the environment variable holding its
 * credential (never the credential), and its codes for the clinic's tests
 * and parameters. No real laboratory is integrated yet; the mock adapter is
 * for testing only and is unavailable in production.
 */

type Code = { kind: "test" | "parameter"; internalId: string; externalCode: string };
type Provider = {
  id: string;
  code: string;
  name: string;
  adapter: string;
  adapterAvailable: boolean;
  active: boolean;
  config: Record<string, unknown>;
  credentialRef: string | null;
  credentialPresent: boolean | null;
  sendPatientName: boolean;
  codes: Code[];
};
type TestRef = { id: string; code: string; name: string };
type ParamRef = { id: string; test_id: string; code: string; name: string };

const err = (e: unknown, fallback: string) => (e instanceof AdminApiError ? e.message : fallback);

export function LabProvidersTab({ tests, parameters }: { tests: TestRef[]; parameters: ParamRef[] }) {
  const [providers, setProviders] = useState<Provider[] | null>(null);
  const [adapters, setAdapters] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [form, setForm] = useState({ code: "", name: "", adapter: "", credentialRef: "", config: "{}", sendPatientName: false });
  const [codesFor, setCodesFor] = useState<Provider | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});

  const load = async () => {
    try {
      const res = await adminApi.get<{ providers: Provider[]; adapters: string[] }>("/api/admin/lab/providers");
      setProviders(res.providers);
      setAdapters(res.adapters);
      setForm((f) => ({ ...f, adapter: f.adapter || res.adapters[0] || "" }));
    } catch (e) {
      setError(err(e, "Laboratoriyalarni yuklab bo‘lmadi"));
    }
  };
  useEffect(() => {
    void load();
  }, []);

  const parseConfig = (text: string) => {
    try {
      const v = JSON.parse(text || "{}");
      return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  };

  const create = async () => {
    setError(null);
    setNotice(null);
    const config = parseConfig(form.config);
    if (!config) return setError("Sozlamalar JSON obyekt bo‘lishi kerak");
    try {
      await adminApi.post("/api/admin/lab/providers", {
        code: form.code.trim(),
        name: form.name.trim(),
        adapter: form.adapter,
        config,
        credentialRef: form.credentialRef.trim() || null,
        sendPatientName: form.sendPatientName,
      });
      setForm({ code: "", name: "", adapter: adapters[0] ?? "", credentialRef: "", config: "{}", sendPatientName: false });
      setNotice("Laboratoriya qo‘shildi");
      await load();
    } catch (e) {
      setError(err(e, "Saqlab bo‘lmadi"));
    }
  };

  const toggle = async (p: Provider) => {
    setError(null);
    try {
      await adminApi.patch(`/api/admin/lab/providers/${p.id}`, {
        name: p.name, adapter: p.adapter, active: !p.active, config: p.config, credentialRef: p.credentialRef, sendPatientName: p.sendPatientName,
      });
      await load();
    } catch (e) {
      setError(err(e, "Saqlab bo‘lmadi"));
    }
  };

  const openCodes = (p: Provider) => {
    setCodesFor(p);
    setDraft(Object.fromEntries(p.codes.map((c) => [`${c.kind}:${c.internalId}`, c.externalCode])));
  };
  const saveCodes = async () => {
    if (!codesFor) return;
    setError(null);
    const codes: Code[] = Object.entries(draft)
      .filter(([, v]) => v.trim())
      .map(([k, v]) => {
        const [kind, internalId] = k.split(":");
        return { kind: kind as Code["kind"], internalId, externalCode: v.trim() };
      });
    try {
      await adminApi.put(`/api/admin/lab/providers/${codesFor.id}/codes`, { codes });
      setNotice("Kodlar saqlandi");
      setCodesFor(null);
      await load();
    } catch (e) {
      setError(err(e, "Kodlarni saqlab bo‘lmadi"));
    }
  };

  return (
    <div className="space-y-4">
      {error && <AError message={error} />}
      {notice && <p role="status" className="rounded-lg bg-pine-tint px-3 py-2 text-sm text-pine-deep">{notice}</p>}
      <Card className="space-y-2">
        <p className="text-sm text-ink-muted">
          Tashqi laboratoriya integratsiyasi adapter orqali ishlaydi. Hozircha haqiqiy laboratoriya ulanmagan — faqat sinov (mock) adapteri bor va u
          ishlab chiqarish muhitida o‘chiq. Maxfiy kalit hech qachon bazada saqlanmaydi: faqat uni saqlovchi muhit o‘zgaruvchisining nomi (LAB_PROVIDER_…).
        </p>
      </Card>

      <section aria-label="Tashqi laboratoriyalar" className="space-y-2">
        {providers?.map((p) => (
          <Card key={p.id} className="flex flex-wrap items-center justify-between gap-2">
            <div className="text-sm">
              <p className="font-medium">{p.name} <span className="text-xs text-ink-muted">({p.code} · {p.adapter})</span></p>
              <p className="text-xs text-ink-muted">
                {p.codes.filter((c) => c.kind === "test").length} tahlil, {p.codes.filter((c) => c.kind === "parameter").length} ko‘rsatkich kodi
                {p.credentialRef ? ` · kalit: ${p.credentialRef} ${p.credentialPresent ? "(o‘rnatilgan)" : "(o‘rnatilmagan)"}` : ""}
                {p.sendPatientName ? " · bemor ismi yuboriladi" : ""}
              </p>
            </div>
            <div className="flex items-center gap-2">
              {!p.adapterAvailable && <ABadge tone="red">Adapter mavjud emas</ABadge>}
              <ABadge tone={p.active ? "green" : "gray"}>{p.active ? "Faol" : "O‘chiq"}</ABadge>
              <AButton size="sm" variant="outline" onClick={() => openCodes(p)}>Kodlar</AButton>
              <AButton size="sm" variant="ghost" onClick={() => void toggle(p)}>{p.active ? "O‘chirish" : "Yoqish"}</AButton>
            </div>
          </Card>
        ))}
        {providers?.length === 0 && <p className="text-sm text-ink-muted">Tashqi laboratoriya qo‘shilmagan.</p>}
      </section>

      {codesFor && (
        <Card className="space-y-3">
          <h3 className="font-display text-sm font-semibold">{codesFor.name}: tahlil va ko‘rsatkich kodlari</h3>
          <div className="space-y-3" aria-label="Kodlar">
            {tests.map((t) => (
              <div key={t.id} className="space-y-1 rounded-lg border border-hairline p-2">
                <label className="flex items-center gap-2 text-sm">
                  <span className="w-1/2">{t.name} <span className="text-xs text-ink-muted">({t.code})</span></span>
                  <AInput aria-label={`${t.name}: laboratoriya kodi`} value={draft[`test:${t.id}`] ?? ""} onChange={(v) => setDraft((d) => ({ ...d, [`test:${t.id}`]: v }))} />
                </label>
                {parameters.filter((p) => p.test_id === t.id).map((p) => (
                  <label key={p.id} className="flex items-center gap-2 pl-4 text-xs">
                    <span className="w-1/2">{p.name} ({p.code})</span>
                    <AInput aria-label={`${t.name} · ${p.name}: laboratoriya kodi`} value={draft[`parameter:${p.id}`] ?? ""} onChange={(v) => setDraft((d) => ({ ...d, [`parameter:${p.id}`]: v }))} />
                  </label>
                ))}
              </div>
            ))}
          </div>
          <div className="flex gap-2">
            <AButton onClick={() => void saveCodes()}>Kodlarni saqlash</AButton>
            <AButton variant="ghost" onClick={() => setCodesFor(null)}>Yopish</AButton>
          </div>
        </Card>
      )}

      {adapters.length > 0 && (
        <Card className="space-y-3">
          <h3 className="font-display text-sm font-semibold">Yangi tashqi laboratoriya</h3>
          <div className="grid gap-2 md:grid-cols-2">
            <AInput aria-label="Kod" placeholder="kod (masalan: reflab)" value={form.code} onChange={(v) => setForm({ ...form, code: v })} />
            <AInput aria-label="Nomi" placeholder="Nomi" value={form.name} onChange={(v) => setForm({ ...form, name: v })} />
            <ASelect aria-label="Adapter" value={form.adapter} onChange={(v) => setForm({ ...form, adapter: v })} options={adapters.map((a) => ({ value: a, label: a }))} />
            <AInput aria-label="Maxfiy kalit o‘zgaruvchisi" placeholder="LAB_PROVIDER_… (ixtiyoriy)" value={form.credentialRef} onChange={(v) => setForm({ ...form, credentialRef: v })} />
          </div>
          <ATextArea aria-label="Sozlamalar (JSON)" value={form.config} onChange={(v) => setForm({ ...form, config: v })} rows={3} />
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={form.sendPatientName} onChange={(e) => setForm({ ...form, sendPatientName: e.target.checked })} />
            Bemor ismini yuborish (faqat laboratoriya talab qilsa)
          </label>
          <AButton onClick={() => void create()}>Qo‘shish</AButton>
        </Card>
      )}
    </div>
  );
}

"use client";

import { useEffect, useState } from "react";
import { PageHeader, Card, AEmpty, AError, AButton, AInput, ASelect, LoadingRow } from "@/components/admin/ui";
import { BotIntegrationPanel } from "@/components/admin/bot-integration";
import { Settings as SettingsIcon } from "lucide-react";
import { parseOperationsSettings, type OperationsSettings } from "@/lib/operations/settings";
import { adminApi, AdminApiError } from "@/lib/admin/client";

type Setting = { key: string; value: unknown };

const SETTING_DEFS = [
  { key: "opening_hours", label: "Ish vaqti (matn)", placeholder: "Har kuni 09:00 — 18:00" },
  { key: "address", label: "Manzil", placeholder: "Toshkent sh., …" },
  { key: "phone", label: "Telefon", placeholder: "+998 90 123 45 67" },
  { key: "ai_greeting", label: "Bot salomlashuvi", placeholder: "Assalomu alaykum! …" },
];

export default function SettingsPage() {
  const [operations, setOperations] = useState<OperationsSettings>(parseOperationsSettings(null));
  const [settings, setSettings] = useState<Setting[] | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void adminApi.get<{settings:Setting[]}>("/api/admin/settings").then(({settings:data}) => {
      setSettings(data ?? []);
      setOperations(parseOperationsSettings(data?.find(s => s.key === "clinic_operations")?.value));
      const v: Record<string, string> = {};
      for (const s of data ?? []) {
        const vv = s.value as { text?: string } | null;
        v[s.key] = vv?.text ?? "";
      }
      setValues(v);
    }).catch(() => setError("Sozlamalarni yuklab bo‘lmadi"));
  }, []);

  const save = async () => {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      for (const def of SETTING_DEFS) {
        const text = values[def.key] ?? "";
        if (!text.trim()) continue;
        await adminApi.put("/api/admin/settings", { key: def.key, value: { text } });
      }
      await adminApi.put("/api/admin/settings", { key: "clinic_operations", value: operations });
      setSaved(true);
    } catch (e) {
      setError(e instanceof AdminApiError ? e.message : "Saqlab bo‘lmadi");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <PageHeader title="Sozlamalar" subtitle="Klinika matn sozlamalari" />
      {error && <AError message={error} />}
      {settings === null ? (
        <Card><LoadingRow /></Card>
      ) : (
        <Card className="flex max-w-xl flex-col gap-4">
          <label className="text-sm">Qabul tartibi<ASelect value={operations.mode} onChange={mode => setOperations({ ...operations, mode: mode as OperationsSettings["mode"] })} options={[{value:"walk_in",label:"Jonli navbat"},{value:"mixed",label:"Navbat va oldindan yozilish"},{value:"scheduled",label:"Oldindan yozilish"}]} /></label>
          {SETTING_DEFS.map((def) => (
            <div key={def.key}>
              <p className="mb-1 text-sm font-medium text-ink-muted">{def.label}</p>
              <AInput
                value={values[def.key] ?? ""}
                onChange={(v) => setValues((prev) => ({ ...prev, [def.key]: v }))}
                placeholder={def.placeholder}
                aria-label={def.label}
              />
            </div>
          ))}
          {saved && <p className="text-sm text-pine-deep">Saqlangan ✓</p>}
          <div>
            <AButton loading={busy} onClick={() => void save()}>Saqlash</AButton>
          </div>
        </Card>
      )}
      <div className="mt-4 max-w-xl">
        <BotIntegrationPanel />
      </div>
      <div className="mt-4 max-w-xl">
        <Card>
          <AEmpty
            title="AI bilim bazasi"
            subtitle="AI greeting, manzil va telefon ma'lumotlari bot bilim bazasiga avtomatik kiritiladi (ai_knowledge refresh orqali)."
            icon={<SettingsIcon className="h-6 w-6" />}
          />
        </Card>
      </div>
    </div>
  );
}

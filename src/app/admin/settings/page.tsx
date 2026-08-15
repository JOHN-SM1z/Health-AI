"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/browser";
import { PageHeader, Card, AEmpty, AError, AButton, AInput, LoadingRow } from "@/components/admin/ui";
import { Settings as SettingsIcon } from "lucide-react";
import { adminApi, AdminApiError } from "@/lib/admin/client";

type Setting = { key: string; value: unknown };

const SETTING_DEFS = [
  { key: "opening_hours", label: "Ish vaqti (matn)", placeholder: "Har kuni 09:00 — 18:00" },
  { key: "address", label: "Manzil", placeholder: "Toshkent sh., …" },
  { key: "phone", label: "Telefon", placeholder: "+998 90 123 45 67" },
  { key: "ai_greeting", label: "Bot salomlashuvi", placeholder: "Assalomu alaykum! …" },
];

export default function SettingsPage() {
  const [settings, setSettings] = useState<Setting[] | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const supabase = createClient();
    void supabase.from("app_settings").select("key, value").then(({ data }) => {
      setSettings(data ?? []);
      const v: Record<string, string> = {};
      for (const s of data ?? []) {
        const vv = s.value as { text?: string } | null;
        v[s.key] = vv?.text ?? "";
      }
      setValues(v);
    });
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
      setSaved(true);
    } catch (e) {
      setError(e instanceof AdminApiError ? e.message : "Saqlab bo‘lmadi");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <PageHeader title="Sozlamalar" subtitle="Klinika matn sozlamalari (owner)" />
      {error && <AError message={error} />}
      {settings === null ? (
        <Card><LoadingRow /></Card>
      ) : (
        <Card className="flex max-w-xl flex-col gap-4">
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
        <Card>
          <AEmpty
            title="Bot sozlamalari"
            subtitle="AI greeting, manzil va telefon ma'lumotlari bot bilim bazasiga avtomatik kiritiladi (ai_knowledge refresh orqali)."
            icon={<SettingsIcon className="h-6 w-6" />}
          />
        </Card>
      </div>
    </div>
  );
}
"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/browser";
import { PageHeader, Card, ABadge, ATable, AEmpty, AError, AButton, AInput, ATextArea, LoadingRow } from "@/components/admin/ui";
import { Sparkles } from "lucide-react";
import { adminApi, AdminApiError } from "@/lib/admin/client";

type Specialty = { id: string; name: string; description: string | null; active: boolean; sort_order: number };

export default function SpecialtiesPage() {
  const [rows, setRows] = useState<Specialty[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Specialty | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");

  const load = async () => {
    const supabase = createClient();
    const { data, error: err } = await supabase.from("specialties").select("*").order("sort_order");
    if (err) {
      setError("Yo‘nalishlarni yuklab bo‘lmadi");
      return;
    }
    setRows(data ?? []);
  };

  useEffect(() => {
    void load();
  }, []);

  const save = async () => {
    if (!name.trim()) {
      setError("Nomi kiritilishi shart");
      return;
    }
    try {
      if (editing?.id) {
        await adminApi.patch(`/api/admin/specialties?id=${editing.id}`, { name: name.trim(), description: description || undefined });
      } else {
        await adminApi.post("/api/admin/specialties", { name: name.trim(), description: description || undefined });
      }
      setEditing(null);
      setName("");
      setDescription("");
      setError(null);
      void load();
    } catch (e) {
      setError(e instanceof AdminApiError ? e.message : "Saqlab bo‘lmadi");
    }
  };

  return (
    <div>
      <PageHeader title="Yo‘nalishlar" subtitle="Shifokorlar va xizmatlar guruhlanishi" />
      {error && <AError message={error} />}
      {rows === null ? (
        <Card><LoadingRow /></Card>
      ) : rows.length === 0 ? (
        <Card>
          <AEmpty title="Yo‘nalishlar yo‘q" subtitle="Birinchi yo‘nalishni qo‘shing" icon={<Sparkles className="h-6 w-6" />} />
        </Card>
      ) : (
        <ATable headers={["Nomi", "Tavsif", "Holat", "Amallar"]}>
          {rows.map((s) => (
            <tr key={s.id} className="hover:bg-sand">
              <td className="px-4 py-3 font-medium text-foreground">{s.name}</td>
              <td className="px-4 py-3 text-ink-muted">{s.description ?? "—"}</td>
              <td className="px-4 py-3"><ABadge tone={s.active ? "green" : "gray"}>{s.active ? "Faol" : "Nofaol"}</ABadge></td>
              <td className="px-4 py-3">
                <div className="flex gap-1.5">
                  <AButton
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setEditing(s);
                      setName(s.name);
                      setDescription(s.description ?? "");
                    }}
                  >
                    Tahrirlash
                  </AButton>
                  <AButton
                    size="sm"
                    variant="danger"
                    onClick={() => {
                      void adminApi.del(`/api/admin/specialties?id=${s.id}`).then(() => void load());
                    }}
                  >
                    O‘chirish
                  </AButton>
                </div>
              </td>
            </tr>
          ))}
        </ATable>
      )}

      <Card className="mt-4 flex flex-col gap-3">
        <p className="text-sm font-bold text-foreground">{editing?.id ? "Yo‘nalishni tahrirlash" : "Yangi yo‘nalish"}</p>
        <AInput value={name} onChange={setName} placeholder="Nomi (masalan: Kardiologiya)" aria-label="Nomi" />
        <ATextArea value={description} onChange={setDescription} placeholder="Tavsif" rows={2} />
        <div className="flex gap-2">
          {editing?.id && <AButton variant="outline" onClick={() => { setEditing(null); setName(""); setDescription(""); }}>Bekor</AButton>}
          <AButton onClick={() => void save()}>Saqlash</AButton>
        </div>
      </Card>
    </div>
  );
}
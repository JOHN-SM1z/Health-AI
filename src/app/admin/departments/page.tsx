"use client";

import { useCallback, useEffect, useState } from "react";
import { Building2 } from "lucide-react";
import { PageHeader, Card, ATable, AEmpty, AError, AButton, AInput, ASelect, ABadge, LoadingRow } from "@/components/admin/ui";
import { adminApi, AdminApiError } from "@/lib/admin/client";

type Kind = "clinical" | "laboratory" | "reception" | "cashier" | "management" | "other";
type Department = { id: string; name: string; kind: Kind; members: number };

const KIND_LABELS: Record<Kind, string> = {
  clinical: "Klinik bo‘lim",
  laboratory: "Laboratoriya",
  reception: "Qabulxona",
  cashier: "Kassa",
  management: "Rahbariyat",
  other: "Boshqa",
};
const KIND_OPTIONS = (Object.keys(KIND_LABELS) as Kind[]).map((k) => ({ value: k, label: KIND_LABELS[k] }));

/**
 * The clinic's departments (bo‘limlar). They organise the team — who works where — and filter staff lists; what
 * each person may do is still set by their role on the “Xodimlar” page.
 */
export default function DepartmentsPage() {
  const [items, setItems] = useState<Department[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [kind, setKind] = useState<Kind>("clinical");
  const [busy, setBusy] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setItems((await adminApi.get<{ departments: Department[] }>("/api/admin/departments")).departments);
    } catch {
      setItems([]);
      setError("Bo‘limlarni yuklab bo‘lmadi");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const run = async (key: string, action: () => Promise<unknown>) => {
    setBusy(key);
    setError(null);
    try {
      await action();
      await load();
      return true;
    } catch (e) {
      setError(e instanceof AdminApiError ? e.message : "Amalni bajarib bo‘lmadi");
      return false;
    } finally {
      setBusy(null);
    }
  };

  return (
    <div>
      <PageHeader title="Bo‘limlar" subtitle="Klinika tuzilmasi: xodimlar qaysi bo‘limda ishlaydi" />
      {error && <AError message={error} />}

      {items === null ? (
        <Card>
          <LoadingRow />
        </Card>
      ) : items.length === 0 ? (
        <Card>
          <AEmpty title="Bo‘limlar yo‘q" subtitle="Quyida birinchi bo‘limni qo‘shing" icon={<Building2 className="h-6 w-6" />} />
        </Card>
      ) : (
        <ATable headers={["Bo‘lim", "Turi", "Xodimlar", "Amallar"]}>
          {items.map((d) => (
            <tr key={d.id} className="hover:bg-sand">
              <td className="px-4 py-3">
                {editing?.id === d.id ? (
                  <div className="flex gap-2">
                    <AInput value={editing.name} onChange={(v) => setEditing({ id: d.id, name: v })} aria-label="Bo‘lim nomi" />
                    <AButton
                      size="sm"
                      loading={busy === d.id}
                      onClick={() =>
                        void run(d.id, () => adminApi.patch("/api/admin/departments", { id: d.id, name: editing.name.trim() })).then((okay) => okay && setEditing(null))
                      }
                    >
                      Saqlash
                    </AButton>
                  </div>
                ) : (
                  <p className="font-medium text-foreground">{d.name}</p>
                )}
              </td>
              <td className="px-4 py-3">
                <div className="w-44">
                  <ASelect
                    value={d.kind}
                    onChange={(v) => void run(d.id, () => adminApi.patch("/api/admin/departments", { id: d.id, kind: v }))}
                    options={KIND_OPTIONS}
                    aria-label={`${d.name} turi`}
                  />
                </div>
              </td>
              <td className="px-4 py-3">
                <ABadge tone={d.members > 0 ? "pine" : "neutral"}>{d.members} kishi</ABadge>
              </td>
              <td className="px-4 py-3">
                {confirmDelete === d.id ? (
                  <div className="flex flex-wrap gap-1.5">
                    <AButton size="sm" variant="danger" loading={busy === d.id} onClick={() => void run(d.id, () => adminApi.del(`/api/admin/departments?id=${d.id}`))}>
                      Ha, o‘chirish
                    </AButton>
                    <AButton size="sm" variant="outline" onClick={() => setConfirmDelete(null)}>
                      Bekor
                    </AButton>
                  </div>
                ) : (
                  <div className="flex flex-wrap gap-1.5">
                    <AButton size="sm" variant="outline" onClick={() => setEditing({ id: d.id, name: d.name })}>
                      Nomini o‘zgartirish
                    </AButton>
                    <AButton size="sm" variant="ghost" onClick={() => setConfirmDelete(d.id)}>
                      O‘chirish
                    </AButton>
                  </div>
                )}
              </td>
            </tr>
          ))}
        </ATable>
      )}
      {confirmDelete && (
        <p className="mt-2 text-xs text-ink-muted">Bo‘lim o‘chirilsa, undagi xodimlar saqlanadi — ular bo‘limsiz qoladi.</p>
      )}

      <Card className="mt-4 flex flex-col gap-3">
        <p className="text-sm font-bold text-foreground">Yangi bo‘lim</p>
        <div className="flex flex-wrap gap-2">
          <div className="min-w-56 flex-1">
            <AInput value={name} onChange={setName} placeholder="Masalan: Kardiologiya" aria-label="Yangi bo‘lim nomi" />
          </div>
          <div className="w-48">
            <ASelect value={kind} onChange={(v) => setKind(v as Kind)} options={KIND_OPTIONS} aria-label="Yangi bo‘lim turi" />
          </div>
          <AButton
            loading={busy === "add"}
            onClick={() => {
              if (name.trim().length < 2) return setError("Bo‘lim nomini kiriting");
              void run("add", () => adminApi.post("/api/admin/departments", { name: name.trim(), kind })).then((okay) => okay && setName(""));
            }}
          >
            Qo‘shish
          </AButton>
        </div>
      </Card>
    </div>
  );
}

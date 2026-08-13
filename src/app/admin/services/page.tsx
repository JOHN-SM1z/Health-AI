"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/browser";
import { PageHeader, Card, ABadge, ATable, AEmpty, AError, AButton, AInput, ATextArea, ASelect } from "@/components/admin/ui";
import { adminApi, AdminApiError, formatPrice } from "@/lib/admin/client";

type Service = {
  id: string;
  name: string;
  description: string | null;
  duration_minutes: number;
  price: number;
  active: boolean;
  preparation_text: string | null;
  specialties: { name: string } | null;
  doctor_services: { doctors: { id: string; name: string } }[] | null;
};

export default function ServicesPage() {
  const [rows, setRows] = useState<Service[] | null>(null);
  const [specialties, setSpecialties] = useState<{ id: string; name: string }[]>([]);
  const [doctors, setDoctors] = useState<{ id: string; name: string }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Service | null>(null);

  const load = async () => {
    const supabase = createClient();
    const [{ data: services, error }, { data: specs }, { data: docs }] = await Promise.all([
      supabase
        .from("services")
        .select("*, specialties(name), doctor_services(doctors(id, name))")
        .order("sort_order", { ascending: true }),
      supabase.from("specialties").select("id, name").eq("active", true).order("name"),
      supabase.from("doctors").select("id, name").eq("active", true).order("name"),
    ]);
    if (error) {
      setError("Xizmatlarni yuklab bo‘lmadi");
      return;
    }
    setRows(services ?? []);
    setSpecialties(specs ?? []);
    setDoctors(docs ?? []);
  };

  useEffect(() => {
    void load();
  }, []);

  return (
    <div>
      <PageHeader
        title="Xizmatlar"
        subtitle="Narxlar, davomiylik va shifokorlar"
        action={
          <AButton
            onClick={() =>
              setEditing({
                id: "",
                name: "",
                description: "",
                duration_minutes: 30,
                price: 0,
                active: true,
                preparation_text: "",
                specialties: null,
                doctor_services: [],
              })
            }
          >
            + Xizmat qo‘shish
          </AButton>
        }
      />
      {error && <AError message={error} />}

      {rows === null ? (
        <Card><div className="h-2 w-full animate-pulse rounded bg-slate-200" /></Card>
      ) : rows.length === 0 ? (
        <Card><AEmpty title="Xizmatlar yo‘q" subtitle="Birinchi xizmatni qo‘shing" /></Card>
      ) : (
        <ATable headers={["Nomi", "Yo‘nalish", "Davomiylik", "Narx", "Shifokorlar", "Holat", "Amallar"]}>
          {rows.map((s) => (
            <tr key={s.id} className="hover:bg-slate-50">
              <td className="px-4 py-3">
                <p className="font-medium text-slate-900">{s.name}</p>
                {s.description && <p className="max-w-xs truncate text-xs text-slate-400">{s.description}</p>}
              </td>
              <td className="px-4 py-3 text-slate-800">{s.specialties?.name ?? "—"}</td>
              <td className="px-4 py-3 text-slate-800">{s.duration_minutes} daq.</td>
              <td className="px-4 py-3 font-semibold text-slate-900">{formatPrice(s.price)}</td>
              <td className="px-4 py-3">
                <div className="flex max-w-44 flex-wrap gap-1">
                  {(s.doctor_services ?? []).length === 0 ? (
                    <span className="text-xs text-slate-300">Yo‘q</span>
                  ) : (
                    s.doctor_services!.map((ds) => (
                      <span key={ds.doctors.id} className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600">
                        {ds.doctors.name}
                      </span>
                    ))
                  )}
                </div>
              </td>
              <td className="px-4 py-3"><ABadge tone={s.active ? "green" : "gray"}>{s.active ? "Faol" : "Nofaol"}</ABadge></td>
              <td className="px-4 py-3"><AButton size="sm" variant="outline" onClick={() => setEditing(s)}>Boshqarish</AButton></td>
            </tr>
          ))}
        </ATable>
      )}

      {editing && (
        <ServiceModal
          service={editing}
          specialties={specialties}
          doctors={doctors}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void load();
          }}
          onError={setError}
        />
      )}
    </div>
  );
}

function ServiceModal({
  service,
  specialties,
  doctors,
  onClose,
  onSaved,
  onError,
}: {
  service: Service;
  specialties: { id: string; name: string }[];
  doctors: { id: string; name: string }[];
  onClose: () => void;
  onSaved: () => void;
  onError: (m: string) => void;
}) {
  const [name, setName] = useState(service.name);
  const [description, setDescription] = useState(service.description ?? "");
  const [duration, setDuration] = useState(String(service.duration_minutes));
  const [price, setPrice] = useState(String(service.price));
  const [preparation, setPreparation] = useState(service.preparation_text ?? "");
  const [active, setActive] = useState(service.active);
  const [specialtyId, setSpecialtyId] = useState(service.specialties ? "" : "");
  const [doctorIds, setDoctorIds] = useState<string[]>(service.doctor_services?.map((ds) => ds.doctors.id) ?? []);
  const [saving, setSaving] = useState(false);
  const isEdit = Boolean(service.id);

  const toggleDoctor = (id: string) =>
    setDoctorIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  const save = async () => {
    if (!name.trim()) {
      onError("Nomi kiritilishi shart");
      return;
    }
    const dur = Number(duration);
    const pr = Number(price);
    if (!Number.isFinite(dur) || dur < 5) {
      onError("Davomiylik kamida 5 daqiqa");
      return;
    }
    if (!Number.isFinite(pr) || pr < 0) {
      onError("Narx noto‘g‘ri");
      return;
    }
    setSaving(true);
    const payload = {
      name: name.trim(),
      description: description || undefined,
      durationMinutes: dur,
      price: pr,
      preparationText: preparation || undefined,
      active,
      doctorIds: doctorIds.length ? doctorIds : undefined,
    };
    try {
      if (isEdit) {
        await adminApi.patch(`/api/admin/services?id=${service.id}`, payload);
      } else {
        await adminApi.post("/api/admin/services", { ...payload, specialtyId: specialtyId || undefined });
      }
      onSaved();
    } catch (e) {
      onError(e instanceof AdminApiError ? e.message : "Saqlab bo‘lmadi");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-900/50 p-4" onClick={onClose}>
      <Card className="pointer-events-auto mt-10 w-full max-w-lg">
        <p className="mb-4 text-lg font-bold text-slate-900">{isEdit ? "Xizmatni boshqarish" : "Yangi xizmat"}</p>
        <div className="flex flex-col gap-3">
          <AInput value={name} onChange={setName} placeholder="Xizmat nomi" aria-label="Nomi" />
          {!isEdit && (
            <ASelect
              value={specialtyId}
              onChange={setSpecialtyId}
              options={[{ value: "", label: "Yo‘nalish tanlash…" }, ...specialties.map((s) => ({ value: s.id, label: s.name }))]}
              aria-label="Yo‘nalish"
            />
          )}
          <ATextArea value={description} onChange={setDescription} placeholder="Tavsif" />
          <div className="grid grid-cols-2 gap-3">
            <div>
              <p className="mb-1 text-xs text-slate-500">Davomiylik (daq.)</p>
              <AInput value={duration} onChange={setDuration} type="number" aria-label="Davomiylik" />
            </div>
            <div>
              <p className="mb-1 text-xs text-slate-500">Narx (so‘m)</p>
              <AInput value={price} onChange={setPrice} type="number" aria-label="Narx" />
            </div>
          </div>
          <ATextArea value={preparation} onChange={setPreparation} placeholder="Tayyorgarlik (bemorga ko‘rsatiladi)" rows={2} />
          <label className="flex items-center gap-2 text-sm text-slate-700">
            <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} className="h-4 w-4 accent-emerald-600" />
            Faol
          </label>
          <div className="rounded-lg border border-slate-200 p-3">
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Qaysi shifokorlar bajaradi</p>
            <div className="flex flex-wrap gap-2">
              {doctors.map((d) => (
                <button
                  key={d.id}
                  type="button"
                  onClick={() => toggleDoctor(d.id)}
                  className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                    doctorIds.includes(d.id) ? "bg-emerald-600 text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200"
                  }`}
                >
                  {d.name}
                </button>
              ))}
              {doctors.length === 0 && <p className="text-xs text-slate-400">Avval shifokor qo‘shing</p>}
            </div>
          </div>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <AButton variant="outline" onClick={onClose}>Bekor</AButton>
          <AButton loading={saving} onClick={() => void save()}>Saqlash</AButton>
        </div>
      </Card>
    </div>
  );
}
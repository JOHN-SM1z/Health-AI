"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/browser";
import { PageHeader, Card, ABadge, ATable, AEmpty, AError, AButton, AInput, ASelect, AModal } from "@/components/admin/ui";
import { adminApi, AdminApiError } from "@/lib/admin/client";

type Doctor = {
  id: string;
  name: string;
  title: string | null;
  active: boolean;
  specialties: { name: string } | null;
};

type WorkingHours = { weekday: number; start_time: string; end_time: string }[];

const WEEKDAYS = ["Dushanba", "Seshanba", "Chorshanba", "Payshanba", "Juma", "Shanba", "Yakshanba"];

export default function DoctorsPage() {
  const [rows, setRows] = useState<Doctor[] | null>(null);
  const [specialties, setSpecialties] = useState<{ id: string; name: string }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Doctor | null>(null);

  const load = async () => {
    const supabase = createClient();
    const [{ data: docs, error }, { data: specs }] = await Promise.all([
      supabase.from("doctors").select("id, name, title, active, specialties(name)").order("name"),
      supabase.from("specialties").select("id, name").eq("active", true).order("name"),
    ]);
    if (error) {
      setError("Shifokorlarni yuklab bo‘lmadi");
      return;
    }
    setRows(docs ?? []);
    setSpecialties(specs ?? []);
  };

  useEffect(() => {
    void load();
  }, []);

  return (
    <div>
      <PageHeader
        title="Shifokorlar"
        subtitle="Ro‘yxat va ish jadvallari"
        action={<AButton onClick={() => setEditing({ id: "", name: "", title: "", active: true, specialties: null })}>+ Shifokor qo‘shish</AButton>}
      />
      {error && <AError message={error} />}

      {rows === null ? (
        <Card><div className="h-2 w-full animate-pulse rounded bg-hairline" /></Card>
      ) : rows.length === 0 ? (
        <Card><AEmpty title="Shifokorlar yo‘q" subtitle="Birinchi shifokorni qo‘shing" /></Card>
      ) : (
        <ATable headers={["Ism", "Yo‘nalish", "Holat", "Amallar"]}>
          {rows.map((d) => (
            <tr key={d.id} className="hover:bg-sand">
              <td className="px-4 py-3">
                <p className="font-medium text-foreground">{d.name}</p>
                {d.title && <p className="text-xs text-ink-muted">{d.title}</p>}
              </td>
              <td className="px-4 py-3 text-foreground">{d.specialties?.name ?? "—"}</td>
              <td className="px-4 py-3"><ABadge tone={d.active ? "green" : "gray"}>{d.active ? "Faol" : "Nofaol"}</ABadge></td>
              <td className="px-4 py-3"><AButton size="sm" variant="outline" onClick={() => setEditing(d)}>Boshqarish</AButton></td>
            </tr>
          ))}
        </ATable>
      )}

      {editing && (
        <DoctorModal
          doctor={editing}
          specialties={specialties}
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

function DoctorModal({
  doctor,
  specialties,
  onClose,
  onSaved,
  onError,
}: {
  doctor: Doctor;
  specialties: { id: string; name: string }[];
  onClose: () => void;
  onSaved: () => void;
  onError: (m: string) => void;
}) {
  const [name, setName] = useState(doctor.name);
  const [title, setTitle] = useState(doctor.title ?? "");
  const [active, setActive] = useState(doctor.active);
  const [specialtyId, setSpecialtyId] = useState(doctor.specialties ? "" : "");
  const [hours, setHours] = useState<WorkingHours>([]);
  const [saving, setSaving] = useState(false);
  const isEdit = Boolean(doctor.id);

  useEffect(() => {
    if (!doctor.id) return;
    const supabase = createClient();
    void supabase
      .from("doctor_working_hours")
      .select("weekday, start_time, end_time")
      .eq("doctor_id", doctor.id)
      .then(({ data }) => setHours(data ?? []));
  }, [doctor.id]);

  const updateSlot = (weekday: number, patch: { start_time: string; end_time: string }): WorkingHours => {
    const exists = hours.some((h) => h.weekday === weekday);
    if (!exists) return [...hours, { weekday, ...patch }];
    return hours.map((h) => (h.weekday === weekday ? { ...h, ...patch } : h));
  };

  const save = async () => {
    if (!name.trim()) {
      onError("Ism kiritilishi shart");
      return;
    }
    setSaving(true);
    try {
      if (isEdit) {
        await adminApi.patch(`/api/admin/doctors?id=${doctor.id}`, { name, title: title || undefined, active });
        const schedule = hours
          .filter((h) => h.start_time && h.end_time)
          .map((h) => ({ weekday: h.weekday, start: h.start_time, end: h.end_time }));
        await adminApi.post(`/api/admin/doctors/${doctor.id}`, { schedule });
      } else {
        await adminApi.post("/api/admin/doctors", {
          name,
          title: title || undefined,
          active,
          specialtyId: specialtyId || undefined,
        });
      }
      onSaved();
    } catch (e) {
      onError(e instanceof AdminApiError ? e.message : "Saqlab bo‘lmadi");
    } finally {
      setSaving(false);
    }
  };

  return (
    <AModal
      title={isEdit ? "Shifokorni boshqarish" : "Yangi shifokor"}
      onClose={onClose}
      footer={
        <>
          <AButton variant="outline" onClick={onClose}>Bekor</AButton>
          <AButton loading={saving} onClick={() => void save()}>Saqlash</AButton>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <AInput value={name} onChange={setName} placeholder="F.I.Sh." aria-label="Ism" />
        <AInput value={title} onChange={setTitle} placeholder="Lavozim (masalan: Terapevt)" aria-label="Lavozim" />
        {!isEdit && (
          <ASelect
            value={specialtyId}
            onChange={setSpecialtyId}
            options={[{ value: "", label: "Yo‘nalish tanlash…" }, ...specialties.map((s) => ({ value: s.id, label: s.name }))]}
            aria-label="Yo‘nalish"
          />
        )}
        <label className="flex items-center gap-2 text-sm text-ink-muted">
          <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} className="h-4 w-4 accent-pine" />
          Faol
        </label>
        {isEdit && (
          <div className="rounded-lg border border-hairline bg-surface-2 p-3">
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-muted">Haftalik ish jadvali</p>
            <div className="space-y-1.5">
              {WEEKDAYS.map((dayName, idx) => {
                const wd = idx + 1;
                const slot = hours.find((h) => h.weekday === wd);
                return (
                  <div key={wd} className="flex items-center gap-2 text-sm">
                    <span className="w-28 shrink-0 text-ink-muted">{dayName}</span>
                    <AInput
                      value={slot?.start_time ?? ""}
                      type="time"
                      className="w-28"
                      onChange={(v) => setHours(updateSlot(wd, { start_time: v, end_time: slot?.end_time ?? "" }))}
                      aria-label={`${dayName} boshlanish`}
                    />
                    <span className="text-ink-muted">—</span>
                    <AInput
                      value={slot?.end_time ?? ""}
                      type="time"
                      className="w-28"
                      onChange={(v) => setHours(updateSlot(wd, { start_time: slot?.start_time ?? "", end_time: v }))}
                      aria-label={`${dayName} tugash`}
                    />
                    <AButton size="sm" variant="ghost" onClick={() => setHours((prev) => prev.filter((h) => h.weekday !== wd))}>
                      ×
                    </AButton>
                  </div>
                );
              })}
            </div>
            <AButton
              size="sm"
              variant="outline"
              className="mt-2"
              onClick={() => setHours((prev) => [...prev, { weekday: (prev.length % 7) + 1, start_time: "09:00", end_time: "18:00" }])}
            >
              + Kun qo‘shish
            </AButton>
          </div>
        )}
      </div>
    </AModal>
  );
}
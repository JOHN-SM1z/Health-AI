"use client";

import { useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/browser";
import type { Database } from "@/lib/supabase/database.types";
import { PageHeader, Card, ABadge, ATable, AEmpty, AError, AButton } from "@/components/admin/ui";
import { STATUS_LABELS, STATUS_TONES, formatTime, formatPrice, adminApi, AdminApiError } from "@/lib/admin/client";

type Row = {
  id: string;
  start_at: string;
  status: Database["public"]["Enums"]["appointment_status"];
  patients: { full_name: string | null; phone: string | null } | null;
  services: { name: string; price: number } | null;
};

export default function DoctorQueuePage() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [doctorName, setDoctorName] = useState<string | null>(null);

  const load = async () => {
    const supabase = createClient();
    const authData = await supabase.auth.getUser();
    const uid = authData.data.user?.id;

    const { data: doctor } = await supabase
      .from("doctors")
      .select("name")
      .eq("profile_id", uid ?? "")
      .maybeSingle();

    if (!doctor) {
      setRows([]);
      setDoctorName(null);
      return;
    }
    setDoctorName(doctor.name);

    const { data, error: err } = await supabase
      .from("appointments")
      .select("id, start_at, status, doctors!inner(profile_id), patients(full_name, phone), services(name, price)")
      .eq("doctors.profile_id", uid ?? "")
      .gte("start_at", new Date(new Date().setHours(0, 0, 0, 0)).toISOString())
      .lt("start_at", new Date(new Date().setHours(24, 0, 0, 0)).toISOString())
      .not("status", "in", '("cancelled","no_show")')
      .order("start_at", { ascending: true });
    if (err) {
      setError("Navbatni yuklab bo‘lmadi");
      return;
    }
    setRows(data ?? []);
  };

  useEffect(() => {
    void load();
  }, []);

  const nextPatient = useMemo(() => {
    if (!rows) return null;
    return (
      rows.find((r) => r.status === "checked_in") ??
      rows.find((r) => r.status === "confirmed") ??
      rows.find((r) => r.status === "pending") ??
      null
    );
  }, [rows]);

  const advance = async (r: Row) => {
    const next =
      r.status === "pending" || r.status === "confirmed"
        ? "in_progress"
        : r.status === "in_progress"
          ? "completed"
          : r.status === "checked_in"
            ? "in_progress"
            : null;
    if (!next) return;
    setBusyId(r.id);
    try {
      await adminApi.patch(`/api/doctor/appointments/${r.id}`, { status: next });
      await load();
    } catch (e) {
      setError(e instanceof AdminApiError ? e.message : "Xatolik yuz berdi");
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div>
      <PageHeader
        title="Bugungi navbat"
        subtitle={doctorName ? `Shifokor: ${doctorName}` : new Date().toLocaleDateString("uz-UZ", { weekday: "long", day: "numeric", month: "long" })}
      />

      {error && <AError message={error} />}

      {nextPatient && (
        <Card className="mb-6 border-pine/30 bg-pine-tint/60">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-pine-deep">
                <span className="pulse-dot" />
                Navbatdagi bemor
              </p>
              <p className="font-display mt-1 text-lg font-bold text-foreground">{nextPatient.patients?.full_name ?? "—"}</p>
              <p className="font-numeric text-sm text-ink-muted">
                {formatTime(nextPatient.start_at)} · {nextPatient.services?.name ?? "—"} · {formatPrice(nextPatient.services?.price)}
              </p>
            </div>
            <AButton loading={busyId === nextPatient.id} onClick={() => void advance(nextPatient)}>
              {nextPatient.status === "in_progress" ? "Yakunlash" : "Qabulni boshlash"}
            </AButton>
          </div>
        </Card>
      )}

      {rows === null ? (
        <Card><div className="h-2 w-full animate-pulse rounded bg-hairline" /></Card>
      ) : doctorName === null ? (
        <Card>
          <AEmpty
            title="Shifokor hisobi ulanmagan"
            subtitle="Admin panelda shifokor kartasiga profilingizni bog‘lang (Shifokorlar → Boshqarish)."
          />
        </Card>
      ) : rows.length === 0 ? (
        <Card><AEmpty title="Bugun navbat yo‘q" subtitle="Barcha qabullar yakunlangan yoki rejalashtirilmagan" /></Card>
      ) : (
        <ATable headers={["Vaqt", "Bemor", "Xizmat", "Narx", "Holat", "Amallar"]}>
          {rows.map((r) => (
            <tr key={r.id} className={r.id === nextPatient?.id ? "bg-pine-tint/50" : "hover:bg-sand"}>
              <td className="px-4 py-3 font-semibold text-foreground">{formatTime(r.start_at)}</td>
              <td className="px-4 py-3">
                <p className="font-medium text-foreground">{r.patients?.full_name ?? "—"}</p>
                {r.patients?.phone && <p className="text-xs text-ink-muted">{r.patients.phone}</p>}
              </td>
              <td className="px-4 py-3 text-foreground">{r.services?.name ?? "—"}</td>
              <td className="px-4 py-3 text-foreground">{formatPrice(r.services?.price)}</td>
              <td className="px-4 py-3"><ABadge tone={STATUS_TONES[r.status]}>{STATUS_LABELS[r.status]}</ABadge></td>
              <td className="px-4 py-3">
                {r.status !== "completed" && (
                  <AButton size="sm" variant={r.status === "in_progress" ? "primary" : "outline"} loading={busyId === r.id} onClick={() => void advance(r)}>
                    {r.status === "in_progress" ? "Yakunlash" : r.status === "checked_in" ? "Boshlash" : "Jarayonga olish"}
                  </AButton>
                )}
              </td>
            </tr>
          ))}
        </ATable>
      )}
    </div>
  );
}
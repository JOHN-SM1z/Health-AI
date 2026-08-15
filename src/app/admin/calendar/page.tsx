"use client";

import { useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/browser";
import type { Database } from "@/lib/supabase/database.types";
import { PageHeader, Card, ABadge, AError, AButton, ASelect } from "@/components/admin/ui";
import { STATUS_LABELS, STATUS_TONES, formatTime } from "@/lib/admin/client";
import { addDays, startOfWeek, addWeeks, subWeeks, isSameDay } from "date-fns";

type Appointment = {
  id: string;
  start_at: string;
  status: Database["public"]["Enums"]["appointment_status"];
  doctor_id: string | null;
  patients: { full_name: string | null } | null;
  services: { name: string } | null;
};

export default function CalendarPage() {
  const [weekStart, setWeekStart] = useState(() => startOfWeek(new Date(), { weekStartsOn: 1 }));
  const [doctorFilter, setDoctorFilter] = useState("all");
  const [doctors, setDoctors] = useState<{ id: string; name: string }[]>([]);
  const [rows, setRows] = useState<Appointment[] | null>(null);
  const [error] = useState<string | null>(null);

  const load = async () => {
    const supabase = createClient();
    const { data: d } = await supabase.from("doctors").select("id, name").eq("active", true).order("name");
    setDoctors(d ?? []);
    const { data } = await supabase
      .from("appointments")
      .select("id, start_at, status, doctor_id, patients(full_name), services(name)")
      .gte("start_at", weekStart.toISOString())
      .lt("start_at", addDays(weekStart, 7).toISOString())
      .not("status", "in", '("cancelled","no_show")')
      .order("start_at");
    setRows((data ?? []) as Appointment[]);
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [weekStart, doctorFilter]);

  const days = useMemo(() => Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)), [weekStart]);

  const dayAppointments = (day: Date, doctorId: string) =>
    (rows ?? []).filter(
      (r) => isSameDay(new Date(r.start_at), day) && (doctorId === "all" || r.doctor_id === doctorId),
    );

  return (
    <div>
      <PageHeader
        title="Kalendar"
        subtitle="Hafta bo‘yicha barcha qabullar"
        action={
          <div className="flex gap-2">
            <AButton variant="outline" onClick={() => setWeekStart((w) => subWeeks(w, 1))}>← Oldingi</AButton>
            <AButton variant="outline" onClick={() => setWeekStart((w) => addWeeks(w, 1))}>Keyingi →</AButton>
          </div>
        }
      />

      {error && <AError message={error} />}

      <div className="mb-4 w-64">
        <ASelect
          value={doctorFilter}
          onChange={setDoctorFilter}
          options={[{ value: "all", label: "Barcha shifokorlar" }, ...doctors.map((d) => ({ value: d.id, label: d.name }))]}
        />
      </div>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-4 xl:grid-cols-7">
        {days.map((day) => {
          const isToday = isSameDay(day, new Date());
          const appts = dayAppointments(day, doctorFilter);
          return (
            <Card key={day.toISOString()} className={`min-h-40 p-3 ${isToday ? "border-pine/30 bg-pine-tint/50" : ""}`}>
              <p className={`mb-2 text-sm font-bold ${isToday ? "text-pine-deep" : "text-ink-muted"}`}>
                {day.toLocaleDateString("uz-UZ", { weekday: "short", day: "numeric", month: "short" })}
              </p>
              <div className="space-y-1.5">
                {appts.map((a) => (
                  <div key={a.id} className="rounded-lg bg-surface p-2 shadow-sm ring-1 ring-hairline">
                    <p className="text-xs font-semibold text-foreground">{formatTime(a.start_at)}</p>
                    <p className="truncate text-xs text-ink-muted">{a.patients?.full_name ?? "—"}</p>
                    <p className="truncate text-[11px] text-ink-muted">{a.services?.name}</p>
                    <div className="mt-1"><ABadge tone={STATUS_TONES[a.status]}>{STATUS_LABELS[a.status]}</ABadge></div>
                  </div>
                ))}
                {appts.length === 0 && <p className="text-xs text-ink-muted/70">Bo‘sh</p>}
              </div>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
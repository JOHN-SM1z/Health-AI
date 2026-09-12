"use client";

import { useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/browser";
import type { Database } from "@/lib/supabase/database.types";
import { PageHeader, Card, ABadge, AEmpty, AError, AButton, ASelect, LoadingRow } from "@/components/admin/ui";
import { CalendarDays } from "lucide-react";
import { STATUS_LABELS, STATUS_TONES, formatTime, formatDateTime } from "@/lib/admin/client";
import {
  addDays,
  addMonths,
  subMonths,
  startOfWeek,
  endOfMonth,
  startOfMonth,
  addWeeks,
  subWeeks,
  isSameDay,
  isSameMonth,
  startOfDay,
} from "date-fns";

type Appointment = {
  id: string;
  start_at: string;
  status: Database["public"]["Enums"]["appointment_status"];
  doctor_id: string | null;
  patients: { full_name: string | null } | null;
  services: { name: string } | null;
};

type Block = {
  id: string;
  starts_at: string;
  ends_at: string;
  doctor_id: string;
  reason: string;
};

const WEEKDAY_LABELS = ["Dus", "Ses", "Chor", "Pay", "Jum", "Shan", "Yak"];
const BLOCK_REASON_LABELS: Record<string, string> = {
  break: "Tanaffus",
  absence: "Ishda yo‘q",
  reservation: "Band",
  admin_hold: "Yopilgan",
};
const VIEWS = [
  { value: "day", label: "Kun" },
  { value: "week", label: "Hafta" },
  { value: "month", label: "Oy" },
] as const;
type View = (typeof VIEWS)[number]["value"];

export default function CalendarPage() {
  const [view, setView] = useState<View>("week");
  const [anchor, setAnchor] = useState(() => new Date(0));
  const [doctorFilter, setDoctorFilter] = useState("all");
  const [doctors, setDoctors] = useState<{ id: string; name: string }[]>([]);
  const [rows, setRows] = useState<Appointment[] | null>(null);
  const [blocks, setBlocks] = useState<Block[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setAnchor(new Date());
  }, []);

  const range = useMemo(() => {
    if (view === "day") {
      const start = startOfDay(anchor);
      return { start, end: addDays(start, 1) };
    }
    if (view === "month") {
      const gridStart = startOfWeek(startOfMonth(anchor), { weekStartsOn: 1 });
      const gridEnd = addDays(startOfWeek(endOfMonth(anchor), { weekStartsOn: 1 }), 7);
      return { start: gridStart, end: gridEnd };
    }
    const weekStart = startOfWeek(anchor, { weekStartsOn: 1 });
    return { start: weekStart, end: addDays(weekStart, 7) };
  }, [view, anchor]);

  const load = async () => {
    const supabase = createClient();
    const { data: d, error: doctorsError } = await supabase
      .from("doctors")
      .select("id, name")
      .eq("active", true)
      .order("name");
    if (doctorsError) {
      setError("Shifokorlarni yuklab bo‘lmadi");
      return;
    }
    setDoctors(d ?? []);

    const [{ data: appts, error: appointmentsError }, { data: blockRows }] = await Promise.all([
      supabase
        .from("appointments")
        .select("id, start_at, status, doctor_id, patients(full_name), services(name)")
        .gte("start_at", range.start.toISOString())
        .lt("start_at", range.end.toISOString())
        .not("status", "in", '("cancelled","no_show")')
        .order("start_at"),
      // Only management roles can read doctor_time_blocks (RLS) — for
      // receptionist this comes back as an empty, error-free result set, so
      // the overlay simply does not show rather than erroring the page.
      supabase
        .from("doctor_time_blocks")
        .select("id, starts_at, ends_at, doctor_id, reason")
        .gte("ends_at", range.start.toISOString())
        .lt("starts_at", range.end.toISOString()),
    ]);
    if (appointmentsError) {
      setError("Qabullarni yuklab bo‘lmadi");
      return;
    }
    setRows((appts ?? []) as Appointment[]);
    setBlocks((blockRows ?? []) as Block[]);
    setError(null);
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range, doctorFilter]);

  const days = useMemo(() => {
    const out: Date[] = [];
    for (let d = range.start; d < range.end; d = addDays(d, 1)) out.push(d);
    return out;
  }, [range]);

  const dayAppointments = (day: Date, doctorId: string) =>
    (rows ?? []).filter(
      (r) => isSameDay(new Date(r.start_at), day) && (doctorId === "all" || r.doctor_id === doctorId),
    );

  const dayBlocks = (day: Date, doctorId: string) =>
    blocks.filter(
      (b) =>
        (doctorId === "all" || b.doctor_id === doctorId) &&
        new Date(b.starts_at) < addDays(day, 1) &&
        new Date(b.ends_at) > day,
    );

  const goPrev = () => setAnchor((a) => (view === "day" ? addDays(a, -1) : view === "month" ? subMonths(a, 1) : subWeeks(a, 1)));
  const goNext = () => setAnchor((a) => (view === "day" ? addDays(a, 1) : view === "month" ? addMonths(a, 1) : addWeeks(a, 1)));
  const goToday = () => setAnchor(new Date());

  const subtitle =
    view === "day"
      ? formatDateTime(anchor.toISOString()).split(" ")[0]
      : view === "month"
        ? anchor.toLocaleDateString("uz-UZ", { month: "long", year: "numeric" })
        : "Hafta bo‘yicha barcha qabullar";

  return (
    <div>
      <PageHeader
        title="Kalendar"
        subtitle={subtitle}
        action={
          <div className="flex flex-wrap items-center gap-2">
            <div className="w-32">
              <ASelect value={view} onChange={(v) => setView(v as View)} options={[...VIEWS]} aria-label="Ko‘rinish" />
            </div>
            <AButton variant="outline" onClick={goPrev}>← Oldingi</AButton>
            <AButton variant="outline" onClick={goToday}>Bugun</AButton>
            <AButton variant="outline" onClick={goNext}>Keyingi →</AButton>
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

      {rows === null ? (
        <Card><LoadingRow /></Card>
      ) : view === "month" ? (
        <MonthGrid
          days={days}
          anchor={anchor}
          dayAppointments={(d) => dayAppointments(d, doctorFilter)}
          dayBlocks={(d) => dayBlocks(d, doctorFilter)}
          onSelectDay={(d) => {
            setAnchor(d);
            setView("day");
          }}
        />
      ) : view === "day" ? (
        <DayAgenda appointments={dayAppointments(days[0], doctorFilter)} blocks={dayBlocks(days[0], doctorFilter)} />
      ) : (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-4 xl:grid-cols-7">
          {days.map((day) => {
            const isToday = isSameDay(day, new Date());
            const appts = dayAppointments(day, doctorFilter);
            const dayBlks = dayBlocks(day, doctorFilter);
            return (
              <Card key={day.toISOString()} className={`min-h-40 p-3 ${isToday ? "border-pine/40 bg-pine-tint/40" : ""}`}>
                <button
                  type="button"
                  className="mb-2 flex w-full items-center justify-between text-left"
                  onClick={() => {
                    setAnchor(day);
                    setView("day");
                  }}
                >
                  <p className={`text-xs font-bold uppercase tracking-wide ${isToday ? "text-pine-deep" : "text-ink-muted"}`}>
                    {WEEKDAY_LABELS[(day.getDay() + 6) % 7]}
                  </p>
                  <p className={`font-numeric text-xs ${isToday ? "text-pine-deep" : "text-ink-muted/80"}`}>
                    {day.getDate()}
                  </p>
                </button>
                <div className="space-y-1.5">
                  {dayBlks.map((b) => (
                    <div key={b.id} className="rounded-lg border border-dashed border-hairline bg-sand/60 p-2">
                      <p className="text-[11px] font-medium text-ink-muted">
                        {formatTime(b.starts_at)}–{formatTime(b.ends_at)} · {BLOCK_REASON_LABELS[b.reason] ?? b.reason}
                      </p>
                    </div>
                  ))}
                  {appts.map((a) => (
                    <div key={a.id} className="rounded-lg border border-hairline bg-surface p-2">
                      <p className="font-numeric text-xs font-semibold text-foreground">{formatTime(a.start_at)}</p>
                      <p className="mt-0.5 truncate text-xs text-ink-muted">{a.patients?.full_name ?? "—"}</p>
                      <p className="truncate text-[11px] text-ink-muted/80">{a.services?.name}</p>
                      <div className="mt-1.5"><ABadge tone={STATUS_TONES[a.status]}>{STATUS_LABELS[a.status]}</ABadge></div>
                    </div>
                  ))}
                  {appts.length === 0 && dayBlks.length === 0 && <p className="text-xs text-ink-muted/70">Bo‘sh</p>}
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}

function MonthGrid({
  days,
  anchor,
  dayAppointments,
  dayBlocks,
  onSelectDay,
}: {
  days: Date[];
  anchor: Date;
  dayAppointments: (d: Date) => Appointment[];
  dayBlocks: (d: Date) => Block[];
  onSelectDay: (d: Date) => void;
}) {
  return (
    <Card className="p-0">
      <div className="grid grid-cols-7 border-b border-hairline text-center text-[11px] font-bold uppercase tracking-wide text-ink-muted">
        {WEEKDAY_LABELS.map((w) => (
          <div key={w} className="p-2">{w}</div>
        ))}
      </div>
      <div className="grid grid-cols-7">
        {days.map((day) => {
          const inMonth = isSameMonth(day, anchor);
          const isToday = isSameDay(day, new Date());
          const count = dayAppointments(day).length;
          const blocked = dayBlocks(day).length > 0;
          return (
            <button
              key={day.toISOString()}
              type="button"
              onClick={() => onSelectDay(day)}
              className={`flex min-h-20 flex-col items-start gap-1 border-b border-r border-hairline p-2 text-left last:border-r-0 hover:bg-sand ${
                inMonth ? "" : "opacity-40"
              } ${isToday ? "bg-pine-tint/40" : ""}`}
            >
              <span className={`font-numeric text-xs ${isToday ? "font-bold text-pine-deep" : "text-ink-muted"}`}>
                {day.getDate()}
              </span>
              {count > 0 && <ABadge tone="blue">{count} qabul</ABadge>}
              {blocked && <span className="text-[10px] text-ink-muted">Band vaqt bor</span>}
            </button>
          );
        })}
      </div>
    </Card>
  );
}

function DayAgenda({ appointments, blocks }: { appointments: Appointment[]; blocks: Block[] }) {
  const sorted = [...appointments].sort((a, b) => a.start_at.localeCompare(b.start_at));
  return (
    <div className="space-y-3">
      {blocks.length > 0 && (
        <Card>
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-muted">Band vaqtlar</p>
          <div className="space-y-1.5">
            {blocks.map((b) => (
              <p key={b.id} className="text-sm text-ink-muted">
                {formatTime(b.starts_at)}–{formatTime(b.ends_at)} · {BLOCK_REASON_LABELS[b.reason] ?? b.reason}
              </p>
            ))}
          </div>
        </Card>
      )}
      {sorted.length === 0 ? (
        <Card>
          <AEmpty title="Bu kunda qabullar yo‘q" icon={<CalendarDays className="h-6 w-6" />} />
        </Card>
      ) : (
        <Card className="p-0">
          {sorted.map((a, i) => (
            <div
              key={a.id}
              className={`flex items-center justify-between gap-3 px-4 py-3 ${i > 0 ? "border-t border-hairline" : ""}`}
            >
              <div className="flex items-center gap-3">
                <p className="font-numeric w-14 shrink-0 text-sm font-semibold text-foreground">{formatTime(a.start_at)}</p>
                <div>
                  <p className="text-sm font-medium text-foreground">{a.patients?.full_name ?? "—"}</p>
                  <p className="text-xs text-ink-muted">{a.services?.name ?? "—"}</p>
                </div>
              </div>
              <ABadge tone={STATUS_TONES[a.status]}>{STATUS_LABELS[a.status]}</ABadge>
            </div>
          ))}
        </Card>
      )}
    </div>
  );
}

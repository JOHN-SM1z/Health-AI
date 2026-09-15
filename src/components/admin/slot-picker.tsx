"use client";

import { useEffect, useMemo, useState } from "react";
import { ABadge, LoadingRow } from "@/components/admin/ui";
import { adminApi } from "@/lib/admin/client";

export type Slot = { start: string; startLocal: string; dayLocal: string; doctorId: string };

/**
 * Real available slots for one service+doctor, from /api/admin/availability
 * (the same server-computed schedule /api/availability gives the
 * patient-facing Mini App, scoped to the staff session's own clinic). Used
 * by both the new-booking and reschedule flows so neither ever offers a
 * time the transactional booking engine would reject.
 */
export function SlotPicker({ serviceId, doctorId, selectedSlot, onSelect }: { serviceId: string; doctorId: string; selectedSlot: Slot | null; onSelect: (slot: Slot) => void }) {
  const [slots, setSlots] = useState<Slot[] | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setSlots(null);
    setLoading(true);
    adminApi
      .get<{ slots: Slot[] }>(`/api/admin/availability?serviceId=${serviceId}&doctorId=${doctorId}&days=14`)
      .then((r) => setSlots(r.slots))
      .catch(() => setSlots([]))
      .finally(() => setLoading(false));
  }, [serviceId, doctorId]);

  const slotsByDay = useMemo(() => {
    const groups = new Map<string, Slot[]>();
    for (const s of slots ?? []) {
      const list = groups.get(s.dayLocal) ?? [];
      list.push(s);
      groups.set(s.dayLocal, list);
    }
    return [...groups.entries()];
  }, [slots]);

  if (loading) return <LoadingRow />;
  if (!slots || slots.length === 0) {
    return <p className="rounded-lg border border-hairline bg-sand px-3 py-2 text-sm text-ink-muted">Bu shifokor/xizmat uchun yaqin kunlarda bo‘sh vaqt yo‘q</p>;
  }

  return (
    <div>
      <div className="max-h-52 space-y-3 overflow-y-auto rounded-lg border border-hairline p-2.5">
        {slotsByDay.map(([day, daySlots]) => (
          <div key={day}>
            <p className="mb-1.5 text-xs font-semibold text-ink-muted">
              {new Date(`${day}T00:00:00`).toLocaleDateString("uz-UZ", { weekday: "short", day: "numeric", month: "long" })}
            </p>
            <div className="flex flex-wrap gap-1.5">
              {daySlots.map((s) => (
                <button
                  key={s.start}
                  type="button"
                  onClick={() => onSelect(s)}
                  className={`font-numeric rounded-lg border px-2.5 py-1.5 text-xs font-medium transition-colors ${
                    selectedSlot?.start === s.start ? "border-pine bg-pine text-white" : "border-hairline bg-surface text-foreground hover:bg-sand"
                  }`}
                >
                  {s.startLocal}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
      {selectedSlot && (
        <div className="mt-2">
          <ABadge tone="pine">
            Tanlandi: {new Date(`${selectedSlot.dayLocal}T00:00:00`).toLocaleDateString("uz-UZ", { day: "numeric", month: "long" })}, {selectedSlot.startLocal}
          </ABadge>
        </div>
      )}
    </div>
  );
}

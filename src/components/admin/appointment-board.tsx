"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { ABadge, ATable, ASelect, AEmpty, AButton, Card, LoadingRow } from "@/components/admin/ui";
import { STATUS_LABELS, STATUS_TONES, formatTime, formatPrice } from "@/lib/admin/client";
import type { TodayAppointmentRow } from "@/lib/admin/dashboard-types";
import { CalendarDays } from "lucide-react";

type Row = TodayAppointmentRow;

const STATUS_FILTER_OPTIONS = [
  { value: "all", label: "Barcha holatlar" },
  ...(["pending", "confirmed", "checked_in", "in_progress", "completed", "cancelled", "no_show"] as const).map((s) => ({
    value: s,
    label: STATUS_LABELS[s],
  })),
];

/**
 * Shared "today's appointments" board — dominant content on both the
 * Manager and Receptionist dashboards, same 7 columns and same contextual
 * per-status actions (one or two relevant buttons, not every action on
 * every row) so the two never drift apart. The top KPI counts on either
 * dashboard are computed by the caller from the *unfiltered* rows; this
 * component only filters its own table view.
 */
export function AppointmentBoard({
  title = "Bugungi qabullar",
  rows,
  busyId,
  onSetStatus,
  onCancel,
  emptyTitle,
  emptySubtitle,
}: {
  title?: string;
  rows: Row[] | null;
  busyId: string | null;
  onSetStatus: (id: string, status: string) => void;
  onCancel: (row: Row) => void;
  emptyTitle: string;
  emptySubtitle: string;
}) {
  const [statusFilter, setStatusFilter] = useState("all");

  const filteredRows = useMemo(() => {
    if (!rows) return null;
    return statusFilter === "all" ? rows : rows.filter((r) => r.status === statusFilter);
  }, [rows, statusFilter]);

  return (
    <Card>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-bold text-foreground">{title}</p>
        <div className="w-48">
          <ASelect value={statusFilter} onChange={setStatusFilter} options={STATUS_FILTER_OPTIONS} aria-label="Holat bo‘yicha filtr" />
        </div>
      </div>

      {rows === null ? (
        <LoadingRow />
      ) : rows.length === 0 ? (
        <AEmpty title={emptyTitle} subtitle={emptySubtitle} icon={<CalendarDays className="h-6 w-6" />} />
      ) : filteredRows && filteredRows.length === 0 ? (
        <AEmpty title="Bu holatda qabullar topilmadi" subtitle="Filtrni tozalab, boshqa holatni tanlang." icon={<CalendarDays className="h-6 w-6" />} />
      ) : (
        <ATable headers={["Vaqt", "Bemor", "Xizmat", "Shifokor", "Holat", "To‘lov", "Amal"]}>
          {(filteredRows ?? []).map((r) => (
            <tr key={r.id} className="hover:bg-sand">
              <td className="px-4 py-3 font-semibold text-foreground">{formatTime(r.start_at)}</td>
              <td className="px-4 py-3">
                <p className="font-medium text-foreground">{r.patients?.full_name ?? "—"}</p>
                {r.patients?.phone && <p className="text-xs text-ink-muted">{r.patients.phone}</p>}
              </td>
              <td className="px-4 py-3">
                <p className="text-foreground">{r.services?.name ?? "—"}</p>
                <p className="text-xs text-ink-muted">{formatPrice(r.services?.price)}</p>
              </td>
              <td className="px-4 py-3 text-foreground">{r.doctors?.name ?? "—"}</td>
              <td className="px-4 py-3">
                <ABadge tone={STATUS_TONES[r.status]}>{STATUS_LABELS[r.status]}</ABadge>
              </td>
              <td className="px-4 py-3">
                <ABadge tone={r.payments?.status === "paid" ? "green" : r.payments?.status === "refunded" ? "gray" : "amber"}>
                  {r.payments?.status === "paid" ? "To‘langan" : r.payments?.status === "refunded" ? "Qaytarilgan" : "To‘lanmagan"}
                </ABadge>
              </td>
              <td className="px-4 py-3">
                <div className="flex flex-wrap gap-1.5">
                  {r.status === "pending" && (
                    <AButton size="sm" variant="outline" loading={busyId === r.id} onClick={() => onSetStatus(r.id, "confirmed")}>
                      Tasdiqlash
                    </AButton>
                  )}
                  {r.status === "confirmed" && (
                    <AButton size="sm" variant="outline" loading={busyId === r.id} onClick={() => onSetStatus(r.id, "checked_in")}>
                      Keldi
                    </AButton>
                  )}
                  {r.status === "checked_in" && (
                    <AButton size="sm" variant="primary" loading={busyId === r.id} onClick={() => onSetStatus(r.id, "in_progress")}>
                      Qabulni boshlash
                    </AButton>
                  )}
                  {r.status === "in_progress" && (
                    <AButton size="sm" variant="primary" loading={busyId === r.id} onClick={() => onSetStatus(r.id, "completed")}>
                      Qabulni yakunlash
                    </AButton>
                  )}
                  {["pending", "confirmed"].includes(r.status) && (
                    <AButton size="sm" variant="ghost" onClick={() => onCancel(r)}>
                      Bekor qilish
                    </AButton>
                  )}
                  <Link
                    href={`/admin/appointments?id=${r.id}`}
                    className="inline-flex items-center rounded-lg px-2.5 py-1.5 text-xs font-medium text-pine-deep hover:bg-pine-tint"
                  >
                    Batafsil
                  </Link>
                </div>
              </td>
            </tr>
          ))}
        </ATable>
      )}
    </Card>
  );
}

"use client";

import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase/browser";
import type { Database } from "@/lib/supabase/database.types";
import { PageHeader, Card, ABadge, ATable, AEmpty, AError, AButton, AInput, ASelect, AModal, ATextArea, LoadingRow } from "@/components/admin/ui";
import { ClipboardList } from "lucide-react";
import { STATUS_LABELS, STATUS_TONES, SOURCE_LABELS, formatDateTime, formatPrice, adminApi, AdminApiError } from "@/lib/admin/client";

type Row = {
  id: string;
  start_at: string;
  status: Database["public"]["Enums"]["appointment_status"];
  source: Database["public"]["Enums"]["appointment_source"];
  notes: string | null;
  patients: { full_name: string | null; phone: string | null } | null;
  doctors: { name: string } | null;
  services: { name: string; price: number } | null;
  payments: { status: string } | null;
};

export default function AppointmentsPage() {
  const searchParams = useSearchParams();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("all");
  const [sourceFilter, setSourceFilter] = useState("all");
  const [q, setQ] = useState("");
  const [noShowRow, setNoShowRow] = useState<Row | null>(null);
  const [noShowReason, setNoShowReason] = useState("");

  const markNoShow = async () => {
    if (!noShowRow || !noShowReason.trim()) return;
    try {
      await adminApi.patch(`/api/admin/appointments/${noShowRow.id}`, {
        action: "status",
        status: "no_show",
        noShowReason: noShowReason.trim(),
      });
      setNoShowRow(null);
      setNoShowReason("");
      await load();
    } catch (e) {
      setError(e instanceof AdminApiError ? e.message : "Xatolik yuz berdi");
    }
  };

  const load = async () => {
    const supabase = createClient();
    let query = supabase
      .from("appointments")
      .select(
        "id, start_at, status, source, notes, patients(full_name, phone), doctors(name), services(name, price), payments(status)",
      )
      .gte("start_at", new Date(Date.now() - 30 * 86400000).toISOString())
      .order("start_at", { ascending: false })
      .limit(200);
    if (filter !== "all") query = query.eq("status", filter as Database["public"]["Enums"]["appointment_status"]);
    if (sourceFilter !== "all") query = query.eq("source", sourceFilter as Database["public"]["Enums"]["appointment_source"]);
    const { data, error: err } = await query;
    if (err) {
      setError("Ma'lumotlarni yuklab bo‘lmadi");
      return;
    }
    setRows(data ?? []);
    setError(null);
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter, sourceFilter, searchParams]);

  const filtered = useMemo(() => {
    if (!q.trim()) return rows;
    const needle = q.trim().toLowerCase();
    return rows?.filter(
      (r) =>
        (r.patients?.full_name ?? "").toLowerCase().includes(needle) ||
        (r.patients?.phone ?? "").toLowerCase().includes(needle) ||
        (r.doctors?.name ?? "").toLowerCase().includes(needle) ||
        (r.services?.name ?? "").toLowerCase().includes(needle),
    );
  }, [rows, q]);

  return (
    <div>
      <PageHeader title="Qabullar" subtitle="So‘nggi 30 kun — qidirish, filtr va boshqarish" />

      {error && <AError message={error} />}

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="w-56">
          <AInput value={q} onChange={setQ} placeholder="Qidirish: bemor, telefon, xizmat…" />
        </div>
        <div className="w-44">
          <ASelect
            value={filter}
            onChange={setFilter}
            options={[
              { value: "all", label: "Barcha holatlar" },
              { value: "pending", label: "Kutilmoqda" },
              { value: "confirmed", label: "Tasdiqlangan" },
              { value: "checked_in", label: "Keldi" },
              { value: "in_progress", label: "Jarayonda" },
              { value: "completed", label: "Yakunlangan" },
              { value: "cancelled", label: "Bekor qilingan" },
              { value: "no_show", label: "Kelmagandi" },
            ]}
          />
        </div>
        <div className="w-44">
          <ASelect
            value={sourceFilter}
            onChange={setSourceFilter}
            options={[
              { value: "all", label: "Barcha manbalar" },
              { value: "telegram_mini_app", label: "Telegram ilova" },
              { value: "telegram_chat", label: "Telegram chat" },
              { value: "admin", label: "Admin" },
              { value: "walk_in", label: "Qabulxonada" },
            ]}
          />
        </div>
      </div>

      {rows === null ? (
        <Card><LoadingRow /></Card>
      ) : (filtered?.length ?? 0) === 0 ? (
        <Card>
          <AEmpty
            title="Topilmadi"
            subtitle="Filtr yoki qidiruv so‘zini o‘zgartiring"
            icon={<ClipboardList className="h-6 w-6" />}
          />
        </Card>
      ) : (
        <ATable headers={["Sana", "Bemor", "Xizmat", "Shifokor", "Manba", "Holat", "To‘lov", "Boshqarish"]}>
          {filtered!.map((r) => (
            <AppointmentRow key={r.id} row={r} onChanged={() => void load()} onError={setError} onNoShow={setNoShowRow} />
          ))}
        </ATable>
      )}

      {noShowRow && (
        <AModal
          title="Kelmagandi — sabab"
          onClose={() => setNoShowRow(null)}
          footer={
            <>
              <AButton variant="ghost" size="md" onClick={() => setNoShowRow(null)}>
                Bekor qilish
              </AButton>
              <AButton variant="danger" size="md" disabled={!noShowReason.trim()} onClick={() => void markNoShow()}>
                Kelmagandi sifatida belgilash
              </AButton>
            </>
          }
        >
          <p className="mb-3 text-sm text-ink-muted">
            {noShowRow.patients?.full_name ?? "Bemor"} uchun kelmaslik sababini kiriting — bu tahlillar sahifasida qayd etiladi.
          </p>
          <ATextArea
            value={noShowReason}
            onChange={setNoShowReason}
            placeholder="Masalan: bemor qo‘ng‘iroq qildi, kelolmaydi"
            rows={3}
          />
        </AModal>
      )}
    </div>
  );
}

function AppointmentRow({
  row,
  onChanged,
  onError,
  onNoShow,
}: {
  row: Row;
  onChanged: () => void;
  onError: (m: string) => void;
  onNoShow: (row: Row) => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);

  const act = async (action: string, extra?: Record<string, unknown>) => {
    setBusy(action);
    try {
      await adminApi.patch(`/api/admin/appointments/${row.id}`, { action, ...extra });
      onChanged();
    } catch (e) {
      onError(e instanceof AdminApiError ? e.message : "Xatolik yuz berdi");
    } finally {
      setBusy(null);
    }
  };

  return (
    <tr className="hover:bg-sand">
      <td className="px-4 py-3 font-semibold text-foreground">{formatDateTime(row.start_at)}</td>
      <td className="px-4 py-3">
        <p className="font-medium text-foreground">{row.patients?.full_name ?? "—"}</p>
        {row.patients?.phone && <p className="text-xs text-ink-muted">{row.patients.phone}</p>}
      </td>
      <td className="px-4 py-3">
        <p className="text-foreground">{row.services?.name ?? "—"}</p>
        <p className="text-xs text-ink-muted">{formatPrice(row.services?.price)}</p>
        {row.notes && <p className="mt-0.5 max-w-[220px] truncate text-xs text-ink-muted" title={row.notes}>“{row.notes}”</p>}
      </td>
      <td className="px-4 py-3 text-foreground">{row.doctors?.name ?? "—"}</td>
      <td className="px-4 py-3"><ABadge tone="gray">{SOURCE_LABELS[row.source] ?? row.source}</ABadge></td>
      <td className="px-4 py-3"><ABadge tone={STATUS_TONES[row.status]}>{STATUS_LABELS[row.status]}</ABadge></td>
      <td className="px-4 py-3">
        <ABadge tone={row.payments?.status === "paid" ? "green" : "amber"}>
          {row.payments?.status === "paid" ? "To‘langan" : "To‘lanmagan"}
        </ABadge>
      </td>
      <td className="px-4 py-3">
        <div className="flex flex-wrap gap-1.5">
          {row.status === "pending" && (
            <AButton size="sm" variant="outline" loading={busy === "confirm"} onClick={() => void act("status", { status: "confirmed" })}>
              Tasdiqlash
            </AButton>
          )}
          {!["cancelled", "no_show", "completed"].includes(row.status) && (
            <AButton size="sm" variant="outline" loading={busy === "no_show"} onClick={() => onNoShow(row)}>
              Kelmagandi
            </AButton>
          )}
          {!["cancelled", "no_show", "completed"].includes(row.status) && (
            <AButton size="sm" variant="danger" loading={busy === "cancel"} onClick={() => void act("cancel")}>
              Bekor qilish
            </AButton>
          )}
        </div>
      </td>
    </tr>
  );
}
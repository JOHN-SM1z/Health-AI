"use client";

import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase/browser";
import type { Database } from "@/lib/supabase/database.types";
import { PageHeader, Card, ABadge, ATable, AEmpty, AError, AButton, AInput, ASelect } from "@/components/admin/ui";
import { STATUS_LABELS, STATUS_TONES, SOURCE_LABELS, formatDateTime, formatPrice, adminApi, AdminApiError } from "@/lib/admin/client";

type Row = {
  id: string;
  start_at: string;
  status: Database["public"]["Enums"]["appointment_status"];
  source: Database["public"]["Enums"]["appointment_source"];
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
  const [q, setQ] = useState("");

  const load = async () => {
    const supabase = createClient();
    let query = supabase
      .from("appointments")
      .select(
        "id, start_at, status, source, patients(full_name, phone), doctors(name), services(name, price), payments(status)",
      )
      .gte("start_at", new Date(Date.now() - 30 * 86400000).toISOString())
      .order("start_at", { ascending: false })
      .limit(200);
    if (filter !== "all") query = query.eq("status", filter as Database["public"]["Enums"]["appointment_status"]);
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
  }, [filter, searchParams]);

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
      </div>

      {rows === null ? (
        <Card><div className="h-2 w-full animate-pulse rounded bg-hairline" /></Card>
      ) : (filtered?.length ?? 0) === 0 ? (
        <Card><AEmpty title="Topilmadi" subtitle="Filtr yoki qidiruv so‘zini o‘zgartiring" /></Card>
      ) : (
        <ATable headers={["Sana", "Bemor", "Xizmat", "Shifokor", "Manba", "Holat", "To‘lov", "Boshqarish"]}>
          {filtered!.map((r) => (
            <AppointmentRow key={r.id} row={r} onChanged={() => void load()} onError={setError} />
          ))}
        </ATable>
      )}
    </div>
  );
}

function AppointmentRow({ row, onChanged, onError }: { row: Row; onChanged: () => void; onError: (m: string) => void }) {
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
            <AButton size="sm" variant="danger" loading={busy === "cancel"} onClick={() => void act("cancel")}>
              Bekor qilish
            </AButton>
          )}
        </div>
      </td>
    </tr>
  );
}
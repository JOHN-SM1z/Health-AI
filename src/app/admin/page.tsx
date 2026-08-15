"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/browser";
import type { Database } from "@/lib/supabase/database.types";
import { PageHeader, Card, ABadge, ATable, AEmpty, AError, AButton, StatCard, LoadingRow } from "@/components/admin/ui";
import { CalendarDays } from "lucide-react";
import { STATUS_LABELS, STATUS_TONES, SOURCE_LABELS, formatTime, formatPrice, adminApi, AdminApiError } from "@/lib/admin/client";

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

export default function TodayPage() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = async () => {
    const supabase = createClient();
    const { data, error: err } = await supabase
      .from("appointments")
      .select(
        "id, start_at, status, source, patients(full_name, phone), doctors(name), services(name, price), payments(status)",
      )
      .gte("start_at", new Date(new Date().setHours(0, 0, 0, 0)).toISOString())
      .lt("start_at", new Date(new Date().setHours(24, 0, 0, 0)).toISOString())
      .order("start_at", { ascending: true });
    if (err) {
      setError("Ma'lumotlarni yuklab bo‘lmadi");
      return;
    }
    setRows(data ?? []);
    setError(null);
  };

  useEffect(() => {
    void load();
  }, []);

  const counts = useMemo(() => {
    const c = { today: 0, pending: 0, confirmed: 0, completed: 0, cancelled: 0, revenue: 0 };
    for (const r of rows ?? []) {
      c.today += 1;
      if (r.status === "pending") c.pending += 1;
      if (r.status === "confirmed") c.confirmed += 1;
      if (r.status === "completed") c.completed += 1;
      if (r.status === "cancelled") c.cancelled += 1;
      if (r.status === "completed" && r.payments?.status === "paid") c.revenue += r.services?.price ?? 0;
    }
    return c;
  }, [rows]);

  const setStatus = async (id: string, status: string) => {
    setBusyId(id);
    try {
      await adminApi.patch(`/api/admin/appointments/${id}`, { action: "status", status });
      await load();
    } catch (e) {
      setError(e instanceof AdminApiError ? e.message : "Xatolik yuz berdi");
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div>
      <PageHeader title="Bugungi qabullar" subtitle={new Date().toLocaleDateString("uz-UZ", { weekday: "long", day: "numeric", month: "long" })} />

      {error && <AError message={error} />}

      <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-5">
        <StatCard label="Jami" value={counts.today} />
        <StatCard label="Kutilmoqda" value={counts.pending} tone="clay" />
        <StatCard label="Tasdiqlangan" value={counts.confirmed} tone="info" />
        <StatCard label="Yakunlangan" value={counts.completed} tone="pine" />
        <StatCard label="Tushum (to‘langan)" value={`${counts.revenue.toLocaleString("uz-UZ")} so‘m`} />
      </div>

      {rows === null ? (
        <Card>
          <LoadingRow />
        </Card>
      ) : rows.length === 0 ? (
        <Card>
          <AEmpty
            title="Bugungi qabullar yo‘q"
            subtitle="Yangi qabul qo‘shish uchun yuqoridagi tugmadan foydalaning"
            icon={<CalendarDays className="h-6 w-6" />}
          />
        </Card>
      ) : (
        <ATable headers={["Vaqt", "Bemor", "Xizmat", "Shifokor", "Manba", "Holat", "To‘lov", "Amallar"]}>
          {rows.map((r) => (
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
              <td className="px-4 py-3"><ABadge tone="gray">{SOURCE_LABELS[r.source] ?? r.source}</ABadge></td>
              <td className="px-4 py-3"><ABadge tone={STATUS_TONES[r.status]}>{STATUS_LABELS[r.status]}</ABadge></td>
              <td className="px-4 py-3">
                <ABadge tone={r.payments?.status === "paid" ? "green" : r.payments?.status === "refunded" ? "gray" : "amber"}>
                  {r.payments?.status === "paid" ? "To‘langan" : r.payments?.status === "refunded" ? "Qaytarilgan" : "To‘lanmagan"}
                </ABadge>
              </td>
              <td className="px-4 py-3">
                <div className="flex gap-1.5">
                  {["pending", "confirmed"].includes(r.status) && (
                    <AButton size="sm" variant="outline" loading={busyId === r.id} onClick={() => void setStatus(r.id, "checked_in")}>
                      Keldi
                    </AButton>
                  )}
                  {["checked_in"].includes(r.status) && (
                    <AButton size="sm" variant="primary" loading={busyId === r.id} onClick={() => void setStatus(r.id, "in_progress")}>
                      Jarayonda
                    </AButton>
                  )}
                  {["in_progress"].includes(r.status) && (
                    <AButton size="sm" variant="primary" loading={busyId === r.id} onClick={() => void setStatus(r.id, "completed")}>
                      Yakunlash
                    </AButton>
                  )}
                  {!["cancelled", "no_show", "completed"].includes(r.status) && (
                    <Link href={`/admin/appointments?id=${r.id}`} className="inline-flex items-center rounded-lg px-2.5 py-1.5 text-xs font-medium text-pine-deep hover:bg-pine-tint">
                      Boshqarish
                    </Link>
                  )}
                </div>
              </td>
            </tr>
          ))}
        </ATable>
      )}
    </div>
  );
}
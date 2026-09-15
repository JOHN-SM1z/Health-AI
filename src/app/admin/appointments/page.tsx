"use client";

import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase/browser";
import type { Database } from "@/lib/supabase/database.types";
import { PageHeader, Card, ABadge, ATable, AEmpty, AError, AButton, AInput, ASelect, AModal, ATextArea, LoadingRow } from "@/components/admin/ui";
import { ClipboardList } from "lucide-react";
import { STATUS_LABELS, STATUS_TONES, SOURCE_LABELS, formatDateTime, formatPrice, adminApi, AdminApiError } from "@/lib/admin/client";
import { RecordPaymentModal } from "@/components/admin/record-payment-modal";

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
  const highlightId = searchParams.get("id");
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("all");
  const [sourceFilter, setSourceFilter] = useState("all");
  const [q, setQ] = useState("");
  const [noShowRow, setNoShowRow] = useState<Row | null>(null);
  const [noShowReason, setNoShowReason] = useState("");
  const [cancelRow, setCancelRow] = useState<Row | null>(null);
  const [cancelReason, setCancelReason] = useState("");
  const [cancelBusy, setCancelBusy] = useState(false);
  const [paymentRow, setPaymentRow] = useState<Row | null>(null);

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

  const confirmCancel = async () => {
    if (!cancelRow) return;
    setCancelBusy(true);
    try {
      await adminApi.patch(`/api/admin/appointments/${cancelRow.id}`, {
        action: "cancel",
        reason: cancelReason.trim() || undefined,
      });
      setCancelRow(null);
      setCancelReason("");
      await load();
    } catch (e) {
      setError(e instanceof AdminApiError ? e.message : "Xatolik yuz berdi");
    } finally {
      setCancelBusy(false);
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

  // Deep link from the Overview page's "Boshqarish" button (?id=<appointment
  // id>): scroll the target row into view once it has loaded, since it may
  // be anywhere in a 200-row, 30-day list.
  useEffect(() => {
    if (!highlightId || !rows) return;
    document.getElementById(`appt-${highlightId}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [highlightId, rows]);

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
              { value: "web", label: "Veb-sayt" },
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
            <AppointmentRow
              key={r.id}
              row={r}
              highlighted={r.id === highlightId}
              onChanged={() => void load()}
              onError={setError}
              onNoShow={setNoShowRow}
              onCancel={setCancelRow}
              onPay={setPaymentRow}
            />
          ))}
        </ATable>
      )}

      {cancelRow && (
        <AModal
          title="Qabulni bekor qilish"
          onClose={() => setCancelRow(null)}
          footer={
            <>
              <AButton variant="ghost" size="md" onClick={() => setCancelRow(null)} disabled={cancelBusy}>
                Yopish
              </AButton>
              <AButton variant="danger" size="md" loading={cancelBusy} onClick={() => void confirmCancel()}>
                Ha, bekor qilish
              </AButton>
            </>
          }
        >
          <p className="mb-3 text-sm text-ink-muted">
            {cancelRow.patients?.full_name ?? "Bemor"} uchun {formatDateTime(cancelRow.start_at)} dagi qabulni bekor
            qilmoqchimisiz? Bemorga xabar yuboriladi va bu amalni ortga qaytarib bo‘lmaydi.
          </p>
          <ATextArea
            value={cancelReason}
            onChange={setCancelReason}
            placeholder="Sabab (ixtiyoriy) — masalan: bemor so‘rovi bilan"
            rows={3}
          />
        </AModal>
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

      {paymentRow && (
        <RecordPaymentModal
          appointmentId={paymentRow.id}
          patientName={paymentRow.patients?.full_name ?? "Bemor"}
          amount={paymentRow.services?.price}
          onClose={() => setPaymentRow(null)}
          onRecorded={() => {
            setPaymentRow(null);
            void load();
          }}
        />
      )}
    </div>
  );
}

function AppointmentRow({
  row,
  highlighted,
  onChanged,
  onError,
  onNoShow,
  onCancel,
  onPay,
}: {
  row: Row;
  highlighted: boolean;
  onChanged: () => void;
  onError: (m: string) => void;
  onNoShow: (row: Row) => void;
  onCancel: (row: Row) => void;
  onPay: (row: Row) => void;
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
    <tr id={`appt-${row.id}`} className={highlighted ? "bg-pine-tint/60" : "hover:bg-sand"}>
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
        {row.payments?.status === "paid" ? (
          <ABadge tone="green">To‘langan</ABadge>
        ) : (
          <button
            type="button"
            onClick={() => onPay(row)}
            className="inline-flex items-center gap-1 rounded-full bg-clay-tint px-2.5 py-0.5 text-xs font-semibold tracking-wide text-clay-deep transition-colors hover:brightness-95"
            title="To‘lovni qayd etish"
          >
            To‘lanmagan
          </button>
        )}
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
            <AButton size="sm" variant="danger" onClick={() => onCancel(row)}>
              Bekor qilish
            </AButton>
          )}
        </div>
      </td>
    </tr>
  );
}
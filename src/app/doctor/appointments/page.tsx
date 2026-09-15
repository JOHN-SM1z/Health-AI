"use client";

import { useEffect, useState } from "react";
import { History } from "lucide-react";
import { createClient } from "@/lib/supabase/browser";
import type { Database } from "@/lib/supabase/database.types";
import { getCurrentDoctor, type CurrentDoctor } from "@/lib/doctor/current-doctor";
import { PageHeader, Card, ABadge, ATable, AEmpty, AError, ASelect, AButton, LoadingRow } from "@/components/admin/ui";
import { formatDateTime, STATUS_LABELS, STATUS_TONES } from "@/lib/admin/client";
import { ConsultationModal, type ConsultationAppointment } from "@/components/admin/consultation-modal";

const PAGE_SIZE = 20;

type AppointmentStatus = Database["public"]["Enums"]["appointment_status"];

// "Qabul tarixi" is a look-back tool, so only the three terminal statuses
// are offered as filters — active/upcoming ones already live on the main
// dashboard and still show up here unfiltered under "Barchasi".
const FILTER_OPTIONS: { value: string; label: string }[] = [
  { value: "", label: "Barchasi" },
  { value: "completed", label: "Yakunlangan" },
  { value: "cancelled", label: "Bekor qilingan" },
  { value: "no_show", label: "Kelmagandi" },
];

type Row = {
  id: string;
  start_at: string;
  status: AppointmentStatus;
  notes: string | null;
  cancelled_reason: string | null;
  no_show_reason: string | null;
  patients: { id: string; full_name: string | null; phone: string | null } | null;
  services: { name: string; price: number } | null;
};

export default function DoctorAppointmentHistoryPage() {
  const [doctor, setDoctor] = useState<CurrentDoctor | null | undefined>(undefined);
  const [statusFilter, setStatusFilter] = useState("");
  const [page, setPage] = useState(1);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [modalTarget, setModalTarget] = useState<ConsultationAppointment | null>(null);

  useEffect(() => {
    const supabase = createClient();
    void getCurrentDoctor(supabase).then(setDoctor);
  }, []);

  const loadPage = async () => {
    if (!doctor) return;
    const supabase = createClient();
    let query = supabase
      .from("appointments")
      .select(
        "id, start_at, status, notes, cancelled_reason, no_show_reason, patients(id, full_name, phone), services(name, price)",
        { count: "exact" },
      )
      .eq("doctor_id", doctor.id)
      .order("start_at", { ascending: false })
      .range((page - 1) * PAGE_SIZE, page * PAGE_SIZE - 1);
    if (statusFilter) query = query.eq("status", statusFilter as AppointmentStatus);
    const { data, error: err, count } = await query;
    if (err) {
      setError("Qabullar tarixini yuklab bo‘lmadi");
      return;
    }
    setRows((data as Row[] | null) ?? []);
    setTotal(count ?? 0);
    setError(null);
  };

  useEffect(() => {
    void loadPage();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doctor, page, statusFilter]);

  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  if (doctor === null) {
    return (
      <div>
        <PageHeader eyebrow="Health AI — Shifokor" title="Qabul tarixi" />
        <Card>
          <AEmpty
            title="Shifokor hisobi ulanmagan"
            subtitle="Admin panelda shifokor kartasiga profilingizni bog‘lang."
            icon={<History className="h-6 w-6" />}
          />
        </Card>
      </div>
    );
  }

  return (
    <div>
      <PageHeader eyebrow="Health AI — Shifokor" title="Qabul tarixi" subtitle="Barcha qabullaringiz — yangidan eskiga" />
      {error && <AError message={error} />}

      <div className="mb-4">
        <ASelect
          value={statusFilter}
          onChange={(v) => {
            setStatusFilter(v);
            setPage(1);
          }}
          options={FILTER_OPTIONS}
          className="max-w-xs"
          aria-label="Holat bo‘yicha filtr"
        />
      </div>

      {rows === null ? (
        <Card>
          <LoadingRow />
        </Card>
      ) : rows.length === 0 ? (
        <Card>
          <AEmpty title="Qabullar topilmadi" subtitle="Filtrni o‘zgartirib ko‘ring" icon={<History className="h-6 w-6" />} />
        </Card>
      ) : (
        <Card className="p-0">
          <ATable headers={["Sana", "Bemor", "Xizmat", "Holat"]}>
            {rows.map((r) => (
              <tr key={r.id} className="cursor-pointer hover:bg-sand" onClick={() => setModalTarget(r)}>
                <td className="px-4 py-3 text-sm text-foreground">{formatDateTime(r.start_at)}</td>
                <td className="px-4 py-3">
                  <p className="font-medium text-foreground">{r.patients?.full_name ?? "—"}</p>
                  {r.patients?.phone && <p className="text-xs text-ink-muted">{r.patients.phone}</p>}
                </td>
                <td className="px-4 py-3 text-sm text-foreground">{r.services?.name ?? "—"}</td>
                <td className="px-4 py-3">
                  <ABadge tone={STATUS_TONES[r.status] ?? "neutral"}>{STATUS_LABELS[r.status] ?? r.status}</ABadge>
                </td>
              </tr>
            ))}
          </ATable>
          {pageCount > 1 && (
            <div className="flex items-center justify-between border-t border-hairline px-4 py-3">
              <p className="text-xs text-ink-muted">
                {total} ta qabul — {page} / {pageCount}
              </p>
              <div className="flex gap-2">
                <AButton size="sm" variant="outline" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                  Oldingi
                </AButton>
                <AButton size="sm" variant="outline" disabled={page >= pageCount} onClick={() => setPage((p) => p + 1)}>
                  Keyingi
                </AButton>
              </div>
            </div>
          )}
        </Card>
      )}

      {modalTarget && doctor && (
        <ConsultationModal
          appointment={modalTarget}
          doctorId={doctor.id}
          onClose={() => setModalTarget(null)}
          onStatusChanged={() => void loadPage()}
        />
      )}
    </div>
  );
}

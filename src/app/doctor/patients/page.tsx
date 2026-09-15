"use client";

import { useEffect, useState } from "react";
import { Users } from "lucide-react";
import { createClient } from "@/lib/supabase/browser";
import type { Database } from "@/lib/supabase/database.types";
import { getCurrentDoctor, type CurrentDoctor } from "@/lib/doctor/current-doctor";
import { PageHeader, Card, ABadge, ATable, AEmpty, AError, AInput, AButton, LoadingRow } from "@/components/admin/ui";
import { formatDateTime, STATUS_LABELS, STATUS_TONES } from "@/lib/admin/client";
import { ConsultationModal, type ConsultationAppointment } from "@/components/admin/consultation-modal";

const PAGE_SIZE = 20;

type PatientRow = {
  id: string;
  full_name: string | null;
  phone: string | null;
  telegram_username: string | null;
  last_seen_at: string | null;
  appointments_count: number;
};

type PatientDetail = {
  id: string;
  full_name: string | null;
  phone: string | null;
  telegram_username: string | null;
  operational_notes: string | null;
  last_seen_at: string | null;
  created_at: string;
};

type VisitRow = {
  id: string;
  start_at: string;
  status: Database["public"]["Enums"]["appointment_status"];
  notes: string | null;
  services: { name: string; price: number } | null;
};

/**
 * "My patients" — scoped to patients this doctor has actually treated. RLS
 * (patients/appointments "for staff" policies, role_based_rls.sql) enforces
 * this at the database level for every query below; the explicit
 * eq("doctor_id", ...) filters here are defense in depth, matching the rest
 * of the app's convention of never relying on RLS alone in application code.
 */
export default function DoctorPatientsPage() {
  const [doctor, setDoctor] = useState<CurrentDoctor | null | undefined>(undefined);
  const [q, setQ] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [rows, setRows] = useState<PatientRow[] | null>(null);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [detail, setDetail] = useState<PatientDetail | null>(null);
  const [visits, setVisits] = useState<VisitRow[] | null>(null);
  const [detailBusy, setDetailBusy] = useState(false);
  const [modalTarget, setModalTarget] = useState<ConsultationAppointment | null>(null);

  useEffect(() => {
    const supabase = createClient();
    void getCurrentDoctor(supabase).then(setDoctor);
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setSearch(q);
      setPage(1);
    }, 350);
    return () => window.clearTimeout(timer);
  }, [q]);

  useEffect(() => {
    if (!doctor) return;
    const supabase = createClient();
    void (async () => {
      let query = supabase
        .from("patients")
        .select(
          "id, full_name, phone, telegram_username, last_seen_at, appointments!appointments_patient_id_fkey(count)",
          { count: "exact" },
        )
        .order("last_seen_at", { ascending: false, nullsFirst: false })
        .range((page - 1) * PAGE_SIZE, page * PAGE_SIZE - 1);
      if (search) query = query.or(`full_name.ilike.%${search}%,phone.ilike.%${search}%`);
      const { data, error: err, count } = await query;
      if (err) {
        setError("Bemorlarni yuklab bo‘lmadi");
        return;
      }
      setRows(
        (data ?? []).map((p) => ({
          ...p,
          appointments_count: (p.appointments as unknown as [{ count: number }] | null)?.[0]?.count ?? 0,
        })),
      );
      setTotal(count ?? 0);
      setError(null);
    })();
  }, [doctor, page, search]);

  const openDetail = async (id: string) => {
    if (!doctor) return;
    setDetailId(id);
    setDetail(null);
    setVisits(null);
    setDetailBusy(true);
    const supabase = createClient();
    try {
      const [{ data: patient }, { data: appts }] = await Promise.all([
        supabase
          .from("patients")
          .select("id, full_name, phone, telegram_username, operational_notes, last_seen_at, created_at")
          .eq("id", id)
          .maybeSingle(),
        supabase
          .from("appointments")
          .select("id, start_at, status, notes, services(name, price)")
          .eq("patient_id", id)
          .eq("doctor_id", doctor.id)
          .order("start_at", { ascending: false })
          .limit(20),
      ]);
      setDetail(patient ?? null);
      setVisits((appts as VisitRow[] | null) ?? []);
    } catch {
      setError("Bemor ma'lumotlarini yuklab bo‘lmadi");
      setDetailId(null);
    } finally {
      setDetailBusy(false);
    }
  };

  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  if (doctor === null) {
    return (
      <div>
        <PageHeader eyebrow="Health AI — Shifokor" title="Mening bemorlarim" />
        <Card>
          <AEmpty
            title="Shifokor hisobi ulanmagan"
            subtitle="Admin panelda shifokor kartasiga profilingizni bog‘lang."
            icon={<Users className="h-6 w-6" />}
          />
        </Card>
      </div>
    );
  }

  return (
    <div>
      <PageHeader eyebrow="Health AI — Shifokor" title="Mening bemorlarim" subtitle="Siz qabul qilgan bemorlar" />
      {error && <AError message={error} />}

      <div className="mb-4">
        <AInput value={q} onChange={setQ} placeholder="Ism yoki telefon bo‘yicha qidirish…" className="max-w-xs" aria-label="Bemorlarni qidirish" />
      </div>

      <div className="grid gap-4 lg:grid-cols-5">
        <div className="lg:col-span-3">
          {rows === null ? (
            <Card>
              <LoadingRow />
            </Card>
          ) : rows.length === 0 ? (
            <Card>
              <AEmpty
                title="Bemorlar topilmadi"
                subtitle="Qidiruv shartini o‘zgartiring — faqat siz qabul qilgan bemorlar ko‘rsatiladi"
                icon={<Users className="h-6 w-6" />}
              />
            </Card>
          ) : (
            <Card className="p-0">
              <ATable headers={["Bemor", "Aloqa", "Tashriflar (men bilan)", "Oxirgi faoliyat", ""]}>
                {rows.map((p) => (
                  <tr key={p.id} className="cursor-pointer hover:bg-sand" onClick={() => void openDetail(p.id)}>
                    <td className="px-4 py-3">
                      <p className="font-medium text-foreground">{p.full_name ?? "Noma’lum"}</p>
                      {p.telegram_username && <p className="text-xs text-ink-muted">@{p.telegram_username}</p>}
                    </td>
                    <td className="px-4 py-3 text-sm text-ink-muted">{p.phone ?? "—"}</td>
                    <td className="px-4 py-3 text-sm text-foreground">{p.appointments_count}</td>
                    <td className="px-4 py-3 text-xs text-ink-muted">{formatDateTime(p.last_seen_at)}</td>
                    <td className="px-4 py-3">
                      <AButton size="sm" variant="ghost">
                        Batafsil
                      </AButton>
                    </td>
                  </tr>
                ))}
              </ATable>
              {pageCount > 1 && (
                <div className="flex items-center justify-between border-t border-hairline px-4 py-3">
                  <p className="text-xs text-ink-muted">
                    {total} ta bemor — {page} / {pageCount}
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
        </div>

        <div className="lg:col-span-2">
          {!detailId ? (
            <Card>
              <AEmpty title="Bemorni tanlang" subtitle="Ro‘yxatdan birini oching — tashriflar tarixi ko‘rinadi" icon={<Users className="h-6 w-6" />} />
            </Card>
          ) : detailBusy || !detail ? (
            <Card>
              <LoadingRow />
            </Card>
          ) : (
            <Card className="flex flex-col gap-4">
              <div>
                <p className="font-bold text-foreground">{detail.full_name ?? "Noma’lum"}</p>
                <p className="text-sm text-ink-muted">
                  {detail.phone ?? "Telefon yo‘q"}
                  {detail.telegram_username ? ` · @${detail.telegram_username}` : ""}
                </p>
              </div>

              {detail.operational_notes && (
                <div>
                  <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-muted">Administratsiya izohi</p>
                  <p className="text-xs text-ink-muted">{detail.operational_notes}</p>
                </div>
              )}

              <div>
                <p className="mb-2 font-display text-sm font-bold text-foreground">Tashriflar tarixi ({visits?.length ?? 0})</p>
                {!visits || visits.length === 0 ? (
                  <p className="text-sm text-ink-muted">Hali tashrif bo‘lmagan</p>
                ) : (
                  <div className="space-y-2">
                    {visits.map((v) => (
                      <button
                        key={v.id}
                        type="button"
                        onClick={() =>
                          setModalTarget({
                            id: v.id,
                            start_at: v.start_at,
                            status: v.status,
                            notes: v.notes,
                            services: v.services,
                            patients: { id: detail.id, full_name: detail.full_name, phone: detail.phone },
                          })
                        }
                        className="flex w-full items-center justify-between gap-3 rounded-xl border border-hairline px-3 py-2 text-left hover:bg-sand"
                      >
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium text-foreground">{v.services?.name ?? "Xizmat"}</p>
                          <p className="text-xs text-ink-muted">{formatDateTime(v.start_at)}</p>
                        </div>
                        <ABadge tone={STATUS_TONES[v.status] ?? "neutral"}>{STATUS_LABELS[v.status] ?? v.status}</ABadge>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </Card>
          )}
        </div>
      </div>

      {modalTarget && doctor && detailId && (
        <ConsultationModal
          appointment={modalTarget}
          doctorId={doctor.id}
          onClose={() => setModalTarget(null)}
          onStatusChanged={() => void openDetail(detailId)}
        />
      )}
    </div>
  );
}

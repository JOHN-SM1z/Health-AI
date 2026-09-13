"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/browser";
import { PageHeader, Card, ABadge, ATable, AEmpty, AError, AButton, AInput, ASelect, AModal, LoadingRow } from "@/components/admin/ui";
import { CalendarDays, UserPlus } from "lucide-react";
import { STATUS_LABELS, STATUS_TONES, SOURCE_LABELS, formatTime, formatPrice, adminApi, AdminApiError } from "@/lib/admin/client";
import type { DashboardSnapshot, TodayAppointmentRow } from "@/lib/admin/dashboard-types";
import type { Permission } from "@/lib/auth/permissions";
import { ManagerOverview, ReceptionistOverview } from "@/components/admin/dashboard-overview";
import { OwnerDashboard } from "@/components/admin/owner-dashboard";

type Row = TodayAppointmentRow;
type Dashboard = DashboardSnapshot;

type ServiceOption = { id: string; name: string; price: number; doctor_services: { doctor_id: string }[] | null };
type DoctorOption = { id: string; name: string };

/**
 * The owner's job ("how is my clinic performing?") is fundamentally
 * different from the front-desk/operations job everyone else here does —
 * so instead of one shared page with a swapped-out top section, the owner
 * gets a completely different component tree (OwnerDashboard), and never
 * mounts the appointments-table/quick-booking state this page exists for.
 */
export default function TodayPage() {
  const [permissions, setPermissions] = useState<Set<Permission> | null>(null);
  const [clinicTimezone, setClinicTimezone] = useState<string | null>(null);

  useEffect(() => {
    void fetch("/api/admin/me")
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        setPermissions(new Set<Permission>(j?.data?.permissions ?? []));
        setClinicTimezone(j?.data?.clinicTimezone ?? "Asia/Tashkent");
      })
      .catch(() => {
        setPermissions(new Set());
        setClinicTimezone("Asia/Tashkent");
      });
  }, []);

  if (permissions === null || clinicTimezone === null) {
    return (
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <Card key={i}>
            <LoadingRow />
          </Card>
        ))}
      </div>
    );
  }

  if (permissions.has("finance:view")) {
    return <OwnerDashboard clinicTimezone={clinicTimezone} />;
  }

  return <OperationsView permissions={permissions} />;
}

function OperationsView({ permissions }: { permissions: Set<Permission> }) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [todayLabel, setTodayLabel] = useState("");

  useEffect(() => {
    setTodayLabel(new Date().toLocaleDateString("uz-UZ", { weekday: "long", day: "numeric", month: "long" }));
  }, []);

  const loadDashboard = async (): Promise<Dashboard | null> => {
    try {
      const d = await adminApi.get<Dashboard>("/api/admin/dashboard");
      setDashboard(d);
      return d;
    } catch {
      setDashboard(null);
      return null;
    }
  };

  // "Today" must use the clinic's own timezone, never the browser's (see
  // src/lib/time/local.ts) — the dashboard endpoint already computes that
  // window server-side, so reuse it instead of recomputing local midnight
  // here, which would silently disagree with the stat cards above whenever
  // staff open this page from a device in a different timezone.
  const load = async (day: { start: string; end: string } | null) => {
    if (!day) {
      setError("Ma'lumotlarni yuklab bo‘lmadi");
      return;
    }
    const supabase = createClient();
    const { data, error: err } = await supabase
      .from("appointments")
      .select(
        "id, start_at, status, source, patients(full_name, phone), doctors(name), services(name, price), payments(status)",
      )
      .gte("start_at", day.start)
      .lt("start_at", day.end)
      .order("start_at", { ascending: true });
    if (err) {
      setError("Ma'lumotlarni yuklab bo‘lmadi");
      return;
    }
    setRows(data ?? []);
    setError(null);
  };

  const refreshAll = async () => {
    const d = await loadDashboard();
    await load(d?.day ?? null);
  };

  useEffect(() => {
    void refreshAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const counts = useMemo(() => {
    const c: Record<string, number> = { today: 0, pending: 0, confirmed: 0, checked_in: 0, in_progress: 0, completed: 0, cancelled: 0, no_show: 0 };
    for (const r of rows ?? []) {
      c.today += 1;
      c[r.status] = (c[r.status] ?? 0) + 1;
    }
    return c;
  }, [rows]);

  const setStatus = async (id: string, status: string) => {
    setBusyId(id);
    try {
      await adminApi.patch(`/api/admin/appointments/${id}`, { action: "status", status });
      await load(dashboard?.day ?? null);
    } catch (e) {
      setError(e instanceof AdminApiError ? e.message : "Xatolik yuz berdi");
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div>
      <PageHeader
        title="Bugungi qabullar"
        subtitle={todayLabel}
        action={
          <AButton size="md" onClick={() => setModalOpen(true)}>
            <UserPlus className="mr-1.5 h-4 w-4" />
            Tezkor yozish
          </AButton>
        }
      />

      {error && <AError message={error} />}

      {permissions.has("catalog:manage") ? (
        <ManagerOverview dashboard={dashboard} rows={rows} counts={counts} />
      ) : (
        <ReceptionistOverview dashboard={dashboard} rows={rows} counts={counts} />
      )}

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

      {modalOpen && (
        <QuickBookingModal
          onClose={() => setModalOpen(false)}
          onCreated={() => {
            setModalOpen(false);
            void refreshAll();
          }}
          onError={setError}
        />
      )}
    </div>
  );
}

function QuickBookingModal({ onClose, onCreated, onError }: { onClose: () => void; onCreated: () => void; onError: (m: string) => void }) {
  const [services, setServices] = useState<ServiceOption[] | null>(null);
  const [doctors, setDoctors] = useState<DoctorOption[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [patientName, setPatientName] = useState("");
  const [phone, setPhone] = useState("");
  const [serviceId, setServiceId] = useState("");
  const [doctorId, setDoctorId] = useState("");
  const [startAt, setStartAt] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    Promise.all([
      adminApi.get<{ services: ServiceOption[] }>("/api/admin/services"),
      adminApi.get<{ doctors: DoctorOption[] }>("/api/admin/doctors"),
    ])
      .then(([s, d]) => {
        setServices(s.services);
        setDoctors(d.doctors);
      })
      .catch((e) => setLoadError(e instanceof AdminApiError ? e.message : "Ma'lumot yuklab bo‘lmadi"));
  }, []);

  const serviceDoctors = useMemo(() => {
    if (!services || !doctors) return [];
    const linked = services.find((s) => s.id === serviceId)?.doctor_services?.map((d) => d.doctor_id) ?? [];
    return linked.length > 0 ? doctors.filter((d) => linked.includes(d.id)) : doctors;
  }, [services, doctors, serviceId]);

  const submit = async () => {
    if (!serviceId || !doctorId || !startAt || patientName.trim().length < 2 || phone.trim().length < 7) return;
    setSubmitting(true);
    setLoadError(null);
    try {
      await adminApi.post("/api/admin/appointments", {
        patientName: patientName.trim(),
        phone: phone.trim(),
        doctorId,
        serviceId,
        startAt: new Date(startAt).toISOString(),
        source: "walk_in",
      });
      onCreated();
    } catch (e) {
      onError(e instanceof AdminApiError ? e.message : "Yozishda xatolik");
      setSubmitting(false);
    }
  };

  const options = (list: { id: string; name: string }[] | null, extra: Array<{ value: string; label: string }> = []) => [
    ...extra,
    ...(list ?? []).map((x) => ({ value: x.id, label: x.name })),
  ];

  return (
    <AModal
      title="Tezkor qabul yozish"
      onClose={onClose}
      footer={
        <>
          <AButton variant="ghost" size="md" onClick={onClose} disabled={submitting}>
            Bekor qilish
          </AButton>
          <AButton
            size="md"
            loading={submitting}
            disabled={!serviceId || !doctorId || !startAt || patientName.trim().length < 2 || phone.trim().length < 7}
            onClick={() => void submit()}
          >
            Yozish
          </AButton>
        </>
      }
    >
      {loadError && <AError message={loadError} />}
      {!services || !doctors ? (
        <LoadingRow />
      ) : (
        <div className="flex flex-col gap-3">
          <div>
            <label htmlFor="qb-name" className="mb-1 block text-xs font-medium text-ink-muted">
              Bemor ismi
            </label>
            <AInput value={patientName} onChange={setPatientName} placeholder="Ism familiya" aria-label="Bemor ismi" />
          </div>
          <div>
            <label htmlFor="qb-phone" className="mb-1 block text-xs font-medium text-ink-muted">
              Telefon
            </label>
            <AInput value={phone} onChange={setPhone} placeholder="+998 90 123 45 67" type="tel" aria-label="Telefon" />
          </div>
          <div>
            <label htmlFor="qb-service" className="mb-1 block text-xs font-medium text-ink-muted">
              Xizmat
            </label>
            <ASelect
              value={serviceId}
              onChange={(v) => {
                setServiceId(v);
                setDoctorId("");
              }}
              options={options(services, [{ value: "", label: "Xizmatni tanlang" }])}
              aria-label="Xizmat"
            />
          </div>
          <div>
            <label htmlFor="qb-doctor" className="mb-1 block text-xs font-medium text-ink-muted">
              Shifokor
            </label>
            <ASelect
              value={doctorId}
              onChange={setDoctorId}
              options={options(serviceDoctors, [{ value: "", label: "Shifokorni tanlang" }])}
              aria-label="Shifokor"
            />
          </div>
          <div>
            <label htmlFor="qb-start" className="mb-1 block text-xs font-medium text-ink-muted">
              Sana va vaqt
            </label>
            <input
              id="qb-start"
              type="datetime-local"
              value={startAt}
              onChange={(e) => setStartAt(e.target.value)}
              className="w-full rounded-lg border border-hairline bg-white px-3 py-2 text-sm text-foreground outline-none focus:border-pine"
            />
          </div>
        </div>
      )}
    </AModal>
  );
}

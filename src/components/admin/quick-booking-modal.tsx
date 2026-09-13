"use client";

import { useEffect, useMemo, useState } from "react";
import { AModal, AButton, AInput, ASelect, AError, LoadingRow } from "@/components/admin/ui";
import { adminApi, AdminApiError } from "@/lib/admin/client";

type ServiceOption = { id: string; name: string; price: number; doctor_services: { doctor_id: string }[] | null };
type DoctorOption = { id: string; name: string };

/** Shared walk-in/quick booking form used by every admin-workspace role that can create appointments. */
export function QuickBookingModal({ onClose, onCreated, onError }: { onClose: () => void; onCreated: () => void; onError: (m: string) => void }) {
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

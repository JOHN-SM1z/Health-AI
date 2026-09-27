"use client";

import { useEffect, useMemo, useState } from "react";
import { AButton, AError, AInput, AModal, ASelect, LoadingRow } from "@/components/admin/ui";
import { adminApi, AdminApiError } from "@/lib/admin/client";

type ServiceOption = { id: string; name: string; price: number; doctor_services: { doctor_id: string }[] | null };
type DoctorOption = { id: string; name: string };

/** Booking the follow-up of an accepted referral: patient and doctor are fixed. */
export type FollowUpPreset = {
  referralId: string;
  patientId: string;
  patientName: string;
  doctor: DoctorOption;
};

/**
 * Staff booking through the transactional booking engine
 * (POST /api/admin/appointments). Without a preset it records a walk-in for a
 * new patient; with `followUp` it books a referral's follow-up for the
 * referred patient with the receiving doctor.
 */
export function QuickBookingModal({
  onClose,
  onCreated,
  onError,
  followUp,
}: {
  onClose: () => void;
  onCreated: () => void;
  onError: (m: string) => void;
  followUp?: FollowUpPreset;
}) {
  const [services, setServices] = useState<ServiceOption[] | null>(null);
  const [doctors, setDoctors] = useState<DoctorOption[] | null>(followUp ? [followUp.doctor] : null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [patientName, setPatientName] = useState("");
  const [phone, setPhone] = useState("");
  const [serviceId, setServiceId] = useState("");
  const [doctorId, setDoctorId] = useState(followUp?.doctor.id ?? "");
  const [startAt, setStartAt] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    Promise.all([
      adminApi.get<{ services: ServiceOption[] }>("/api/admin/services"),
      followUp ? Promise.resolve(null) : adminApi.get<{ doctors: DoctorOption[] }>("/api/admin/doctors"),
    ])
      .then(([s, d]) => {
        setServices(s.services);
        if (d) setDoctors(d.doctors);
      })
      .catch((e) => setLoadError(e instanceof AdminApiError ? e.message : "Ma'lumot yuklab bo‘lmadi"));
  }, [followUp]);

  const serviceDoctors = useMemo(() => {
    if (!services || !doctors) return [];
    const linked = services.find((s) => s.id === serviceId)?.doctor_services?.map((d) => d.doctor_id) ?? [];
    return linked.length > 0 ? doctors.filter((d) => linked.includes(d.id)) : doctors;
  }, [services, doctors, serviceId]);

  // A doctor with an explicit service list only performs those services.
  const followUpServices = useMemo(() => {
    if (!followUp || !services) return services;
    const offers = (s: ServiceOption) => s.doctor_services?.some((d) => d.doctor_id === followUp.doctor.id) ?? false;
    return services.some(offers) ? services.filter(offers) : services;
  }, [followUp, services]);

  const ready = followUp
    ? !!serviceId && !!startAt
    : !!serviceId && !!doctorId && !!startAt && patientName.trim().length >= 2 && phone.trim().length >= 7;

  const submit = async () => {
    if (!ready) return;
    setSubmitting(true);
    setLoadError(null);
    try {
      await adminApi.post(
        "/api/admin/appointments",
        followUp
          ? {
              patientName: followUp.patientName,
              patientId: followUp.patientId,
              doctorId: followUp.doctor.id,
              serviceId,
              startAt: new Date(startAt).toISOString(),
              source: "admin",
              referralId: followUp.referralId,
            }
          : {
              patientName: patientName.trim(),
              phone: phone.trim(),
              doctorId,
              serviceId,
              startAt: new Date(startAt).toISOString(),
              source: "walk_in",
            },
      );
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
      title={followUp ? "Yo‘llanma bo‘yicha qabul yozish" : "Tezkor qabul yozish"}
      onClose={onClose}
      footer={
        <>
          <AButton variant="ghost" size="md" onClick={onClose} disabled={submitting}>
            Bekor qilish
          </AButton>
          <AButton size="md" loading={submitting} disabled={!ready} onClick={() => void submit()}>
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
          {followUp ? (
            <div className="space-y-1 rounded-xl border border-hairline px-3 py-2 text-sm">
              <p>
                <span className="text-ink-muted">Bemor:</span> <span className="font-medium text-foreground">{followUp.patientName}</span>
              </p>
              <p>
                <span className="text-ink-muted">Shifokor:</span> <span className="font-medium text-foreground">{followUp.doctor.name}</span>
              </p>
            </div>
          ) : (
            <>
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
            </>
          )}
          <div>
            <label htmlFor="qb-service" className="mb-1 block text-xs font-medium text-ink-muted">
              Xizmat
            </label>
            <ASelect
              value={serviceId}
              onChange={(v) => {
                setServiceId(v);
                if (!followUp) setDoctorId("");
              }}
              options={options(followUpServices, [{ value: "", label: "Xizmatni tanlang" }])}
              aria-label="Xizmat"
            />
          </div>
          {!followUp && (
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
          )}
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

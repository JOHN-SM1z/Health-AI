"use client";

import { useEffect, useMemo, useState } from "react";
import { Search, X } from "lucide-react";
import { AModal, AButton, AInput, ASelect, AError, LoadingRow } from "@/components/admin/ui";
import { adminApi, AdminApiError } from "@/lib/admin/client";
import { SlotPicker, type Slot } from "@/components/admin/slot-picker";

type ServiceOption = { id: string; name: string; price: number; doctor_services: { doctor_id: string }[] | null };
type DoctorOption = { id: string; name: string };
type PatientOption = { id: string; full_name: string | null; phone: string | null; telegram_username: string | null };

/** name/phone → clinic-local, human display: falls back sensibly for a patient with no name on file yet. */
function patientLabel(p: PatientOption): string {
  return p.full_name || (p.telegram_username ? `@${p.telegram_username}` : "Noma’lum bemor");
}

/**
 * Shared walk-in/quick booking form used by every admin-workspace role that
 * can create appointments. Two things this deliberately does NOT do like a
 * bare form would: (1) it searches for an existing patient by name/phone
 * before falling back to creating a new one — the plain name+phone fields
 * this used to always submit created a fresh patient row on every booking,
 * even for a returning patient; (2) it only offers real slots from
 * /api/admin/availability (same server-computed schedule as the
 * patient-facing Mini App's /api/availability, scoped to the staff
 * session's own clinic instead of a URL param) instead of a free-typed
 * date/time — the transactional booking RPC is still the actual authority
 * either way, this just stops staff from picking a time that's guaranteed
 * to be rejected.
 */
export function QuickBookingModal({ onClose, onCreated, onError }: { onClose: () => void; onCreated: () => void; onError: (m: string) => void }) {
  const [services, setServices] = useState<ServiceOption[] | null>(null);
  const [doctors, setDoctors] = useState<DoctorOption[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [patientQuery, setPatientQuery] = useState("");
  const [patientResults, setPatientResults] = useState<PatientOption[] | null>(null);
  const [selectedPatient, setSelectedPatient] = useState<PatientOption | null>(null);
  const [newPatientName, setNewPatientName] = useState("");
  const [newPatientPhone, setNewPatientPhone] = useState("");

  const [serviceId, setServiceId] = useState("");
  const [doctorId, setDoctorId] = useState("");
  const [selectedSlot, setSelectedSlot] = useState<Slot | null>(null);

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

  useEffect(() => {
    const term = patientQuery.trim();
    if (term.length < 2 || selectedPatient) {
      setPatientResults(null);
      return;
    }
    const timer = window.setTimeout(() => {
      adminApi
        .get<{ patients: PatientOption[] }>(`/api/admin/patients?q=${encodeURIComponent(term)}`)
        .then((r) => setPatientResults(r.patients))
        .catch(() => setPatientResults([]));
    }, 300);
    return () => window.clearTimeout(timer);
  }, [patientQuery, selectedPatient]);

  const serviceDoctors = useMemo(() => {
    if (!services || !doctors) return [];
    const linked = services.find((s) => s.id === serviceId)?.doctor_services?.map((d) => d.doctor_id) ?? [];
    return linked.length > 0 ? doctors.filter((d) => linked.includes(d.id)) : doctors;
  }, [services, doctors, serviceId]);

  useEffect(() => {
    setSelectedSlot(null);
  }, [serviceId, doctorId]);

  const hasValidPatient = !!selectedPatient || (newPatientName.trim().length >= 2 && newPatientPhone.trim().length >= 7);
  const canSubmit = hasValidPatient && !!serviceId && !!doctorId && !!selectedSlot;

  const submit = async () => {
    if (!canSubmit || !selectedSlot) return;
    setSubmitting(true);
    setLoadError(null);
    try {
      await adminApi.post("/api/admin/appointments", {
        patientId: selectedPatient?.id,
        patientName: selectedPatient ? patientLabel(selectedPatient) : newPatientName.trim(),
        phone: selectedPatient ? (selectedPatient.phone ?? undefined) : newPatientPhone.trim(),
        doctorId,
        serviceId,
        startAt: selectedSlot.start,
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
      title="Yangi qabul"
      onClose={onClose}
      maxWidth="max-w-xl"
      footer={
        <>
          <AButton variant="ghost" size="md" onClick={onClose} disabled={submitting}>
            Bekor qilish
          </AButton>
          <AButton size="md" loading={submitting} disabled={!canSubmit} onClick={() => void submit()}>
            Yozish
          </AButton>
        </>
      }
    >
      {loadError && <AError message={loadError} />}
      {!services || !doctors ? (
        <LoadingRow />
      ) : (
        <div className="flex flex-col gap-4">
          <div>
            <label className="mb-1 block text-xs font-medium text-ink-muted">Bemor</label>
            {selectedPatient ? (
              <div className="flex items-center justify-between rounded-lg border border-hairline bg-sand px-3 py-2">
                <div>
                  <p className="text-sm font-medium text-foreground">{patientLabel(selectedPatient)}</p>
                  {selectedPatient.phone && <p className="text-xs text-ink-muted">{selectedPatient.phone}</p>}
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setSelectedPatient(null);
                    setPatientQuery("");
                  }}
                  className="rounded-lg p-1.5 text-ink-muted hover:bg-hairline/40"
                  aria-label="Boshqa bemor tanlash"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            ) : (
              <div className="relative">
                <div className="relative">
                  <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-muted" />
                  <AInput
                    value={patientQuery}
                    onChange={setPatientQuery}
                    placeholder="Ism yoki telefon bo‘yicha qidirish…"
                    aria-label="Bemor qidirish"
                    className="pl-9"
                  />
                </div>
                {patientResults !== null && (
                  <div className="mt-1 max-h-40 overflow-y-auto rounded-lg border border-hairline bg-surface shadow-[var(--shadow-pop)]">
                    {patientResults.length === 0 ? (
                      <p className="px-3 py-2 text-xs text-ink-muted">Topilmadi — pastda yangi bemor sifatida kiriting</p>
                    ) : (
                      patientResults.map((p) => (
                        <button
                          key={p.id}
                          type="button"
                          onClick={() => {
                            setSelectedPatient(p);
                            setPatientResults(null);
                          }}
                          className="flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-sand"
                        >
                          <span className="font-medium text-foreground">{patientLabel(p)}</span>
                          <span className="text-xs text-ink-muted">{p.phone ?? "—"}</span>
                        </button>
                      ))
                    )}
                  </div>
                )}
              </div>
            )}
          </div>

          {!selectedPatient && (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label htmlFor="qb-name" className="mb-1 block text-xs font-medium text-ink-muted">
                  Yangi bemor ismi
                </label>
                <AInput value={newPatientName} onChange={setNewPatientName} placeholder="Ism familiya" aria-label="Bemor ismi" />
              </div>
              <div>
                <label htmlFor="qb-phone" className="mb-1 block text-xs font-medium text-ink-muted">
                  Telefon
                </label>
                <AInput value={newPatientPhone} onChange={setNewPatientPhone} placeholder="+998 90 123 45 67" type="tel" aria-label="Telefon" />
              </div>
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
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
              <ASelect value={doctorId} onChange={setDoctorId} options={options(serviceDoctors, [{ value: "", label: "Shifokorni tanlang" }])} aria-label="Shifokor" />
            </div>
          </div>

          {serviceId && doctorId && (
            <div>
              <label className="mb-1 block text-xs font-medium text-ink-muted">Vaqt</label>
              <SlotPicker serviceId={serviceId} doctorId={doctorId} selectedSlot={selectedSlot} onSelect={setSelectedSlot} />
            </div>
          )}
        </div>
      )}
    </AModal>
  );
}

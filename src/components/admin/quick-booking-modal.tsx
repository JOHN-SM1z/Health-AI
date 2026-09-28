"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { AButton, AError, AInput, AModal, ASelect, LoadingRow } from "@/components/admin/ui";
import { adminApi, AdminApiError } from "@/lib/admin/client";
import { newIdempotencyKey } from "@/lib/idempotency-key";

type ServiceOption = { id: string; name: string; price: number; doctor_services: { doctor_id: string }[] | null };
type DoctorOption = { id: string; name: string };
/** An existing patient of the clinic: a returning patient keeps one record and one history. */
type PatientOption = { id: string; fullName: string | null; phone: string | null };

/** Booking the follow-up of an accepted referral: patient and doctor are fixed. */
export type FollowUpPreset = {
  referralId: string;
  patientId: string;
  patientName: string;
  doctor: DoctorOption;
};

/**
 * Staff booking through the transactional booking engine
 * (POST /api/admin/appointments) — the same booking operation online patients
 * use, so a slot a patient took first is refused here too. Without a preset
 * it records a walk-in: reception first looks the patient up, and a
 * returning patient is picked — never registered again (a new patient whose
 * phone matches an existing one needs an explicit "different person"). With
 * `followUp` it books a referral's follow-up for the referred patient with
 * the receiving doctor.
 * The chosen date and time are the clinic's wall-clock time (converted on the
 * server in the clinic's timezone, never the browser's).
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
  const [search, setSearch] = useState("");
  const [found, setFound] = useState<PatientOption[] | null>(null);
  const [existing, setExisting] = useState<PatientOption | null>(null);
  const [duplicates, setDuplicates] = useState<PatientOption[] | null>(null);
  const [confirmedNew, setConfirmedNew] = useState(false);
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

  // Find a returning patient by name or phone (any way the phone is typed).
  useEffect(() => {
    if (followUp || existing) return;
    const q = search.trim();
    if (q.length < 3) {
      setFound(null);
      return;
    }
    let live = true;
    const timer = setTimeout(() => {
      adminApi
        .get<{ patients: Array<{ id: string; full_name: string | null; phone: string | null }> }>(
          `/api/admin/patients?q=${encodeURIComponent(q)}`,
        )
        .then((r) => live && setFound(r.patients.slice(0, 5).map((p) => ({ id: p.id, fullName: p.full_name, phone: p.phone }))))
        .catch(() => live && setFound([]));
    }, 300);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [search, followUp, existing]);

  const pick = (p: PatientOption) => {
    setExisting(p);
    setDuplicates(null);
    setLoadError(null);
  };

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
    : !!serviceId && !!doctorId && !!startAt && (!!existing || (patientName.trim().length >= 2 && phone.trim().length >= 7));

  // One idempotency key per booking attempt: a double click or a retried
  // request returns the appointment the first one created. Changing anything
  // in the form makes it a new attempt.
  const attempt = useRef<{ id: string; key: string } | null>(null);

  const submit = async () => {
    if (!ready) return;
    setSubmitting(true);
    setLoadError(null);
    const attemptId = [followUp?.referralId, existing?.id, patientName.trim(), phone.trim(), doctorId, serviceId, startAt, confirmedNew].join("|");
    if (attempt.current?.id !== attemptId) attempt.current = { id: attemptId, key: newIdempotencyKey() };
    try {
      await adminApi.post(
        "/api/admin/appointments",
        followUp
          ? {
              patientName: followUp.patientName,
              patientId: followUp.patientId,
              doctorId: followUp.doctor.id,
              serviceId,
              startLocal: startAt,
              source: "admin",
              referralId: followUp.referralId,
              idempotencyKey: attempt.current.key,
            }
          : existing
            ? {
                patientName: existing.fullName ?? patientName.trim(),
                patientId: existing.id,
                doctorId,
                serviceId,
                startLocal: startAt,
                source: "walk_in",
                idempotencyKey: attempt.current.key,
              }
            : {
                patientName: patientName.trim(),
                phone: phone.trim(),
                doctorId,
                serviceId,
                startLocal: startAt,
                source: "walk_in",
                idempotencyKey: attempt.current.key,
                ...(confirmedNew ? { confirmNewPatient: true } : {}),
              },
      );
      onCreated();
    } catch (e) {
      // The phone belongs to a patient already registered: pick them (their
      // history is on that record), or confirm this is someone else.
      if (e instanceof AdminApiError && e.code === "possible_duplicate") {
        setDuplicates((e.details?.candidates as PatientOption[] | undefined) ?? []);
        setLoadError(e.message);
        setSubmitting(false);
        return;
      }
      // Shown in the modal: the receptionist picks another time right here.
      // SLOT_UNAVAILABLE cannot be overridden — the booking engine decided.
      const message =
        e instanceof AdminApiError
          ? e.code === "SLOT_UNAVAILABLE"
            ? "Bu vaqt endi bo‘sh emas. Iltimos, boshqa vaqtni tanlang."
            : e.message
          : "Yozishda xatolik";
      setLoadError(message);
      if (!(e instanceof AdminApiError)) onError(message);
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
          ) : existing ? (
            <div className="flex items-center justify-between gap-2 rounded-xl border border-pine/30 bg-pine-tint/40 px-3 py-2 text-sm">
              <p>
                <span className="text-ink-muted">Bemor:</span>{" "}
                <span className="font-medium text-foreground">{existing.fullName ?? "—"}</span>
                {existing.phone && <span className="text-ink-muted"> · {existing.phone}</span>}
              </p>
              <button type="button" className="text-xs font-medium text-pine hover:underline" onClick={() => setExisting(null)}>
                O‘zgartirish
              </button>
            </div>
          ) : (
            <>
              <div>
                <label htmlFor="qb-search" className="mb-1 block text-xs font-medium text-ink-muted">
                  Bemorni qidirish (ism yoki telefon)
                </label>
                <AInput value={search} onChange={setSearch} placeholder="Avval ro‘yxatdan o‘tganmi?" aria-label="Bemorni qidirish" />
                {found && found.length > 0 && (
                  <ul className="mt-1 divide-y divide-hairline rounded-lg border border-hairline" aria-label="Topilgan bemorlar">
                    {found.map((p) => (
                      <li key={p.id} className="flex items-center justify-between gap-2 px-3 py-1.5 text-sm">
                        <span>
                          {p.fullName ?? "—"}
                          {p.phone && <span className="text-ink-muted"> · {p.phone}</span>}
                        </span>
                        <button type="button" className="text-xs font-medium text-pine hover:underline" onClick={() => pick(p)}>
                          Tanlash
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                {found && found.length === 0 && <p className="mt-1 text-xs text-ink-muted">Topilmadi — yangi bemor sifatida kiriting.</p>}
              </div>
              {duplicates && (
                <div className="rounded-xl border border-clay/40 bg-clay-tint/40 px-3 py-2 text-sm" aria-label="Bir xil telefonli bemorlar">
                  <p className="font-medium text-foreground">Bu telefon raqami bilan ro‘yxatdan o‘tgan bemor(lar):</p>
                  <ul className="mt-1 flex flex-col gap-1">
                    {duplicates.map((p) => (
                      <li key={p.id} className="flex items-center justify-between gap-2">
                        <span>
                          {p.fullName ?? "—"}
                          {p.phone && <span className="text-ink-muted"> · {p.phone}</span>}
                        </span>
                        <button type="button" className="text-xs font-medium text-pine hover:underline" onClick={() => pick(p)}>
                          Shu bemor
                        </button>
                      </li>
                    ))}
                  </ul>
                  <button
                    type="button"
                    className="mt-2 text-xs font-medium text-clay-deep hover:underline"
                    onClick={() => {
                      setConfirmedNew(true);
                      setDuplicates(null);
                      setLoadError(null);
                    }}
                  >
                    Yo‘q, bu boshqa odam — yangi bemor sifatida yozish
                  </button>
                </div>
              )}
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

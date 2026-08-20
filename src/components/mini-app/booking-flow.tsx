"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { CalendarDays, Stethoscope, UserRound } from "lucide-react";
import { useTelegramInitData } from "@/components/mini-app/telegram-provider";
import { Button, Card, Input, Badge, Spinner, EmptyState, ErrorBanner, NoticeBanner, SectionTitle, cn } from "@/components/mini-app/ui";
import { apiGet, apiPost } from "@/lib/client/api";

type Catalog = {
  clinic: {
    id: string;
    name: string;
    timezone: string;
    currency: string;
    phone: string | null;
    address: string | null;
  };
  services: Array<{
    id: string;
    name: string;
    description: string | null;
    price: number;
    duration_minutes: number;
    preparation_text: string | null;
    specialty_id: string | null;
    doctors: string[];
  }>;
  doctors: Array<{ id: string; name: string; title: string | null; specialtyId: string | null }>;
  specialties: Array<{ id: string; name: string }>;
};

type Slot = { start: string; end: string; startLocal: string; dayLocal: string; doctorId: string; doctorName: string };
type SlotResponse = { timezone: string; slots: Slot[] };

type AppointmentResponse = {
  appointment: {
    id: string;
    start_at: string;
    status: string;
    doctors: { name: string } | null;
    services: { name: string; price: number } | null;
  } | null;
  payment: {
    status: string;
    amount: number;
    currency: string;
    provider: string;
    paymentUrl: string | null;
    manualConfirmationRequired: boolean;
  };
};

type Step =
  | { name: "consent" }
  | { name: "choose" }
  | { name: "service"; mode: "known" | "help"; specialtyId: string | null }
  | { name: "doctor" }
  | { name: "slot" }
  | { name: "details" }
  | { name: "review" }
  | { name: "result" };

export function BookingFlow() {
  const router = useRouter();
  const initData = useTelegramInitData();
  const devMode = process.env.NEXT_PUBLIC_TELEGRAM_DEV_MODE === "true";

  const identity = useMemo(() => initData ?? (devMode ? "dev" : null), [initData, devMode]);

  // Attribution: Telegram marks a bot-chat deep link launch with
  // tgWebAppStartParam (hash) / startapp (search). The bot menu web_app
  // button has no such marker, so the two entry points are distinguishable
  // here and the booking is attributed to telegram_chat vs telegram_mini_app.
  const chatDeepLink = useMemo(() => {
    if (typeof window === "undefined") return false;
    const hash = new URLSearchParams(window.location.hash.replace(/^#/, ""));
    const search = new URLSearchParams(window.location.search);
    return Boolean(hash.get("tgWebAppStartParam")) || search.has("startapp");
  }, []);

  const paymentMode = process.env.NEXT_PUBLIC_PAYMENT_PROVIDER ?? "manual";

  const [step, setStep] = useState<Step>({ name: "consent" });
  const [consentChecked, setConsentChecked] = useState(false);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [slots, setSlots] = useState<Slot[]>([]);
  const [loadingSlots, setLoadingSlots] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [serviceId, setServiceId] = useState<string | null>(null);
  const [doctorId, setDoctorId] = useState<string | null>(null);
  const [selectedSlot, setSelectedSlot] = useState<Slot | null>(null);
  const [patientName, setPatientName] = useState("");
  const [phone, setPhone] = useState("");
  const [notes, setNotes] = useState("");
  const [bookingResult, setBookingResult] = useState<{ ok: boolean; message: string; appointmentId?: string; paymentUrl?: string } | null>(null);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    // Catalog is public read-only clinic data. Load it immediately so the user
    // can choose services and doctor whether opened inside or outside Telegram.
    setError(null);
    apiGet<Catalog>("/api/catalog", identity).then((res) => {
      if (res.ok) setCatalog(res.data);
      else setError(res.error);
    });
  }, [identity]);

  const selectedService = useMemo(
    () => catalog?.services.find((s) => s.id === serviceId) ?? null,
    [catalog, serviceId],
  );

  const serviceDoctors = useMemo(() => {
    if (!catalog || !selectedService) return [];
    return catalog.doctors.filter((d) => selectedService.doctors.includes(d.id));
  }, [catalog, selectedService]);

  const groupSlotsByDay = useMemo(() => {
    const groups = new Map<string, Slot[]>();
    for (const s of slots) {
      const list = groups.get(s.dayLocal) ?? [];
      list.push(s);
      groups.set(s.dayLocal, list);
    }
    return [...groups.entries()];
  }, [slots]);

  const loadSlots = useCallback(
    async (sid: string, did: string) => {
      setLoadingSlots(true);
      setError(null);
      const params = new URLSearchParams({ serviceId: sid, doctorId: did, days: "14" });
      const res = await fetch(`/api/availability?${params}`);
      const json = (await res.json()) as { ok?: boolean; data?: SlotResponse; error?: string };
      if (res.ok && json.ok && json.data) {
        setSlots(json.data.slots);
      } else {
        setError(json.error ?? "Vaqtlarni yuklab bo‘lmadi");
        setSlots([]);
      }
      setLoadingSlots(false);
    },
    [],
  );

  const selectedDoctor = catalog?.doctors.find((d) => d.id === doctorId) ?? null;

  const startBooking = () => {
    if (!serviceId || !doctorId) return;
    void loadSlots(serviceId, doctorId);
    setStep({ name: "slot" });
  };

  const confirmBooking = async () => {
    if (!serviceId || !doctorId || !selectedSlot) return;
    setCreating(true);
    setError(null);
    const res = await apiPost<AppointmentResponse>(
      "/api/bookings",
      {
        doctorId,
        serviceId,
        startAt: selectedSlot.start,
        patientName,
        phone,
        consent: true,
        notes: notes.trim() || undefined,
        source: chatDeepLink ? "telegram_chat" : "telegram_mini_app",
      },
      identity,
    );

    if (res.ok) {
      trackEvent("booking_success");
      const id = res.data.appointment?.id;
      const paymentUrl = res.data.payment?.paymentUrl ?? undefined;
      // Persist the server-confirmed appointment in this tab so the
      // confirmation page can render it even without a Telegram identity
      // (walk-in bookings outside the Mini App have no initData to verify).
      if (id && typeof window !== "undefined") {
        try {
          sessionStorage.setItem(
            `booking:${id}`,
            JSON.stringify({ appointment: res.data.appointment, paymentUrl }),
          );
        } catch {
          // sessionStorage unavailable — confirmation falls back to a message.
        }
      }
      setBookingResult({
        ok: true,
        message: "Qabul muvaffaqiyatli yaratildi!",
        appointmentId: id,
        paymentUrl,
      });
      setStep({ name: "result" });
    } else if (res.code === "slot_taken") {
      setBookingResult({
        ok: false,
        message: "Bu vaqt boshqa bemor tomonidan band qilingan. Iltimos, boshqa vaqtni tanlang.",
      });
      setStep({ name: "result" });
    } else {
      setError(res.error);
      setCreating(false);
    }
  };

  const trackEvent = (eventType: string) => {
    if (!identity) return; // no verified Telegram identity — the server would reject anyway
    void fetch("/api/track", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ eventType, initData: identity }),
    }).catch(() => {});
  };

  // ---------------------------------------------------------------- render

  if (error && !catalog) {
    return (
      <div className="mt-8">
        <ErrorBanner message={error} />
        <Button variant="outline" size="full" onClick={() => router.push("/")}>
          Orqaga
        </Button>
      </div>
    );
  }

  if (!catalog) return <Spinner label="Klinika ma‘lumotlari yuklanmoqda..." />;

  const fmt = (n: number) => new Intl.NumberFormat("uz-UZ").format(n);

  return (
    <div className="flex flex-col gap-4">
      <StepHeader step={step.name} />

      {step.name === "consent" && (
        <div className="flex flex-col gap-4">
          <Card>
            <SectionTitle>Xizmatimiz haqida</SectionTitle>
            <p className="text-sm leading-relaxed text-[var(--tg-hint,#475569)]">
              Bu ilova klinika ma‘lumotlari (xizmatlar, narxlar, ish vaqti) va qabulga yozilish uchun
              mo‘ljallangan. Ilova <strong>tibbiy tashxis qo‘ymaydi</strong> va davolash tavsiya
              bermaydi.
            </p>
          </Card>
          <Card>
            <SectionTitle>Shaxsiy ma‘lumotlar</SectionTitle>
            <p className="text-sm leading-relaxed text-[var(--tg-hint,#475569)]">
              Ismingiz va telefon raqamingiz faqat qabul jarayonini tashkil qilish uchun ishlatiladi.
              Ma‘lumotlaringiz uchinchi shaxslarga berilmaydi. Batafsil:{" "}
              <a className="underline" href="/privacy">
                Maxfiylik siyosati
              </a>
            </p>
            <label className="mt-3 flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                checked={consentChecked}
                onChange={(e) => setConsentChecked(e.target.checked)}
                className="mt-0.5 h-4 w-4 accent-[var(--tg-button,var(--pine))]"
              />
              <span className="text-[var(--tg-text,var(--foreground))]">
                Shaxsiy ma‘lumotlarimni qabul tashkil qilish uchun ishlatishga roziman
              </span>
            </label>
          </Card>
          <Button size="full" disabled={!consentChecked} onClick={() => setStep({ name: "choose" })}>
            Davom etish
          </Button>
        </div>
      )}

      {step.name === "choose" && (
        <div className="flex flex-col gap-3">
          <SectionTitle>Qanday yozilmoqchisiz?</SectionTitle>
          <Button
            variant="secondary"
            size="lg"
            onClick={() => {
              trackEvent("booking_started");
              setStep({ name: "service", mode: "known", specialtyId: null });
            }}
          >
            🩺 Kerakli xizmatni bilaman
          </Button>
          <Button
            variant="secondary"
            size="lg"
            onClick={() => {
              trackEvent("booking_started");
              setStep({ name: "service", mode: "help", specialtyId: null });
            }}
          >
            🤔 Tanlashda yordam kerak
          </Button>
          <p className="text-xs text-[var(--tg-hint,#8a9699)]">
            Tanlashda yordam yo‘nalishni aniqlashga yordam beradi — tashxis qo‘ymaydi.
          </p>
        </div>
      )}

      {step.name === "service" && (
        <div className="flex flex-col gap-3">
          <SectionTitle>{step.mode === "known" ? "Xizmatni tanlang" : "Yo‘nalishni tanlang"}</SectionTitle>
          {step.mode === "help" && (
            <>
              <Button
                variant="secondary"
                size="md"
                onClick={() => setStep({ name: "service", mode: "help", specialtyId: null })}
                className={cn(!step.specialtyId && "ring-2 ring-[var(--tg-button,var(--pine))]")}
              >
                Barcha xizmatlar
              </Button>
              {catalog.specialties.map((sp) => (
                <Button
                  key={sp.id}
                  variant="secondary"
                  size="md"
                  onClick={() => setStep({ name: "service", mode: "help", specialtyId: sp.id })}
                  className={cn(step.specialtyId === sp.id && "ring-2 ring-[var(--tg-button,var(--pine))]")}
                >
                  {sp.name}
                </Button>
              ))}
              <p className="text-xs text-[var(--tg-hint,#8a9699)]">
                Yo‘nalishingizni bilmasangiz, botdagi “Shifokor tanlashda yordam” xizmatidan foydalaning.
              </p>
            </>
          )}
          <div className="flex flex-col gap-2">
            {catalog.services
              .filter((s) => (step.mode === "help" && step.specialtyId ? s.specialty_id === step.specialtyId : true))
              .map((s) => (
                <button
                  key={s.id}
                  onClick={() => {
                    setServiceId(s.id);
                    setDoctorId(null);
                    setSelectedSlot(null);
                    setStep({ name: "doctor" });
                  }}
                  className={cn(
                    "rounded-xl border p-3 text-left transition-colors",
                    serviceId === s.id
                      ? "border-[var(--tg-button,var(--pine))] bg-[var(--tg-secondary-bg,#f1f5f9)]"
                      : "border-[var(--tg-secondary-bg,#e2e8f0)] bg-[var(--tg-secondary-bg,#ffffff)]",
                  )}
                >
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium text-[var(--tg-text,var(--foreground))]">{s.name}</span>
                    <Badge tone="blue">{fmt(s.price)} {catalog.clinic.currency}</Badge>
                  </div>
                  <p className="mt-1 text-xs text-[var(--tg-hint,#8a9699)]">
                    {s.duration_minutes} daqiqa
                    {s.description ? ` — ${s.description}` : ""}
                  </p>
                </button>
              ))}
            {catalog.services.length === 0 && (
              <EmptyState title="Xizmatlar hozircha kiritilmagan" icon={<Stethoscope className="h-6 w-6" />} />
            )}
          </div>
        </div>
      )}

      {step.name === "doctor" && selectedService && (
        <div className="flex flex-col gap-3">
          <SectionTitle>Shifokorni tanlang</SectionTitle>
          {serviceDoctors.length === 0 && (
            <EmptyState title="Bu xizmat uchun shifokor hozircha yo‘q" icon={<UserRound className="h-6 w-6" />} />
          )}
          {serviceDoctors.map((d) => (
            <button
              key={d.id}
              onClick={() => {
                setDoctorId(d.id);
                startBooking();
              }}
              className={cn(
                "rounded-xl border p-3 text-left transition-colors",
                doctorId === d.id
                  ? "border-[var(--tg-button,var(--pine))] bg-[var(--tg-secondary-bg,#f1f5f9)]"
                  : "border-[var(--tg-secondary-bg,#e2e8f0)] bg-[var(--tg-secondary-bg,#ffffff)]",
              )}
            >
              <p className="text-sm font-medium text-[var(--tg-text,var(--foreground))]">{d.name}</p>
              {d.title && <p className="mt-0.5 text-xs text-[var(--tg-hint,#8a9699)]">{d.title}</p>}
            </button>
          ))}
        </div>
      )}

      {step.name === "slot" && (
        <div className="flex flex-col gap-3">
          <SectionTitle>Vaqtni tanlang</SectionTitle>
          {selectedDoctor && (
            <p className="text-sm text-[var(--tg-hint,#475569)]">
              {selectedDoctor.name} — {selectedService?.name}
            </p>
          )}
          {loadingSlots ? (
            <Spinner label="Bo‘sh vaqtlar yuklanmoqda..." />
          ) : slots.length === 0 ? (
            <EmptyState
              title="14 kun ichida bo‘sh vaqt yo‘q"
              subtitle="Iltimos, operatorlarga murojaat qiling"
              icon={<CalendarDays className="h-6 w-6" />}
            />
          ) : (
            <div className="flex flex-col gap-4">
              {groupSlotsByDay.map(([day, daySlots]) => (
                <div key={day}>
                  <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-[var(--tg-hint,#8a9699)]">
                    {new Date(`${day}T00:00:00`).toLocaleDateString("uz-UZ", { weekday: "long", day: "numeric", month: "long" })}
                  </p>
                  <div className="grid grid-cols-3 gap-2">
                    {daySlots.map((s) => (
                      <button
                        key={s.start}
                        onClick={() => setSelectedSlot(s)}
                        className={cn(
                          "rounded-lg border py-2 text-sm transition-colors",
                          selectedSlot?.start === s.start
                            ? "border-[var(--tg-button,var(--pine))] bg-[var(--tg-button,var(--pine))] text-[var(--tg-button-text,#fff)]"
                            : "border-[var(--tg-secondary-bg,#cbd5e1)] bg-[var(--tg-secondary-bg,#ffffff)] text-[var(--tg-text,var(--foreground))]",
                        )}
                      >
                        {s.startLocal}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
              <Button
                size="full"
                disabled={!selectedSlot}
                onClick={() => setStep({ name: "details" })}
              >
                Davom etish: {selectedSlot ? selectedSlot.startLocal : ""}
              </Button>
            </div>
          )}
        </div>
      )}

      {step.name === "details" && (
        <div className="flex flex-col gap-3">
          <SectionTitle>Ma‘lumotlaringiz</SectionTitle>
          <Card className="flex flex-col gap-3">
            <div>
              <label htmlFor="patient-name" className="mb-1 block text-xs font-medium text-[var(--tg-hint,#8a9699)]">
                Ism va familiya
              </label>
              <Input
                id="patient-name"
                value={patientName}
                onChange={setPatientName}
                placeholder="Masalan: Karimov Ali"
                autoComplete="name"
              />
            </div>
            <div>
              <label htmlFor="patient-phone" className="mb-1 block text-xs font-medium text-[var(--tg-hint,#8a9699)]">
                Telefon raqam
              </label>
              <Input
                id="patient-phone"
                value={phone}
                onChange={setPhone}
                placeholder="+998 90 123 45 67"
                type="tel"
                inputMode="tel"
                autoComplete="tel"
              />
            </div>
            <div>
              <label htmlFor="patient-notes" className="mb-1 block text-xs font-medium text-[var(--tg-hint,#8a9699)]">
                Qabul sababi (ixtiyoriy)
              </label>
              <textarea
                id="patient-notes"
                value={notes}
                onChange={(e) => setNotes(e.target.value.slice(0, 300))}
                placeholder="Masalan: bosh og‘rig‘i, ko‘rik..."
                rows={3}
                className="w-full resize-none rounded-xl border border-[var(--tg-hint,#cbd5e1)] bg-white p-3 text-sm outline-none focus:border-[var(--tg-button,var(--pine))]"
              />
              <p className="mt-1 text-right text-[11px] text-[var(--tg-hint,#8a9699)]">{notes.length}/300</p>
            </div>
          </Card>
          <Button
            size="full"
            disabled={patientName.trim().length < 2 || phone.trim().length < 7}
            onClick={() => setStep({ name: "review" })}
          >
            Davom etish
          </Button>
        </div>
      )}

      {step.name === "review" && selectedService && selectedSlot && (
        <div className="flex flex-col gap-3">
          <SectionTitle>Qabulni tasdiqlang</SectionTitle>
          <Card className="flex flex-col gap-2 text-sm">
            <Row label="Shifokor" value={selectedDoctor?.name ?? "-"} />
            <Row label="Xizmat" value={selectedService.name} />
            <Row label="Sana" value={new Date(`${selectedSlot.dayLocal}T00:00:00`).toLocaleDateString("uz-UZ", { day: "numeric", month: "long" })} />
            <Row label="Vaqt" value={selectedSlot.startLocal} />
            <Row label="Bemor" value={patientName} />
            <Row label="Telefon" value={phone} />
            <Row label="Narx" value={`${fmt(selectedService.price)} ${catalog.clinic.currency}`} />
            <Row label="To‘lov" value={paymentMode === "manual" ? "Qabulxonada (naqd yoki karta)" : "Online to‘lov (Click / Payme / Uzum)"} />
            {notes.trim() && <Row label="Sabab" value={notes.trim()} />}
          </Card>
          <NoticeBanner message={paymentMode === "manual" ? "To‘lov klinikada qabul vaqtida amalga oshiriladi." : "To‘lov onlayn amalga oshiriladi — to‘lov sahifasi qabul tasdiqlangach ochiladi."} />
          {error && <ErrorBanner message={error} />}
          <Button size="full" loading={creating} onClick={confirmBooking}>
            Tasdiqlash va yozilish
          </Button>
          <Button variant="ghost" size="md" onClick={() => setStep({ name: "slot" })} disabled={creating}>
            Orqaga
          </Button>
        </div>
      )}

      {step.name === "result" && (
        <ResultView
          ok={bookingResult?.ok ?? false}
          message={bookingResult?.message ?? ""}
          appointmentId={bookingResult?.appointmentId}
          paymentUrl={bookingResult?.paymentUrl}
          onRetry={bookingResult?.ok ? undefined : () => setStep({ name: "slot" })}
          onDone={() => {
            if (bookingResult?.appointmentId) {
              router.push(`/booking/confirmation?id=${bookingResult.appointmentId}`);
            } else {
              router.push("/");
            }
          }}
        />
      )}
    </div>
  );
}

function StepHeader({ step }: { step: string }) {
  const labels: Record<string, string> = {
    consent: "1/7 · Rozilik",
    choose: "2/7 · Tanlov",
    service: "3/7 · Xizmat",
    doctor: "4/7 · Shifokor",
    slot: "5/7 · Vaqt",
    details: "6/7 · Ma‘lumotlar",
    review: "Tasdiqlash",
    result: "Natija",
  };
  return <p className="font-numeric text-[11px] font-medium uppercase tracking-[0.14em] text-[var(--tg-hint,#8a9699)]">{labels[step] ?? step}</p>;
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-[var(--tg-hint,#8a9699)]">{label}</span>
      <span className="text-right font-medium text-[var(--tg-text,var(--foreground))]">{value}</span>
    </div>
  );
}

function ResultView({
  ok,
  message,
  appointmentId,
  paymentUrl,
  onRetry,
  onDone,
}: {
  ok: boolean;
  message: string;
  appointmentId?: string;
  paymentUrl?: string;
  onRetry?: () => void;
  onDone: () => void;
}) {
  return (
    <div className="flex flex-col gap-4">
      <Card className="text-center">
        <div className={cn("mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-full text-2xl", ok ? "bg-pine-tint" : "bg-clay-tint")}>
          {ok ? "✅" : "⚠️"}
        </div>
        <p className="font-medium text-[var(--tg-text,var(--foreground))]">{message}</p>
        {ok && appointmentId && (
          <p className="mt-2 text-xs text-[var(--tg-hint,#8a9699)]">Tasdiqlash: #{appointmentId.slice(0, 8)}</p>
        )}
      </Card>
      {!ok && onRetry && (
        <Button size="full" onClick={onRetry}>
          Boshqa vaqtni tanlash
        </Button>
      )}
      {ok && paymentUrl && (
        <a href={paymentUrl} target="_blank" rel="noopener noreferrer" className="block w-full">
          <Button size="full">To‘lov qilish (Click)</Button>
        </a>
      )}
      <Button variant={ok ? "primary" : "outline"} size="full" onClick={onDone}>
        {ok ? "Tasdiqlash sahifasi" : "Bosh sahifa"}
      </Button>
    </div>
  );
}
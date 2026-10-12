"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { PageHeader, Card, ABadge, ATable, AEmpty, AError, AButton, StatCard, LoadingRow } from "@/components/admin/ui";
import { CalendarDays, UserPlus, Users, Wallet, FlaskConical, MessagesSquare, ArrowRight } from "lucide-react";
import { STATUS_LABELS, STATUS_TONES, SOURCE_LABELS, formatTime, formatPrice, adminApi, AdminApiError } from "@/lib/admin/client";
import { freshnessLabel, money, useLive } from "@/components/operations/use-live";
import { QuickBookingModal } from "@/components/admin/quick-booking-modal";
import { OnboardingChecklist } from "@/components/admin/onboarding-checklist";
import { uzDayLabel } from "@/lib/time/local";
import type { TodayDashboard } from "@/lib/dashboard/today";

const STATUS_KEYS = ["pending", "confirmed", "checked_in", "in_progress", "completed", "cancelled", "no_show"] as const;
const n = (v: number | null | undefined) => (v ?? 0).toLocaleString("uz-UZ");
const waitLabel = (m: number | null) => (m === null ? "—" : m < 60 ? `${m} daq` : `${Math.floor(m / 60)} soat ${m % 60} daq`);

/**
 * The staff home ("Bugun"): one request to /api/admin/dashboard, refreshed every
 * 30 seconds while the tab is visible. What each role sees is decided by the
 * server — money only for owner and admin, laboratory work only for roles that
 * see the laboratory queue.
 */
export default function TodayPage() {
  const live = useLive<TodayDashboard>("/api/admin/dashboard", 30_000);
  const d = live.data;
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [todayLabel, setTodayLabel] = useState("");

  useEffect(() => {
    setTodayLabel(uzDayLabel());
  }, []);

  const setStatus = async (id: string, status: string) => {
    setBusyId(id);
    try {
      await adminApi.patch(`/api/admin/appointments/${id}`, { action: "status", status });
      setActionError(null);
      await live.reload();
    } catch (e) {
      setActionError(e instanceof AdminApiError ? e.message : "Xatolik yuz berdi");
    } finally {
      setBusyId(null);
    }
  };

  const urgent = d?.urgent_conversations ?? 0;
  const queueBusy = d ? d.queue.awaitingPayment + d.queue.waiting + d.queue.called + d.queue.inProgress : 0;

  return (
    <div>
      <PageHeader
        title="Bugun"
        subtitle={[todayLabel, freshnessLabel(live.updatedAt, live.stale)].filter(Boolean).join(" · ")}
        action={
          <AButton size="md" onClick={() => setModalOpen(true)}>
            <UserPlus className="mr-1.5 h-4 w-4" />
            Tezkor yozish
          </AButton>
        }
      />

      {live.error && !d && <AError message={live.error} />}
      {actionError && <AError message={actionError} />}

      <OnboardingChecklist />

      {/* Live walk-in queue: what is happening in the clinic right now. */}
      <Section
        icon={<Users className="h-4 w-4" />}
        title="Jonli navbat"
        link={{ href: "/admin/reception", label: "Qabulxona" }}
      >
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <StatCard label="Kassada kutmoqda" value={n(d?.queue.awaitingPayment)} tone={(d?.queue.awaitingPayment ?? 0) > 0 ? "clay" : "neutral"} />
          <StatCard label="Navbatda" value={n(d?.queue.waiting)} tone="info" />
          <StatCard label="Qabulda" value={n((d?.queue.called ?? 0) + (d?.queue.inProgress ?? 0))} tone="pine" />
          <StatCard label="Bugun yakunlandi" value={n(d?.queue.completedToday)} tone="neutral" />
        </div>
        {d && d.queue.byQueue.length > 0 && (
          <ul className="mt-3 divide-y divide-hairline/70 rounded-2xl border border-hairline bg-surface">
            {d.queue.byQueue.map((q) => (
              <li key={q.key} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 text-sm">
                <span className="font-medium text-foreground">{q.name}</span>
                <span className="flex flex-wrap items-center gap-2 text-xs text-ink-muted">
                  <ABadge tone="blue">Navbatda {q.waiting}</ABadge>
                  {q.called + q.inProgress > 0 && <ABadge tone="green">Qabulda {q.called + q.inProgress}</ABadge>}
                  <span className="font-numeric">Eng uzoq kutish: {waitLabel(q.longestWaitMinutes)}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
        {d && queueBusy === 0 && <p className="mt-2 text-xs text-ink-muted">Hozir navbatda hech kim yo‘q.</p>}
      </Section>

      {/* Owner and admin: money actually received today (the server sends nothing to other roles). */}
      {d?.money && (
        <Section
          icon={<Wallet className="h-4 w-4" />}
          title="Bugungi tushum"
          link={{ href: "/admin/finance", label: "Moliya" }}
        >
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <StatCard label="Jami tushum" value={money(d.money.total)} tone="pine" />
            <StatCard label="Qarzdorlik (ochiq tashriflar)" value={money(d.money.outstanding)} tone={d.money.outstanding > 0 ? "clay" : "neutral"} />
            <StatCard label="Qaytarilgan" value={money(d.money.kassa.refunded)} tone={d.money.kassa.refunded > 0 ? "clay" : "neutral"} />
          </div>
          <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-2 rounded-2xl border border-hairline bg-surface px-4 py-3 text-sm sm:grid-cols-5">
            {[
              ["Naqd", d.money.kassa.cash],
              ["Terminal", d.money.kassa.terminal],
              ["Onlayn", d.money.kassa.online],
              ["Laboratoriya kassasi", d.money.lab],
              ["Qabul to‘lovlari", d.money.appointments],
            ].map(([label, value]) => (
              <div key={label as string}>
                <dt className="text-xs text-ink-muted">{label}</dt>
                <dd className="font-numeric font-semibold text-foreground">{money(value as number)}</dd>
              </div>
            ))}
          </dl>
          <p className="mt-2 text-xs text-ink-muted">
            Faqat haqiqatda qabul qilingan pul: kassa, laboratoriya kassasi va kassadan tashqari to‘langan qabullar. Har bir to‘lov bir marta hisoblanadi.
          </p>
        </Section>
      )}

      {/* Laboratory work by stage (status counts only). */}
      {d?.lab && (
        <Section
          icon={<FlaskConical className="h-4 w-4" />}
          title="Laboratoriya"
          link={{ href: "/admin/lab-queue", label: "Namunalar" }}
        >
          <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
            <StatCard label="Namuna olinishi kerak" value={n(d.lab.awaitingCollection)} tone={d.lab.awaitingCollection > 0 ? "info" : "neutral"} />
            <StatCard label="Laboratoriyada" value={n(d.lab.inLab)} tone="neutral" />
            <StatCard label="Tasdiqlash kutmoqda" value={n(d.lab.awaitingVerification)} tone={d.lab.awaitingVerification > 0 ? "info" : "neutral"} />
            <StatCard label="Muddati o‘tgan" value={n(d.lab.overdue)} tone={d.lab.overdue > 0 ? "clay" : "neutral"} />
            <StatCard label="Bugun tayyor" value={n(d.lab.completedToday)} tone="pine" />
          </div>
        </Section>
      )}

      {/* Patients writing to the clinic: what needs an operator. */}
      <Section icon={<MessagesSquare className="h-4 w-4" />} title="Suhbatlar va bemorlar">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
          <Link href="/admin/conversations" className={urgent > 0 ? "rounded-2xl ring-2 ring-clay" : undefined}>
            <StatCard label="Shoshilinch suhbatlar" value={n(urgent)} tone={urgent > 0 ? "clay" : "neutral"} />
          </Link>
          <Link href="/admin/conversations">
            <StatCard label="Diqqat talab suhbatlar" value={n(d?.attention_conversations)} tone={(d?.attention_conversations ?? 0) > 0 ? "clay" : "neutral"} />
          </Link>
          <Link href="/admin/conversations">
            <StatCard label="Faol suhbatlar" value={n(d?.active_conversations)} tone="info" />
          </Link>
          <StatCard label="Yangi bemorlar" value={n(d?.new_patients_today)} tone="info" />
          {d?.upcoming_reminders !== null && d?.upcoming_reminders !== undefined && (
            <StatCard label="Eslatmalar (24 soat)" value={n(d.upcoming_reminders)} tone="neutral" />
          )}
        </div>
      </Section>

      {/* Booked appointments of the clinic day. */}
      <Section icon={<CalendarDays className="h-4 w-4" />} title="Bugungi qabullar" link={{ href: "/admin/appointments", label: "Barcha qabullar" }}>
        {d && d.counts.total > 0 && (
          <div className="mb-3 flex flex-wrap gap-2">
            <ABadge tone="gray">Jami {d.counts.total}</ABadge>
            {STATUS_KEYS.filter((k) => d.counts[k] > 0).map((k) => (
              <ABadge key={k} tone={STATUS_TONES[k]}>
                {STATUS_LABELS[k]} {d.counts[k]}
              </ABadge>
            ))}
          </div>
        )}
        {!d ? (
          <Card>
            <LoadingRow />
          </Card>
        ) : d.appointments.length === 0 ? (
          <Card>
            <AEmpty
              title="Bugungi qabullar yo‘q"
              subtitle="Yangi qabul qo‘shish uchun yuqoridagi tugmadan foydalaning"
              icon={<CalendarDays className="h-6 w-6" />}
            />
          </Card>
        ) : (
          <ATable headers={["Vaqt", "Bemor", "Xizmat", "Shifokor", "Manba", "Holat", "To‘lov", "Amallar"]}>
            {d.appointments.map((r) => (
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
      </Section>

      {modalOpen && (
        <QuickBookingModal
          onClose={() => setModalOpen(false)}
          onCreated={() => {
            setModalOpen(false);
            void live.reload();
          }}
          onError={setActionError}
        />
      )}
    </div>
  );
}

function Section({
  icon,
  title,
  link,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  link?: { href: string; label: string };
  children: React.ReactNode;
}) {
  return (
    <section className="mb-7">
      <div className="mb-2.5 flex items-center justify-between gap-3">
        <h2 className="flex items-center gap-2 font-display text-sm font-bold text-foreground">
          <span className="text-pine">{icon}</span>
          {title}
        </h2>
        {link && (
          <Link href={link.href} className="inline-flex items-center gap-1 text-xs font-medium text-pine hover:underline">
            {link.label}
            <ArrowRight className="h-3.5 w-3.5" />
          </Link>
        )}
      </div>
      {children}
    </section>
  );
}

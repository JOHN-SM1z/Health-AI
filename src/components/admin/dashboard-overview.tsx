import Link from "next/link";
import { Stethoscope } from "lucide-react";
import { Card, StatCard, AEmpty, LoadingRow } from "@/components/admin/ui";
import { formatPrice } from "@/lib/admin/client";
import { doctorLoadToday } from "@/lib/admin/today-aggregate";
import type { DashboardSnapshot, TodayAppointmentRow } from "@/lib/admin/dashboard-types";

type OverviewProps = {
  dashboard: DashboardSnapshot | null;
  rows: TodayAppointmentRow[] | null;
  counts: Record<string, number>;
};

function DoctorLoadCard({ rows, includeRevenue, title }: { rows: TodayAppointmentRow[] | null; includeRevenue: boolean; title: string }) {
  return (
    <Card className="mb-6">
      <div className="mb-4 flex items-center gap-2">
        <Stethoscope className="h-4 w-4 text-ink-muted" />
        <p className="text-sm font-bold text-foreground">{title}</p>
      </div>
      {rows === null ? (
        <LoadingRow />
      ) : rows.length === 0 ? (
        <AEmpty title="Bugun qabul yo‘q" icon={<Stethoscope className="h-5 w-5" />} />
      ) : (
        <div className="space-y-2.5">
          {doctorLoadToday(rows, includeRevenue).map((d) => (
            <div key={d.name} className="flex items-center justify-between text-sm">
              <div>
                <p className="font-medium text-foreground">{d.name}</p>
                <p className="text-xs text-ink-muted">{d.completed} ta yakunlangan / {d.count} ta jami</p>
              </div>
              {includeRevenue && <p className="font-numeric font-semibold text-pine-deep">{formatPrice(d.revenue)}</p>}
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

/** Manager: daily operations, staff scheduling, appointment/patient flow, clinic efficiency — no money. */
export function ManagerOverview({ dashboard, rows, counts }: OverviewProps) {
  return (
    <>
      <div className="mb-3 grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatCard label="Bugungi qabullar" value={(counts.today ?? 0).toLocaleString("uz-UZ")} tone="neutral" />
        <StatCard label="Kutilmoqda" value={(counts.pending ?? 0).toLocaleString("uz-UZ")} tone="clay" />
        <StatCard label="Jarayonda" value={(counts.in_progress ?? 0).toLocaleString("uz-UZ")} tone="info" />
        {dashboard?.upcoming_reminders != null && (
          <StatCard label="Eslatmalar (24 soat)" value={dashboard.upcoming_reminders.toLocaleString("uz-UZ")} tone="neutral" />
        )}
      </div>
      <div className="mb-6 grid grid-cols-2 gap-3">
        <Link href="/admin/conversations">
          <StatCard label="Faol suhbatlar" value={(dashboard?.active_conversations ?? 0).toLocaleString("uz-UZ")} tone="info" />
        </Link>
        <Link href="/admin/conversations">
          <StatCard label="Diqqat talab suhbatlar" value={(dashboard?.attention_conversations ?? 0).toLocaleString("uz-UZ")} tone="clay" />
        </Link>
      </div>
      <DoctorLoadCard rows={rows} includeRevenue={false} title="Shifokorlar yuklamasi (bugun)" />
    </>
  );
}

/** Receptionist/call center: bookings, registration, conversations, arrivals, queue — action first. */
export function ReceptionistOverview({ dashboard, counts }: OverviewProps) {
  return (
    <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-4">
      <Link href="/admin/conversations">
        <StatCard label="Diqqat talab suhbatlar" value={(dashboard?.attention_conversations ?? 0).toLocaleString("uz-UZ")} tone="clay" />
      </Link>
      <Link href="/admin/conversations">
        <StatCard label="Faol suhbatlar" value={(dashboard?.active_conversations ?? 0).toLocaleString("uz-UZ")} tone="info" />
      </Link>
      <StatCard label="Kutish zalida" value={(counts.checked_in ?? 0).toLocaleString("uz-UZ")} tone="pine" />
      <StatCard label="Yangi bemorlar" value={(dashboard?.new_patients_today ?? 0).toLocaleString("uz-UZ")} tone="info" />
    </div>
  );
}

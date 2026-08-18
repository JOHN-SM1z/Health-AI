import type { Database } from "@/lib/supabase/database.types";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireRoles } from "@/lib/auth/guards";
import { handleApiError, ok } from "@/lib/api/errors";

export const dynamic = "force-dynamic";

const MANAGEMENT = ["owner", "admin", "manager"] as const;

function tzOffsetMinutes(tz: string, at: Date): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
      .formatToParts(at)
      .map((p) => [p.type, p.value]),
  );
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  return Math.round((asUtc - at.getTime()) / 60000);
}

/** Clinic-local day window for `tz`, e.g. 00:00–24:00 in Asia/Tashkent. */
export function localDayWindow(tz: string, now = new Date()): { start: string; end: string } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
  const ymd = `${parts.year}-${parts.month}-${parts.day}`;
  const nominalStart = Date.parse(`${ymd}T00:00:00Z`);
  const start = new Date(nominalStart - tzOffsetMinutes(tz, new Date(nominalStart)) * 60000);
  return { start: start.toISOString(), end: new Date(start.getTime() + 86400000).toISOString() };
}

type TodayRow = {
  status: Database["public"]["Enums"]["appointment_status"];
  services: { price: number } | null;
  payments: { status: string; amount: number } | null;
};

/**
 * Today overview for the staff dashboard: appointment counts, collected and
 * outstanding amounts, new patients, and upcoming reminder jobs — always
 * scoped to the staff member's own clinic.
 */
export async function GET() {
  try {
    const ctx = await requireRoles("owner", "admin", "manager", "receptionist");
    const supabase = createAdminClient();
    const { start, end } = localDayWindow(ctx.clinicTimezone);

    const { data: today, error: todayError } = await supabase
      .from("appointments")
      .select("status, services(name, price), payments(status, amount)")
      .eq("clinic_id", ctx.clinicId)
      .gte("start_at", start)
      .lt("start_at", end);
    if (todayError) throw todayError;

    const counts = {
      total: 0,
      pending: 0,
      confirmed: 0,
      checked_in: 0,
      in_progress: 0,
      completed: 0,
      cancelled: 0,
      no_show: 0,
    };
    let revenue = 0;
    let outstanding = 0;
    for (const row of (today ?? []) as TodayRow[]) {
      counts[row.status] = (counts[row.status] ?? 0) + 1;
      counts.total += 1;
      const amount = Number(row.services?.price ?? 0);
      if (row.status === "completed" && row.payments?.status === "paid") {
        revenue += amount;
      } else if (row.payments?.status === "unpaid" || row.payments?.status === "pending") {
        outstanding += amount;
      }
    }

    const { count: newPatients, error: patientsError } = await supabase
      .from("patients")
      .select("id", { count: "exact", head: true })
      .eq("clinic_id", ctx.clinicId)
      .gte("created_at", start)
      .lt("created_at", end);
    if (patientsError) throw patientsError;

    let upcomingReminders: number | null = null;
    const isManagement = ctx.roles.some((r) => (MANAGEMENT as readonly string[]).includes(r));
    if (isManagement) {
      const nowIso = new Date().toISOString();
      const { count: reminders, error: remindersError } = await supabase
        .from("notification_jobs")
        .select("id", { count: "exact", head: true })
        .eq("clinic_id", ctx.clinicId)
        .eq("status", "pending")
        .gte("scheduled_for", nowIso)
        .lte("scheduled_for", new Date(Date.now() + 24 * 3600000).toISOString());
      if (remindersError) throw remindersError;
      upcomingReminders = reminders ?? 0;
    }

    return ok({
      day: { start, end },
      counts,
      revenue,
      outstanding,
      new_patients_today: newPatients ?? 0,
      upcoming_reminders: upcomingReminders,
    });
  } catch (e) {
    return handleApiError(e);
  }
}
import type { Database } from "@/lib/supabase/database.types";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireRoles } from "@/lib/auth/guards";
import { handleApiError, ok } from "@/lib/api/errors";
import { localDayWindow } from "@/lib/time/local";

export const dynamic = "force-dynamic";

export { localDayWindow };

const MANAGEMENT = ["owner", "admin", "manager"] as const;

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

    // Conversation oversight: how many chats are live right now, and how many
    // need an operator (patient asked for one, AI is off, nobody claimed it).
    const activeStatuses = ["open", "assigned", "released"] as const;
    const { count: activeConversations, error: convError } = await supabase
      .from("conversations")
      .select("id", { count: "exact", head: true })
      .eq("clinic_id", ctx.clinicId)
      .in("status", [...activeStatuses]);
    if (convError) throw convError;

    const { count: attentionConversations, error: attentionError } = await supabase
      .from("conversations")
      .select("id", { count: "exact", head: true })
      .eq("clinic_id", ctx.clinicId)
      .eq("status", "open")
      .eq("ai_enabled", false);
    if (attentionError) throw attentionError;

    return ok({
      day: { start, end },
      counts,
      revenue,
      outstanding,
      new_patients_today: newPatients ?? 0,
      upcoming_reminders: upcomingReminders,
      active_conversations: activeConversations ?? 0,
      attention_conversations: attentionConversations ?? 0,
    });
  } catch (e) {
    return handleApiError(e);
  }
}
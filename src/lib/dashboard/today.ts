import "server-only";
import type { Database } from "@/lib/supabase/database.types";
import type { StaffContext } from "@/lib/auth/staff";
import { canViewPaymentDynamics } from "@/lib/auth/staff";
import { createAdminClient } from "@/lib/supabase/admin";
import { localDayWindow } from "@/lib/time/local";
import { labCan } from "@/lib/labs/permissions";
import { loadLabWorkload } from "@/lib/labs/workload";
import { listOpenVisits } from "@/lib/operations/outpatient";
import { outstandingOf, summarizeMoney, summarizeQueue, type MoneyToday, type QueueSummary } from "@/lib/dashboard/summary";

/**
 * The staff "Bugun" dashboard in ONE server round: everything below is read in
 * parallel, scoped to the staff member's clinic, and cut to what their role may
 * see. Before, the page made three requests one after another (role, counts,
 * then the appointment list straight from the browser) and showed money as the
 * catalogue price of booked appointments — which missed every walk-in visit and
 * laboratory payment.
 *
 * Role cuts (the server is the boundary, not the page):
 *   - money (received today, still owed): owner and admin only — canViewPaymentDynamics;
 *   - laboratory workload: roles that see the laboratory queue (queue.read) — status counts only;
 *   - upcoming reminders: management (owner, admin, manager).
 */

type AppointmentStatus = Database["public"]["Enums"]["appointment_status"];
type AppointmentSource = Database["public"]["Enums"]["appointment_source"];

export type TodayAppointment = {
  id: string;
  start_at: string;
  status: AppointmentStatus;
  source: AppointmentSource;
  patients: { full_name: string | null; phone: string | null } | null;
  doctors: { name: string } | null;
  services: { name: string; price: number } | null;
  payments: { status: string } | null;
};

export type TodayLab = {
  awaitingCollection: number;
  inLab: number;
  awaitingVerification: number;
  overdue: number;
  completedToday: number;
};

export type TodayDashboard = {
  day: { start: string; end: string };
  generated_at: string;
  counts: Record<"total" | AppointmentStatus, number>;
  appointments: TodayAppointment[];
  queue: QueueSummary & { completedToday: number; cancelledToday: number };
  lab: TodayLab | null;
  can_view_payment_dynamics: boolean;
  money: (MoneyToday & { outstanding: number }) | null;
  new_patients_today: number;
  upcoming_reminders: number | null;
  active_conversations: number;
  attention_conversations: number;
  urgent_conversations: number;
};

const MANAGEMENT = ["owner", "admin", "manager"];
const OPEN_CONVERSATION = ["open", "assigned"] as const;

/** Throws the database error of a failed read (the route turns it into a 500 without details). */
function must<T>(result: { data: T; error: unknown }): T {
  if (result.error) throw result.error;
  return result.data;
}
function mustCount(result: { count: number | null; error: unknown }): number {
  if (result.error) throw result.error;
  return result.count ?? 0;
}

export async function loadTodayDashboard(ctx: StaffContext & { clinicId: string }, now = new Date()): Promise<TodayDashboard> {
  const db = createAdminClient();
  const clinicId = ctx.clinicId;
  const { start, end } = localDayWindow(ctx.clinicTimezone, now);
  const mayViewMoney = canViewPaymentDynamics(ctx);
  const isManagement = ctx.roles.some((r) => MANAGEMENT.includes(r));
  const seesLab = labCan(ctx.roles, "queue.read");
  const nowIso = now.toISOString();

  const [
    appointments,
    newPatients,
    reminders,
    activeConversations,
    attentionConversations,
    urgentRows,
    openVisits,
    completedToday,
    cancelledToday,
    lab,
    money,
  ] = await Promise.all([
    db
      .from("appointments")
      .select("id, start_at, status, source, patients(full_name, phone), doctors(name), services(name, price), payments(status)")
      .eq("clinic_id", clinicId)
      .gte("start_at", start)
      .lt("start_at", end)
      .order("start_at", { ascending: true })
      .limit(500)
      .then((r) => must(r) as unknown as TodayAppointment[]),
    db
      .from("patients")
      .select("id", { count: "exact", head: true })
      .eq("clinic_id", clinicId)
      .gte("created_at", start)
      .lt("created_at", end)
      .then(mustCount),
    isManagement
      ? db
          .from("notification_jobs")
          .select("id", { count: "exact", head: true })
          .eq("clinic_id", clinicId)
          .eq("status", "pending")
          .gte("scheduled_for", nowIso)
          .lte("scheduled_for", new Date(now.getTime() + 24 * 3_600_000).toISOString())
          .then(mustCount)
      : Promise.resolve(null),
    // Conversation oversight: chats live right now, and those that need an operator
    // (AI off, nobody claimed it).
    db
      .from("conversations")
      .select("id", { count: "exact", head: true })
      .eq("clinic_id", clinicId)
      .in("status", [...OPEN_CONVERSATION])
      .then(mustCount),
    db
      .from("conversations")
      .select("id", { count: "exact", head: true })
      .eq("clinic_id", clinicId)
      .eq("status", "open")
      .eq("ai_enabled", false)
      .then(mustCount),
    // Urgent wording no staff member has taken over since (conversations.urgent_at) — few rows, compared here.
    db
      .from("conversations")
      .select("urgent_at, taken_over_at")
      .eq("clinic_id", clinicId)
      .in("status", [...OPEN_CONVERSATION])
      .not("urgent_at", "is", null)
      .then(must),
    // Every unfinished walk-in visit, whatever day it started (nobody disappears at midnight).
    listOpenVisits(clinicId),
    db
      .from("visits")
      .select("id", { count: "exact", head: true })
      .eq("clinic_id", clinicId)
      .eq("status", "completed")
      .gte("completed_at", start)
      .lt("completed_at", end)
      .then(mustCount),
    db
      .from("visits")
      .select("id", { count: "exact", head: true })
      .eq("clinic_id", clinicId)
      .eq("status", "cancelled")
      .gte("cancelled_at", start)
      .lt("cancelled_at", end)
      .then(mustCount),
    seesLab ? loadLabWorkload(clinicId, ctx.clinicTimezone, now) : Promise.resolve(null),
    mayViewMoney ? loadMoneyToday(clinicId, start, end) : Promise.resolve(null),
  ]);

  const counts: TodayDashboard["counts"] = { total: 0, pending: 0, confirmed: 0, checked_in: 0, in_progress: 0, completed: 0, cancelled: 0, no_show: 0 };
  for (const a of appointments) {
    counts.total += 1;
    counts[a.status] = (counts[a.status] ?? 0) + 1;
  }

  const urgentConversations = (urgentRows ?? []).filter(
    (c) => c.urgent_at && (!c.taken_over_at || c.taken_over_at < c.urgent_at),
  ).length;

  return {
    day: { start, end },
    generated_at: nowIso,
    counts,
    appointments,
    queue: { ...summarizeQueue(openVisits, now), completedToday, cancelledToday },
    lab: lab
      ? {
          awaitingCollection: lab.stages.awaitingCollection.count,
          inLab: lab.stages.inTransit.count + lab.stages.awaitingEntry.count + lab.stages.inProgress.count,
          awaitingVerification: lab.stages.awaitingVerification.count,
          overdue: lab.overdue,
          completedToday: lab.completedToday,
        }
      : null,
    can_view_payment_dynamics: mayViewMoney,
    money: money ? { ...money, outstanding: outstandingOf(openVisits) } : null,
    new_patients_today: newPatients,
    upcoming_reminders: reminders,
    active_conversations: activeConversations,
    attention_conversations: attentionConversations,
    urgent_conversations: urgentConversations,
  };
}

/** Money received in [start, end): the kassa ledger, laboratory-kassa payments, and booked appointments paid outside the kassa. */
async function loadMoneyToday(clinicId: string, start: string, end: string): Promise<MoneyToday> {
  const db = createAdminClient();
  const [kassa, labPaid, appointmentPaid] = await Promise.all([
    db
      .from("visit_transactions")
      .select("kind, method, amount")
      .eq("clinic_id", clinicId)
      .gte("created_at", start)
      .lt("created_at", end)
      .limit(20000)
      .then(must),
    db
      .from("payments")
      .select("amount")
      .eq("clinic_id", clinicId)
      .eq("status", "paid")
      .not("lab_order_id", "is", null)
      .gte("paid_at", start)
      .lt("paid_at", end)
      .limit(20000)
      .then(must),
    db
      .from("payments")
      .select("amount, appointment_id")
      .eq("clinic_id", clinicId)
      .eq("status", "paid")
      .is("lab_order_id", null)
      .not("appointment_id", "is", null)
      .gte("paid_at", start)
      .lt("paid_at", end)
      .limit(20000)
      .then(must),
  ]);

  // A booking paid online whose visit exists is already in the kassa ledger (an 'online' collection): count it once.
  const appointmentIds = (appointmentPaid ?? []).map((p) => p.appointment_id!).filter(Boolean);
  const withVisit = new Set<string>();
  for (let i = 0; i < appointmentIds.length; i += 300) {
    const rows = must(
      await db
        .from("visits")
        .select("appointment_id")
        .eq("clinic_id", clinicId)
        .in("appointment_id", appointmentIds.slice(i, i + 300)),
    );
    for (const r of rows ?? []) if (r.appointment_id) withVisit.add(r.appointment_id);
  }

  return summarizeMoney(
    kassa ?? [],
    (labPaid ?? []).map((p) => Number(p.amount)),
    (appointmentPaid ?? []).filter((p) => !withVisit.has(p.appointment_id!)).map((p) => Number(p.amount)),
  );
}

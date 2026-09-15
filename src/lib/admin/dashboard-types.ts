import type { Database } from "@/lib/supabase/database.types";

export type TodayAppointmentRow = {
  id: string;
  start_at: string;
  status: Database["public"]["Enums"]["appointment_status"];
  source: Database["public"]["Enums"]["appointment_source"];
  patients: { full_name: string | null; phone: string | null } | null;
  doctors: { name: string } | null;
  services: { name: string; price: number } | null;
  payments: { status: string } | null;
};

/** Response shape of GET /api/admin/dashboard. */
export type DashboardSnapshot = {
  day: { start: string; end: string };
  counts: Record<string, number>;
  can_view_payment_dynamics: boolean;
  revenue: number | null;
  outstanding: number | null;
  new_patients_today: number;
  upcoming_reminders: number | null;
  active_conversations: number;
  attention_conversations: number;
};

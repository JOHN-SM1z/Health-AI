/** Shape of GET /api/admin/dashboard — role-filtered server payload. */
export type DashboardData = {
  counts: Record<string, number>;
  can_view_payment_dynamics: boolean;
  revenue: number | null;
  outstanding: number | null;
  revenue_week: number | null;
  revenue_month: number | null;
  new_patients_today: number;
  total_patients: number | null;
  upcoming_reminders: number | null;
  active_conversations: number;
  attention_conversations: number;
  ai_conversations: number;
  takeover_conversations: number;
  source_distribution: Record<string, number> | null;
  recent_activity:
    | Array<{
        id: string;
        start_at: string;
        created_at: string;
        status: string;
        source: string;
        patients: { full_name: string | null } | null;
        doctors: { name: string } | null;
        services: { name: string } | null;
      }>
    | null;
  doctors_today: number | null;
  doctors_active: number | null;
};

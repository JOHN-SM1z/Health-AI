import type { NextRequest } from "next/server";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireRoles } from "@/lib/auth/guards";
import { handleApiError, ok } from "@/lib/api/errors";
import { aggregateAppointments, type AnalyticsRow } from "@/lib/analytics/aggregate";

export const dynamic = "force-dynamic";

const listSchema = z.object({
  range: z.coerce.number().int().min(1).max(365).default(30),
});

/**
 * Management analytics: per-clinic appointment aggregates derived from the
 * appointments table (truthful booking source, cancellation reasons, revenue
 * trend, top services and doctors), scoped to the staff member's own clinic.
 */
export async function GET(request: NextRequest) {
  try {
    const ctx = await requireRoles("owner", "admin", "manager");
    const { range } = listSchema.parse(Object.fromEntries(request.nextUrl.searchParams));
    const supabase = createAdminClient();
    const since = new Date(Date.now() - range * 86400000).toISOString();

    const { data, error } = await supabase
      .from("appointments")
      .select("source, status, cancelled_reason, no_show_reason, start_at, services(name, price), doctors(name)")
      .eq("clinic_id", ctx.clinicId)
      .gte("start_at", since);
    if (error) throw error;

    const agg = aggregateAppointments((data ?? []) as AnalyticsRow[], ctx.clinicTimezone);

    return ok({
      range,
      total: agg.total,
      cancelled: agg.cancelled,
      no_shows: agg.noShows,
      completed: agg.completed,
      by_source: agg.bySource,
      by_status: agg.byStatus,
      cancel_reasons: agg.cancelReasons,
      no_show_reasons: agg.noShowReasons,
      revenue_trend: agg.revenueTrend,
      revenue_by_week: agg.revenueByWeek,
      revenue_by_month: agg.revenueByMonth,
      top_services: agg.topServices,
      top_doctors: agg.topDoctors,
    });
  } catch (e) {
    return handleApiError(e);
  }
}
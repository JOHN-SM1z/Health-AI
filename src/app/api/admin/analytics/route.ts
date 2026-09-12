import type { NextRequest } from "next/server";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireRoles } from "@/lib/auth/guards";
import { canViewPaymentDynamics } from "@/lib/auth/staff";
import { handleApiError, ApiError, ok } from "@/lib/api/errors";
import { aggregateAppointments, type AnalyticsRow } from "@/lib/analytics/aggregate";
import { localDayWindowForDate } from "@/lib/time/local";

export const dynamic = "force-dynamic";

const isoDate = /^\d{4}-\d{2}-\d{2}$/;
const querySchema = z.object({
  range: z.coerce.number().int().min(1).max(365).default(30),
  from: z.string().regex(isoDate, "Sana YYYY-MM-DD formatida bo‘lishi kerak").optional(),
  to: z.string().regex(isoDate, "Sana YYYY-MM-DD formatida bo‘lishi kerak").optional(),
});

/**
 * Management analytics: per-clinic appointment aggregates derived from the
 * appointments table (truthful booking source, cancellation reasons, revenue
 * trend, top services and doctors), scoped to the staff member's own clinic.
 *
 * Accepts either `range` (a rolling window of N days, the default) or an
 * explicit `from`/`to` clinic-local calendar date pair for a custom range —
 * both interpreted in the clinic's own timezone, never the server's.
 */
export async function GET(request: NextRequest) {
  try {
    const ctx = await requireRoles("owner", "admin", "manager");
    const mayViewPaymentDynamics = canViewPaymentDynamics(ctx);
    const params = querySchema.parse(Object.fromEntries(request.nextUrl.searchParams));
    const supabase = createAdminClient();

    let since: string;
    let until: string | null = null;
    let range = params.range;
    if (params.from && params.to) {
      if (params.from > params.to) {
        throw new ApiError(400, "Boshlanish sanasi tugash sanasidan keyin bo‘lishi mumkin emas", "bad_range");
      }
      since = localDayWindowForDate(ctx.clinicTimezone, params.from).start;
      until = localDayWindowForDate(ctx.clinicTimezone, params.to).end;
      range = Math.round((new Date(until).getTime() - new Date(since).getTime()) / 86400000);
    } else {
      since = new Date(Date.now() - range * 86400000).toISOString();
    }

    let query = supabase
      .from("appointments")
      .select(
        "id, source, status, cancelled_reason, no_show_reason, start_at, patients(full_name), services(name, price), doctors(name), payments(status, amount)",
      )
      .eq("clinic_id", ctx.clinicId)
      .gte("start_at", since);
    if (until) query = query.lt("start_at", until);
    const { data, error } = await query;
    if (error) throw error;

    const agg = aggregateAppointments((data ?? []) as AnalyticsRow[], ctx.clinicTimezone);

    return ok({
      range,
      from: params.from ?? null,
      to: params.to ?? null,
      total: agg.total,
      cancelled: agg.cancelled,
      no_shows: agg.noShows,
      completed: agg.completed,
      cancellation_rate: agg.cancellationRate,
      no_show_rate: agg.noShowRate,
      by_source: agg.bySource,
      by_status: agg.byStatus,
      cancel_reasons: agg.cancelReasons,
      no_show_reasons: agg.noShowReasons,
      can_view_payment_dynamics: mayViewPaymentDynamics,
      total_revenue: mayViewPaymentDynamics ? agg.totalRevenue : null,
      by_payment_status: mayViewPaymentDynamics ? agg.byPaymentStatus : [],
      revenue_trend: mayViewPaymentDynamics ? agg.revenueTrend : [],
      revenue_by_week: mayViewPaymentDynamics ? agg.revenueByWeek : [],
      revenue_by_month: mayViewPaymentDynamics ? agg.revenueByMonth : [],
      unpaid_total: mayViewPaymentDynamics ? agg.unpaidTotal : null,
      pending_total: mayViewPaymentDynamics ? agg.pendingTotal : null,
      refunded_total: mayViewPaymentDynamics ? agg.refundedTotal : null,
      average_ticket: mayViewPaymentDynamics ? agg.averageTicket : null,
      // Individually identifies a patient by name alongside a payment amount
      // — the same financial-data gate as every other money figure here.
      recent_payments: mayViewPaymentDynamics ? agg.recentPayments : [],
      top_services: agg.topServices.map(({ name, count, completedCount, revenue }) => ({
        name,
        count,
        completed_count: completedCount,
        revenue: mayViewPaymentDynamics ? revenue : null,
      })),
      top_doctors: agg.topDoctors.map(({ name, count, completedCount, revenue, completionRate }) => ({
        name,
        count,
        completed_count: completedCount,
        completion_rate: completionRate,
        revenue: mayViewPaymentDynamics ? revenue : null,
      })),
    });
  } catch (e) {
    return handleApiError(e);
  }
}

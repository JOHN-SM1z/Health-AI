import type { NextRequest } from "next/server";
import { requireRoles } from "@/lib/auth/guards";
import { canViewPaymentDynamics } from "@/lib/auth/staff";
import { handleApiError, ok } from "@/lib/api/errors";
import { resolveAnalyticsWindow } from "@/lib/analytics/range";
import { aggregateLabOrders } from "@/lib/analytics/lab";
import { loadLabAnalyticsRows } from "@/lib/labs/management-analytics";
import { loadLabWorkload } from "@/lib/labs/workload";

export const dynamic = "force-dynamic";

const REPEAT_WINDOW_DAYS = 30;

/**
 * Laboratory management analytics (Phase 17): the same roles, period and
 * financial gate as /api/admin/analytics.
 *
 *  * owner / admin / manager: test volume, cancellations, turnaround,
 *    repeat-test patterns and the current workload;
 *  * money (revenue, by test, by category, outstanding and refunds) only for
 *    the existing payment roles (canViewPaymentDynamics: owner, admin) —
 *    a manager gets `finance: null`.
 *
 * Never a result value, flag or patient identifier; test names and counts only.
 */
export async function GET(request: NextRequest) {
  try {
    const ctx = await requireRoles("owner", "admin", "manager");
    const mayViewPaymentDynamics = canViewPaymentDynamics(ctx);
    const window = resolveAnalyticsWindow(request.nextUrl.searchParams, ctx.clinicTimezone);

    const [{ orders, history, truncated }, workload] = await Promise.all([
      loadLabAnalyticsRows(ctx.clinicId, window.since, window.until, REPEAT_WINDOW_DAYS),
      loadLabWorkload(ctx.clinicId, ctx.clinicTimezone),
    ]);
    const agg = aggregateLabOrders(orders, history, ctx.clinicTimezone, { repeatWindowDays: REPEAT_WINDOW_DAYS });
    const { finance, ...activity } = agg;

    return ok({
      range: window.range,
      from: window.from,
      to: window.to,
      truncated,
      can_view_payment_dynamics: mayViewPaymentDynamics,
      ...activity,
      workload,
      finance: mayViewPaymentDynamics ? finance : null,
    });
  } catch (e) {
    return handleApiError(e);
  }
}

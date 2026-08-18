import type { NextRequest } from "next/server";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireRoles } from "@/lib/auth/guards";
import { handleApiError, ok } from "@/lib/api/errors";

export const dynamic = "force-dynamic";

const listSchema = z.object({
  range: z.coerce.number().int().min(1).max(365).default(30),
});

/**
 * Management analytics: per-clinic appointment aggregates derived from the
 * appointments table (truthful booking source and cancellation reasons),
 * scoped to the staff member's own clinic.
 */
export async function GET(request: NextRequest) {
  try {
    const ctx = await requireRoles("owner", "admin", "manager");
    const { range } = listSchema.parse(Object.fromEntries(request.nextUrl.searchParams));
    const supabase = createAdminClient();
    const since = new Date(Date.now() - range * 86400000).toISOString();

    const { data, error } = await supabase
      .from("appointments")
      .select("source, status, cancelled_reason")
      .eq("clinic_id", ctx.clinicId)
      .gte("start_at", since);
    if (error) throw error;

    const bySource = new Map<string, number>();
    const byStatus = new Map<string, number>();
    const cancelReasons = new Map<string, number>();
    let cancelled = 0;
    let total = 0;
    for (const a of data ?? []) {
      total += 1;
      bySource.set(a.source, (bySource.get(a.source) ?? 0) + 1);
      byStatus.set(a.status, (byStatus.get(a.status) ?? 0) + 1);
      if (a.status === "cancelled") {
        cancelled += 1;
        const reason = (a.cancelled_reason ?? "Sabab ko‘rsatilmagan").trim();
        cancelReasons.set(reason, (cancelReasons.get(reason) ?? 0) + 1);
      }
    }

    const topReasons = [...cancelReasons.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);

    return ok({
      range,
      total,
      cancelled,
      by_source: [...bySource.entries()].sort((a, b) => b[1] - a[1]),
      by_status: [...byStatus.entries()].sort((a, b) => b[1] - a[1]),
      cancel_reasons: topReasons.map(([reason, count]) => ({ reason, count })),
    });
  } catch (e) {
    return handleApiError(e);
  }
}
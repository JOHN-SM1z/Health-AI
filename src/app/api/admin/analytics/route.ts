import type { NextRequest } from "next/server";
import { z } from "zod";
import type { Database } from "@/lib/supabase/database.types";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireRoles } from "@/lib/auth/guards";
import { handleApiError, ok } from "@/lib/api/errors";
import { clinicDateKey } from "@/lib/time/local";

export const dynamic = "force-dynamic";

const listSchema = z.object({
  range: z.coerce.number().int().min(1).max(365).default(30),
});

type AnalyticsRow = {
  source: Database["public"]["Enums"]["appointment_source"];
  status: Database["public"]["Enums"]["appointment_status"];
  cancelled_reason: string | null;
  start_at: string;
  services: { name: string; price: number } | null;
  doctors: { name: string } | null;
};

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
      .select("source, status, cancelled_reason, start_at, services(name, price), doctors(name)")
      .eq("clinic_id", ctx.clinicId)
      .gte("start_at", since);
    if (error) throw error;

    const rows = (data ?? []) as AnalyticsRow[];

    const bySource = new Map<string, number>();
    const byStatus = new Map<string, number>();
    const cancelReasons = new Map<string, number>();
    const trend = new Map<string, number>();
    const services = new Map<string, { count: number; revenue: number }>();
    const doctors = new Map<string, { count: number; revenue: number }>();
    let cancelled = 0;
    let total = 0;
    for (const a of rows) {
      total += 1;
      bySource.set(a.source, (bySource.get(a.source) ?? 0) + 1);
      byStatus.set(a.status, (byStatus.get(a.status) ?? 0) + 1);
      if (a.status === "cancelled") {
        cancelled += 1;
        const reason = (a.cancelled_reason ?? "Sabab ko‘rsatilmagan").trim();
        cancelReasons.set(reason, (cancelReasons.get(reason) ?? 0) + 1);
      }

      const price = Number(a.services?.price ?? 0);
      const paid = a.status === "completed";
      if (paid) {
        const day = clinicDateKey(ctx.clinicTimezone, new Date(a.start_at));
        trend.set(day, (trend.get(day) ?? 0) + price);
      }
      const svcName = a.services?.name ?? "Noma’lum xizmat";
      const svc = services.get(svcName) ?? { count: 0, revenue: 0 };
      svc.count += 1;
      if (paid) svc.revenue += price;
      services.set(svcName, svc);

      const docName = a.doctors?.name ?? "Noma’lum shifokor";
      const doc = doctors.get(docName) ?? { count: 0, revenue: 0 };
      doc.count += 1;
      if (paid) doc.revenue += price;
      doctors.set(docName, doc);
    }

    const topReasons = [...cancelReasons.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);

    return ok({
      range,
      total,
      cancelled,
      by_source: [...bySource.entries()].sort((a, b) => b[1] - a[1]),
      by_status: [...byStatus.entries()].sort((a, b) => b[1] - a[1]),
      cancel_reasons: topReasons.map(([reason, count]) => ({ reason, count })),
      revenue_trend: [...trend.entries()]
        .sort((a, b) => (a[0] < b[0] ? -1 : 1))
        .map(([date, revenue]) => ({ date, revenue })),
      top_services: [...services.entries()]
        .sort((a, b) => b[1].count - a[1].count)
        .slice(0, 8)
        .map(([name, v]) => ({ name, count: v.count, revenue: v.revenue })),
      top_doctors: [...doctors.entries()]
        .sort((a, b) => b[1].count - a[1].count)
        .slice(0, 8)
        .map(([name, v]) => ({ name, count: v.count, revenue: v.revenue })),
    });
  } catch (e) {
    return handleApiError(e);
  }
}
import type { NextRequest } from "next/server";
import { ApiError, handleApiError, ok } from "@/lib/api/errors";
import { requireRoles } from "@/lib/auth/guards";
import { KASSA_ROLES, hasAnyRole } from "@/lib/auth/staff";
import { createAdminClient } from "@/lib/supabase/admin";
import { localDayWindow, localDayWindowForDate } from "@/lib/time/local";
import { kassaTotals } from "@/lib/operations/outpatient";

export const dynamic = "force-dynamic";

/**
 * Money received and paid back on a clinic day (default: today), by method
 * and by the person who executed it — for reconciling the drawer and the
 * terminal report. A cashier sees their own; owner, manager, admin the clinic's.
 */
export async function GET(request: NextRequest) {
  try {
    const staff = await requireRoles(...KASSA_ROLES);
    const date = request.nextUrl.searchParams.get("date");
    if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new ApiError(400, "Sana noto‘g‘ri", "validation");
    const { data: clinic } = await createAdminClient().from("clinics").select("timezone").eq("id", staff.clinicId).single();
    const tz = clinic?.timezone ?? "Asia/Tashkent";
    const day = date ? localDayWindowForDate(tz, date) : localDayWindow(tz);
    const clinicWide = hasAnyRole(staff.roles, ["owner", "manager", "admin"]);
    return ok(await kassaTotals(staff, day.start, day.end, clinicWide));
  } catch (e) {
    return handleApiError(e);
  }
}

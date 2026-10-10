import { handleApiError, ok } from "@/lib/api/errors";
import { requireRoles } from "@/lib/auth/guards";
import { KASSA_ROLES, hasAnyRole } from "@/lib/auth/staff";
import { createAdminClient } from "@/lib/supabase/admin";
import { localDayWindow } from "@/lib/time/local";
import { hasActiveRefundGrant, listOpenVisits, listRecentClosedVisits } from "@/lib/operations/outpatient";

export const dynamic = "force-dynamic";

/**
 * The kassa's work list: unfinished visits (awaiting payment first) and the
 * visits that ended today, each with itemized charges and what was charged,
 * paid, refunded and is still due. Plus whether this user may refund.
 */
export async function GET() {
  try {
    const staff = await requireRoles(...KASSA_ROLES);
    const { data: clinic } = await createAdminClient().from("clinics").select("timezone, currency").eq("id", staff.clinicId).single();
    const day = localDayWindow(clinic?.timezone ?? "Asia/Tashkent");
    const [open, closed] = await Promise.all([listOpenVisits(staff.clinicId), listRecentClosedVisits(staff.clinicId, day.start)]);
    const canRefund =
      hasAnyRole(staff.roles, ["owner", "manager"]) ||
      (hasAnyRole(staff.roles, ["cashier"]) && (await hasActiveRefundGrant(staff.clinicId, staff.profileId)));
    return ok({
      open: [...open.filter((v) => v.status === "awaiting_payment"), ...open.filter((v) => v.status !== "awaiting_payment")],
      closed,
      canRefund,
      // Only owner and manager grant cashiers refund permission.
      canManageRefundGrants: hasAnyRole(staff.roles, ["owner", "manager"]),
      currency: clinic?.currency ?? "UZS",
      day,
      at: new Date().toISOString(),
    });
  } catch (e) {
    return handleApiError(e);
  }
}

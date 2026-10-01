import type { NextRequest } from "next/server";
import { requireRoles } from "@/lib/auth/guards";
import { LAB_KASSA_READ_ROLES, LAB_PAYMENT_CONFIRM_ROLES, LAB_REFUND_ROLES, hasAnyRole } from "@/lib/auth/staff";
import { handleApiError, ok } from "@/lib/api/errors";
import { listKassaOrders, type KassaFilter } from "@/lib/labs/kassa";

export const dynamic = "force-dynamic";

/** Laboratory orders with the status of their payment, for the people at the cashier's desk. */
export async function GET(request: NextRequest) {
  try {
    const staff = await requireRoles(...LAB_KASSA_READ_ROLES);
    const raw = request.nextUrl.searchParams.get("filter");
    const filter: KassaFilter = raw === "paid" || raw === "all" ? raw : "unpaid";
    // What this person may do is decided here, so the screen shows only the actions the server would accept.
    const can = { confirm: hasAnyRole(staff.roles, LAB_PAYMENT_CONFIRM_ROLES), refund: hasAnyRole(staff.roles, LAB_REFUND_ROLES) };
    return ok({ orders: await listKassaOrders(staff.clinicId, filter), can });
  } catch (e) {
    return handleApiError(e);
  }
}

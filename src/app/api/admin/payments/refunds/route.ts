import { handleApiError, ok } from "@/lib/api/errors";
import { requireRoles } from "@/lib/auth/guards";
import { listRefundRequests } from "@/lib/payments/online/service";

export const dynamic = "force-dynamic";

/** Owner/manager: online payments to send back (a second payment, a lost slot, a cancelled booking). */
export async function GET() {
  try {
    const staff = await requireRoles("owner", "manager");
    return ok({ refunds: await listRefundRequests(staff.clinicId) });
  } catch (e) {
    return handleApiError(e);
  }
}

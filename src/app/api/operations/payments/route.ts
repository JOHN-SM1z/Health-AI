import { requireRoles } from "@/lib/auth/guards";
import { ApiError, handleApiError } from "@/lib/api/errors";
export { GET } from "../kassa/route";
/** The old paid-status mutation cannot represent itemized ledger settlement.
 * Require the canonical idempotent payment/refund command instead. */
export async function POST() {
  try {
    await requireRoles("owner", "admin", "manager", "cashier");
    throw new ApiError(410, "To‘lovlar xizmatlar kassasiga ko‘chirildi", "endpoint_replaced", {
      payment: "/api/operations/kassa/[visitId]/pay", refund: "/api/operations/kassa/[visitId]/refund",
    });
  } catch (e) { return handleApiError(e); }
}

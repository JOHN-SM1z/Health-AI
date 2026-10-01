import { requireRoles } from "@/lib/auth/guards";
import { LAB_WORK_ROLES } from "@/lib/auth/staff";
import { handleApiError, ok } from "@/lib/api/errors";
import { listWorklist } from "@/lib/labs/samples";

export const dynamic = "force-dynamic";

/** The bench's worklist: open orders with payment status, readiness for collection and their samples. Lab staff only. */
export async function GET() {
  try {
    const staff = await requireRoles(...LAB_WORK_ROLES);
    return ok(await listWorklist(staff.clinicId));
  } catch (e) {
    return handleApiError(e);
  }
}

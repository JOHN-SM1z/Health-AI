import { requireLabCapability } from "@/lib/labs/guards";
import { handleApiError, ok } from "@/lib/api/errors";
import { loadLabWorkload } from "@/lib/labs/workload";

export const dynamic = "force-dynamic";

/**
 * The laboratory's current work by stage (Phase 17): status counts and
 * waiting times only, for the roles that see the work queue (queue.read).
 */
export async function GET() {
  try {
    const staff = await requireLabCapability("queue.read");
    return ok({ workload: await loadLabWorkload(staff.clinicId, staff.clinicTimezone) });
  } catch (e) {
    return handleApiError(e);
  }
}

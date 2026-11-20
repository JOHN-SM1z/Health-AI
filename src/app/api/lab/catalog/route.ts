import { handleApiError, ok } from "@/lib/api/errors";
import { requireLabCapability } from "@/lib/labs/guards";
import { getOrderableCatalog } from "@/lib/labs/ordering";

export const dynamic = "force-dynamic";

/** Tests and panels orderable now (active only), for walk-in orders at the desk. */
export async function GET() {
  try {
    const staff = await requireLabCapability("queue.read");
    return ok(await getOrderableCatalog(staff.clinicId));
  } catch (e) {
    return handleApiError(e);
  }
}

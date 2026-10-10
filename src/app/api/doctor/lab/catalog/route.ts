import { requireLinkedDoctor } from "@/lib/auth/guards";
import { handleApiError, ok } from "@/lib/api/errors";
import { getOrderableCatalog } from "@/lib/labs/ordering";

export const dynamic = "force-dynamic";

/** Tests and panels a doctor can order now: active only, with preparation and price. */
export async function GET() {
  try {
    const doctor = await requireLinkedDoctor();
    return ok(await getOrderableCatalog(doctor.clinicId));
  } catch (e) {
    return handleApiError(e);
  }
}

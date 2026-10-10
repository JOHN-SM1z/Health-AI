import { handleApiError, ok } from "@/lib/api/errors";
import { requireLabCapability } from "@/lib/labs/guards";
import { getLabCatalog } from "@/lib/labs/catalog";

export const dynamic = "force-dynamic";

/** The clinic's whole lab catalog (configuration; no patient data). */
export async function GET() {
  try {
    const staff = await requireLabCapability("catalog.read");
    return ok(await getLabCatalog(staff.clinicId));
  } catch (e) {
    return handleApiError(e);
  }
}

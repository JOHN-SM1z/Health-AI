import { handleApiError, ok } from "@/lib/api/errors";
import { requireRoles } from "@/lib/auth/guards";
import { listMerges } from "@/lib/patients/merge";

export const dynamic = "force-dynamic";

/** The clinic's merge log (owner / admin). */
export async function GET() {
  try {
    const staff = await requireRoles("owner", "admin");
    return ok({ merges: await listMerges(staff) });
  } catch (e) {
    return handleApiError(e);
  }
}

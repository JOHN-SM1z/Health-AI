import { requireLabConfig } from "@/lib/labs/access";
import { handleApiError, ok } from "@/lib/api/errors";
import { listOrphanedDrafts } from "@/lib/labs/results";

export const dynamic = "force-dynamic";

/**
 * Owner/admin/manager: laboratory drafts whose holder is no longer an active laboratory user. Management sees the test, the
 * version and who held it — never a patient, never a value (results are clinical, and not theirs to read).
 */
export async function GET() {
  try {
    const staff = await requireLabConfig();
    return ok({ drafts: await listOrphanedDrafts(staff.clinicId) });
  } catch (e) {
    return handleApiError(e);
  }
}

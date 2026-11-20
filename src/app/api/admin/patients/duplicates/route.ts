import { handleApiError, ok } from "@/lib/api/errors";
import { requireRoles } from "@/lib/auth/guards";
import { listDuplicateCandidates } from "@/lib/patients/merge";

export const dynamic = "force-dynamic";

/** Possible duplicate patient records — suggestions to review, never merged automatically (owner / admin). */
export async function GET() {
  try {
    const staff = await requireRoles("owner", "admin");
    return ok({ pairs: await listDuplicateCandidates(staff) });
  } catch (e) {
    return handleApiError(e);
  }
}

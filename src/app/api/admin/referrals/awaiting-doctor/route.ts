import { requireRoles } from "@/lib/auth/guards";
import { handleApiError, ok } from "@/lib/api/errors";
import { listReferralsAwaitingDoctor } from "@/lib/referrals/service";

export const dynamic = "force-dynamic";

/**
 * Department referrals awaiting a doctor, for clinic management: how many,
 * in which departments, and which referrals (patient name, referring doctor,
 * dates, priority — never the reason or handoff note). Owner/admin/manager
 * only; they withdraw one through PATCH /api/admin/referrals/[id].
 */
export async function GET() {
  try {
    const staff = await requireRoles("owner", "admin", "manager");
    return ok(await listReferralsAwaitingDoctor(staff.clinicId));
  } catch (e) {
    return handleApiError(e);
  }
}

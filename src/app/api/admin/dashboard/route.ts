import { requireRoles } from "@/lib/auth/guards";
import { handleApiError, ok } from "@/lib/api/errors";
import { loadTodayDashboard } from "@/lib/dashboard/today";

export const dynamic = "force-dynamic";

/**
 * The staff "Bugun" dashboard in one request (src/lib/dashboard/today.ts):
 * today's appointments and their counts, the live walk-in queue, laboratory
 * work, conversations needing attention and — for owner and admin only — the
 * money actually received today. Always scoped to the staff member's clinic.
 */
export async function GET() {
  try {
    const ctx = await requireRoles("owner", "admin", "manager", "receptionist");
    return ok(await loadTodayDashboard(ctx));
  } catch (e) {
    return handleApiError(e);
  }
}

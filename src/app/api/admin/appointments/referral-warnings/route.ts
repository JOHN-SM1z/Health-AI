import type { NextRequest } from "next/server";
import { requireRoles } from "@/lib/auth/guards";
import { handleApiError, ok } from "@/lib/api/errors";
import { uuidSchema } from "@/lib/api/validate";
import { referralWarningsForAppointments } from "@/lib/referrals/service";

export const dynamic = "force-dynamic";

/**
 * For the appointments reception is looking at (`ids`, comma separated): the
 * ones booked for a referral that has since been revoked or declined and have
 * not started. The visit stays — the warning only asks reception to review it
 * (REFERRAL_REVOKED / REFERRAL_DECLINED). Ids that are not UUIDs are ignored;
 * only this clinic's appointments are ever considered.
 */
export async function GET(request: NextRequest) {
  try {
    const staff = await requireRoles("owner", "admin", "manager", "receptionist");
    const ids = (request.nextUrl.searchParams.get("ids") ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter((id) => uuidSchema.safeParse(id).success);
    return ok({ warnings: await referralWarningsForAppointments(staff.clinicId, ids) });
  } catch (e) {
    return handleApiError(e);
  }
}

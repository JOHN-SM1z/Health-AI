import type { NextRequest } from "next/server";
import { requireRoles } from "@/lib/auth/guards";
import { handleApiError, ApiError, ok } from "@/lib/api/errors";
import { uuidSchema } from "@/lib/api/validate";
import { reviewReferralWarning } from "@/lib/referrals/service";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * "I've reviewed this": reception or management dismisses the
 * REFERRAL_REVOKED / REFERRAL_DECLINED warning of a visit they keep. Records
 * who and when (and audits it); the booking itself is not touched.
 */
export async function POST(_request: NextRequest, ctx: RouteContext) {
  try {
    const staff = await requireRoles("owner", "admin", "manager", "receptionist");
    const { id } = await ctx.params;
    if (!uuidSchema.safeParse(id).success) throw new ApiError(404, "Qabul topilmadi", "appointment_not_found");
    return ok({ reviewed: true, ...(await reviewReferralWarning(staff, id)) });
  } catch (e) {
    return handleApiError(e);
  }
}

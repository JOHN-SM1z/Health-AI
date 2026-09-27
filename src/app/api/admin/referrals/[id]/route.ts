import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireRoles } from "@/lib/auth/guards";
import { parseBody, uuidSchema } from "@/lib/api/validate";
import { ApiError, handleApiError, ok } from "@/lib/api/errors";
import { revokeReferralAsManagement } from "@/lib/referrals/service";

export const dynamic = "force-dynamic";

const revokeSchema = z.object({
  action: z.literal("revoke"),
  reason: z.string().trim().min(3, "Bekor qilish sababini yozing").max(1000),
});

type RouteContext = { params: Promise<{ id: string }> };

/**
 * Clinic management withdraws a referral — e.g. when the referring doctor has
 * left. Receptionists schedule follow-ups but never cancel clinical requests.
 */
export async function PATCH(request: NextRequest, ctx: RouteContext) {
  try {
    const staff = await requireRoles("owner", "admin", "manager");
    const { id } = await ctx.params;
    if (!uuidSchema.safeParse(id).success) throw new ApiError(404, "Yo‘llanma topilmadi", "referral_not_found");
    const body = await parseBody(request, revokeSchema);
    return ok(await revokeReferralAsManagement(staff, id, body.reason));
  } catch (e) {
    return handleApiError(e);
  }
}

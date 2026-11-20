import type { NextRequest } from "next/server";
import { ApiError, handleApiError, ok } from "@/lib/api/errors";
import { uuidSchema } from "@/lib/api/validate";
import { requireRoles } from "@/lib/auth/guards";
import { RECEPTION_ROLES } from "@/lib/auth/staff";
import { markBookedArrived } from "@/lib/operations/outpatient";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

/** "Keldi": the patient who paid online is here and joins their doctor's queue at their booked time. */
export async function POST(_request: NextRequest, ctx: RouteContext) {
  try {
    const staff = await requireRoles(...RECEPTION_ROLES);
    const { id } = await ctx.params;
    if (!uuidSchema.safeParse(id).success) throw new ApiError(404, "Tashrif topilmadi", "visit_not_found");
    return ok(await markBookedArrived(staff, id));
  } catch (e) {
    return handleApiError(e);
  }
}

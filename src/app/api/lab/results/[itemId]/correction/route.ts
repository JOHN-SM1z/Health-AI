import type { NextRequest } from "next/server";
import { requireRoles } from "@/lib/auth/guards";
import { LAB_WORK_ROLES } from "@/lib/auth/staff";
import { parseBody, uuidSchema } from "@/lib/api/validate";
import { ApiError, handleApiError, ok } from "@/lib/api/errors";
import { correctionSchema, startCorrection } from "@/lib/labs/results";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ itemId: string }> };

/**
 * Starts a correction of the verified result: a NEW draft version that keeps the old one intact. The caller names the
 * version number they saw (a stale number is a 409) and a reason; the author of the correction is the session's login.
 */
export async function POST(request: NextRequest, ctx: RouteContext) {
  try {
    const staff = await requireRoles(...LAB_WORK_ROLES);
    const { itemId } = await ctx.params;
    if (!uuidSchema.safeParse(itemId).success) throw new ApiError(404, "Topilmadi", "lab_not_found");
    const body = await parseBody(request, correctionSchema);
    return ok(await startCorrection(staff, itemId, body), { status: 201 });
  } catch (e) {
    return handleApiError(e);
  }
}

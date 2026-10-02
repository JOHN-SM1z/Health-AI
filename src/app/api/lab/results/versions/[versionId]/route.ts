import type { NextRequest } from "next/server";
import { requireRoles } from "@/lib/auth/guards";
import { LAB_WORK_ROLES } from "@/lib/auth/staff";
import { parseBody, uuidSchema } from "@/lib/api/validate";
import { ApiError, handleApiError, ok } from "@/lib/api/errors";
import { moveResultVersion, versionActionSchema } from "@/lib/labs/results";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ versionId: string }> };

/** submit (the author), verify, or return to draft. The actor is the session's login; repeating a step is harmless. */
export async function POST(request: NextRequest, ctx: RouteContext) {
  try {
    const staff = await requireRoles(...LAB_WORK_ROLES);
    const { versionId } = await ctx.params;
    if (!uuidSchema.safeParse(versionId).success) throw new ApiError(404, "Topilmadi", "lab_not_found");
    const body = await parseBody(request, versionActionSchema);
    return ok(await moveResultVersion(staff, versionId, body.action));
  } catch (e) {
    return handleApiError(e);
  }
}

import type { NextRequest } from "next/server";
import { requireRoles } from "@/lib/auth/guards";
import { LAB_WORK_ROLES } from "@/lib/auth/staff";
import { parseBody, uuidSchema } from "@/lib/api/validate";
import { ApiError, handleApiError, ok } from "@/lib/api/errors";
import { moveSample, sampleActionSchema } from "@/lib/labs/samples";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * One step of a sample: collect, process, cancel or reject (with a reason). The actor is the session's login;
 * the clinic's payment policy is applied by the database when collecting. Repeating a step is not an error
 * (it reports `unchanged`); a sample collected by someone else is a 409.
 */
export async function POST(request: NextRequest, ctx: RouteContext) {
  try {
    const staff = await requireRoles(...LAB_WORK_ROLES);
    const { id } = await ctx.params;
    if (!uuidSchema.safeParse(id).success) throw new ApiError(404, "Namuna topilmadi", "lab_not_found");
    const body = await parseBody(request, sampleActionSchema);
    return ok(await moveSample(staff, id, body));
  } catch (e) {
    return handleApiError(e);
  }
}

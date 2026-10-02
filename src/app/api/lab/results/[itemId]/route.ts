import type { NextRequest } from "next/server";
import { requireRoles } from "@/lib/auth/guards";
import { LAB_WORK_ROLES } from "@/lib/auth/staff";
import { parseBody, uuidSchema } from "@/lib/api/validate";
import { ApiError, handleApiError, ok } from "@/lib/api/errors";
import { getResultDetail, saveResultDraft, saveResultSchema } from "@/lib/labs/results";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ itemId: string }> };

async function itemId(ctx: RouteContext): Promise<string> {
  const { itemId } = await ctx.params;
  if (!uuidSchema.safeParse(itemId).success) throw new ApiError(404, "Topilmadi", "lab_not_found");
  return itemId;
}

/** One ordered test's result screen: parameters, ranges, the working and the verified version, history. Audited. */
export async function GET(_request: NextRequest, ctx: RouteContext) {
  try {
    const staff = await requireRoles(...LAB_WORK_ROLES);
    return ok({ detail: await getResultDetail(staff, await itemId(ctx)) });
  } catch (e) {
    return handleApiError(e);
  }
}

/**
 * Saves the author's draft (all values as one unit). The body carries parameter ids and what was typed — never a
 * flag, a range, a status, an author or a clinic: the database sets those.
 */
export async function PUT(request: NextRequest, ctx: RouteContext) {
  try {
    const staff = await requireRoles(...LAB_WORK_ROLES);
    const id = await itemId(ctx);
    const body = await parseBody(request, saveResultSchema);
    return ok(await saveResultDraft(staff, id, body));
  } catch (e) {
    return handleApiError(e);
  }
}

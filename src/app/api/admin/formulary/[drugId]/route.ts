import type { NextRequest } from "next/server";
import { requireRoles } from "@/lib/auth/guards";
import { parseBody, uuidSchema } from "@/lib/api/validate";
import { assertSameOrigin } from "@/lib/api/same-origin";
import { ApiError, handleApiError, ok } from "@/lib/api/errors";
import { removeFromFormulary, updateFormularyEntry } from "@/lib/prescribing/catalog";
import { formularyPatchSchema } from "@/lib/prescribing/schemas";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ drugId: string }> };

/** Changes an entry's order or switches it off on the clinic's formulary. */
export async function PATCH(request: NextRequest, ctx: RouteContext) {
  try {
    const staff = await requireRoles("owner", "admin");
    const { drugId } = await ctx.params;
    if (!uuidSchema.safeParse(drugId).success) throw new ApiError(404, "Dori topilmadi", "drug_not_found");
    const body = await parseBody(request, formularyPatchSchema);
    await updateFormularyEntry(staff, drugId, body);
    return ok({ updated: true });
  } catch (e) {
    return handleApiError(e);
  }
}

/** Takes a medicine off the clinic's formulary; the clinic's own entry is retired, never deleted. */
export async function DELETE(request: NextRequest, ctx: RouteContext) {
  try {
    assertSameOrigin(request);
    const staff = await requireRoles("owner", "admin");
    const { drugId } = await ctx.params;
    if (!uuidSchema.safeParse(drugId).success) throw new ApiError(404, "Dori topilmadi", "drug_not_found");
    await removeFromFormulary(staff, drugId);
    return ok({ removed: true });
  } catch (e) {
    return handleApiError(e);
  }
}

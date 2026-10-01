import type { NextRequest } from "next/server";
import { requireRoles } from "@/lib/auth/guards";
import { LAB_WORK_ROLES } from "@/lib/auth/staff";
import { uuidSchema } from "@/lib/api/validate";
import { ApiError, handleApiError, ok } from "@/lib/api/errors";
import { createSamples } from "@/lib/labs/samples";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

/** Prepares the order's samples (one per sample type, awaiting collection). Idempotent. Lab staff only; no body. */
export async function POST(_request: NextRequest, ctx: RouteContext) {
  try {
    const staff = await requireRoles(...LAB_WORK_ROLES);
    const { id } = await ctx.params;
    if (!uuidSchema.safeParse(id).success) throw new ApiError(404, "Buyurtma topilmadi", "lab_not_found");
    return ok(await createSamples(staff, id));
  } catch (e) {
    return handleApiError(e);
  }
}

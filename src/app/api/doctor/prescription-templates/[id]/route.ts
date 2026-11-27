import type { NextRequest } from "next/server";
import { requireLinkedDoctor } from "@/lib/auth/guards";
import { uuidSchema } from "@/lib/api/validate";
import { assertSameOrigin } from "@/lib/api/same-origin";
import { ApiError, handleApiError, ok } from "@/lib/api/errors";
import { deleteTemplate } from "@/lib/prescribing/templates";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

/** Deletes one of the calling doctor's own templates. */
export async function DELETE(request: NextRequest, ctx: RouteContext) {
  try {
    assertSameOrigin(request);
    const doctor = await requireLinkedDoctor();
    const { id } = await ctx.params;
    if (!uuidSchema.safeParse(id).success) throw new ApiError(404, "Shablon topilmadi", "template_not_found");
    await deleteTemplate(doctor, id);
    return ok({ deleted: true });
  } catch (e) {
    return handleApiError(e);
  }
}

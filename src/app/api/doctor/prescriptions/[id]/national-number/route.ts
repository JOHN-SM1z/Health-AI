import type { NextRequest } from "next/server";
import { requireLinkedDoctor } from "@/lib/auth/guards";
import { parseBody, uuidSchema } from "@/lib/api/validate";
import { ApiError, handleApiError, ok } from "@/lib/api/errors";
import { recordNationalRxNumber } from "@/lib/prescribing/prescriptions";
import { nationalNumberSchema } from "@/lib/prescribing/schemas";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * Records the number the national Elektron retsept system gave for the
 * prescription-only items the doctor issued there with their own login.
 */
export async function PUT(request: NextRequest, ctx: RouteContext) {
  try {
    const doctor = await requireLinkedDoctor();
    const { id } = await ctx.params;
    if (!uuidSchema.safeParse(id).success) throw new ApiError(404, "Retsept topilmadi", "prescription_not_found");
    const body = await parseBody(request, nationalNumberSchema);
    await recordNationalRxNumber(doctor, id, body.number);
    return ok({ recorded: true });
  } catch (e) {
    return handleApiError(e);
  }
}

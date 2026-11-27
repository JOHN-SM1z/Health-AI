import type { NextRequest } from "next/server";
import { requireLinkedDoctor } from "@/lib/auth/guards";
import { parseBody, uuidSchema } from "@/lib/api/validate";
import { ApiError, handleApiError, ok } from "@/lib/api/errors";
import { inactivatePatientAllergy } from "@/lib/prescribing/allergies";
import { inactivateAllergySchema } from "@/lib/prescribing/schemas";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string; allergyId: string }> };

/** Marks an allergy inactive with a reason. A recorded allergy is never edited or deleted. */
export async function PATCH(request: NextRequest, ctx: RouteContext) {
  try {
    const doctor = await requireLinkedDoctor();
    const { id, allergyId } = await ctx.params;
    if (!uuidSchema.safeParse(id).success) throw new ApiError(404, "Bemor topilmadi", "patient_not_found");
    if (!uuidSchema.safeParse(allergyId).success) throw new ApiError(404, "Faol allergiya yozuvi topilmadi", "allergy_not_found");
    const body = await parseBody(request, inactivateAllergySchema);
    await inactivatePatientAllergy(doctor, id, allergyId, body.reason);
    return ok({ inactivated: true });
  } catch (e) {
    return handleApiError(e);
  }
}

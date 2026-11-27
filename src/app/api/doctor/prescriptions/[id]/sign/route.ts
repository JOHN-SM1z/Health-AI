import type { NextRequest } from "next/server";
import { requireLinkedDoctor } from "@/lib/auth/guards";
import { parseBody, uuidSchema } from "@/lib/api/validate";
import { ApiError, handleApiError, ok } from "@/lib/api/errors";
import { signPrescription } from "@/lib/prescribing/prescriptions";
import { signPrescriptionSchema } from "@/lib/prescribing/schemas";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * "Imzolash": signs the calling doctor's own draft. The answer is the
 * database's: 200 only once the clinical record is written and the
 * prescription is frozen; 409 `allergy_conflict` lists the items that need
 * the doctor's reason first.
 */
export async function POST(request: NextRequest, ctx: RouteContext) {
  try {
    const doctor = await requireLinkedDoctor();
    const { id } = await ctx.params;
    if (!uuidSchema.safeParse(id).success) throw new ApiError(404, "Retsept topilmadi", "prescription_not_found");
    const body = await parseBody(request, signPrescriptionSchema);
    return ok({ prescription: await signPrescription(doctor, id, body.replaceReason) });
  } catch (e) {
    return handleApiError(e);
  }
}

import type { NextRequest } from "next/server";
import { requireLinkedDoctor } from "@/lib/auth/guards";
import { parseBody, uuidSchema } from "@/lib/api/validate";
import { ApiError, handleApiError, ok } from "@/lib/api/errors";
import { cancelPrescription } from "@/lib/prescribing/prescriptions";
import { cancelPrescriptionSchema } from "@/lib/prescribing/schemas";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

/** Cancels the calling doctor's own signed prescription with a reason. Nothing is deleted. */
export async function POST(request: NextRequest, ctx: RouteContext) {
  try {
    const doctor = await requireLinkedDoctor();
    const { id } = await ctx.params;
    if (!uuidSchema.safeParse(id).success) throw new ApiError(404, "Retsept topilmadi", "prescription_not_found");
    const body = await parseBody(request, cancelPrescriptionSchema);
    await cancelPrescription(doctor, id, body.reason);
    return ok({ cancelled: true });
  } catch (e) {
    return handleApiError(e);
  }
}

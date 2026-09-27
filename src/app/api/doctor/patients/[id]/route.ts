import type { NextRequest } from "next/server";
import { requireLinkedDoctor } from "@/lib/auth/guards";
import { uuidSchema } from "@/lib/api/validate";
import { ApiError, handleApiError, ok } from "@/lib/api/errors";
import { getPatientClinicalRecord } from "@/lib/clinical-access/access";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * A patient's clinical record as the calling doctor may see it: their own
 * patient, or one actively referred to them. Anything else — including an id
 * from another clinic or a malformed id — is 404.
 */
export async function GET(_request: NextRequest, ctx: RouteContext) {
  try {
    const doctor = await requireLinkedDoctor();
    const { id } = await ctx.params;
    if (!uuidSchema.safeParse(id).success) throw new ApiError(404, "Bemor topilmadi", "patient_not_found");
    return ok({ record: await getPatientClinicalRecord(doctor, id) });
  } catch (e) {
    return handleApiError(e);
  }
}

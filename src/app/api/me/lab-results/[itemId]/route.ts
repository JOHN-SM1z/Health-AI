import type { NextRequest } from "next/server";
import { ApiError, handleApiError, ok } from "@/lib/api/errors";
import { uuidSchema } from "@/lib/api/validate";
import { getPatientLabResult } from "@/lib/labs/patient-results";
import { requireMiniAppPatient } from "@/lib/patients/mini-app-patient";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ itemId: string }> };

/** One of the patient's own verified results with values against the configured range (audited). */
export async function POST(request: NextRequest, ctx: RouteContext) {
  try {
    const { clinicId, patientId } = await requireMiniAppPatient(request, "my-lab-result");
    const { itemId } = await ctx.params;
    if (!uuidSchema.safeParse(itemId).success) throw new ApiError(404, "Natija topilmadi", "result_not_found");
    return ok({ result: await getPatientLabResult(clinicId, patientId, itemId) });
  } catch (e) {
    return handleApiError(e);
  }
}

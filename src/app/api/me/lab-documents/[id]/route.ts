import type { NextRequest } from "next/server";
import { ApiError, handleApiError, ok } from "@/lib/api/errors";
import { uuidSchema } from "@/lib/api/validate";
import { getPatientDocumentLink } from "@/lib/labs/patient-results";
import { requireMiniAppPatient } from "@/lib/patients/mini-app-patient";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

/** A 60-second download link to a document of the patient's own verified result (audited). */
export async function POST(request: NextRequest, ctx: RouteContext) {
  try {
    const { clinicId, patientId } = await requireMiniAppPatient(request, "my-lab-document");
    const { id } = await ctx.params;
    if (!uuidSchema.safeParse(id).success) throw new ApiError(404, "Hujjat topilmadi", "document_not_found");
    return ok(await getPatientDocumentLink(clinicId, patientId, id));
  } catch (e) {
    return handleApiError(e);
  }
}

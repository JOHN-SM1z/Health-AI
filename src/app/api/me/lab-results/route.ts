import type { NextRequest } from "next/server";
import { handleApiError, ok } from "@/lib/api/errors";
import { listPatientLabResults } from "@/lib/labs/patient-results";
import { requireMiniAppPatient } from "@/lib/patients/mini-app-patient";

export const dynamic = "force-dynamic";

/** The patient's own verified lab results (names and dates; values only on the detail page). */
export async function POST(request: NextRequest) {
  try {
    const { clinicId, patientId } = await requireMiniAppPatient(request, "my-lab-results");
    return ok(await listPatientLabResults(clinicId, patientId));
  } catch (e) {
    return handleApiError(e);
  }
}

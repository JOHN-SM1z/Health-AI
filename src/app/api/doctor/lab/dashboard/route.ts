import { requireLinkedDoctor } from "@/lib/auth/guards";
import { handleApiError, ok } from "@/lib/api/errors";
import { getDoctorLabDashboard } from "@/lib/labs/doctor-dashboard";

export const dynamic = "force-dynamic";

/** The calling doctor's laboratory dashboard (Phase 17): only patients doctor_patient_access() admits. */
export async function GET() {
  try {
    const doctor = await requireLinkedDoctor();
    return ok(await getDoctorLabDashboard(doctor));
  } catch (e) {
    return handleApiError(e);
  }
}

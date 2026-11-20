import type { NextRequest } from "next/server";
import { requireLinkedDoctor } from "@/lib/auth/guards";
import { ApiError, handleApiError, ok } from "@/lib/api/errors";
import { uuidSchema } from "@/lib/api/validate";
import { getReferralForDoctor } from "@/lib/referrals/service";
import { getPatientWorkspace } from "@/lib/clinical-access/workspace";

export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };

/** Referral membership does not widen history: the workspace rechecks the
 * authoritative DB access decision, including expiry, before any record read. */
export async function GET(_request: NextRequest, context: Context) {
  try {
    const doctor = await requireLinkedDoctor();
    const { id } = await context.params;
    if (!uuidSchema.safeParse(id).success) throw new ApiError(404, "Yo‘llanma topilmadi", "referral_not_found");
    const referral = await getReferralForDoctor(doctor, id);
    const workspace = await getPatientWorkspace(doctor, referral.patientId);
    return ok({ patient: workspace.patient, referral, notes: workspace.records, appointments: workspace.appointments },
      { headers: { "Cache-Control": "private, no-store" } });
  } catch (e) { return handleApiError(e); }
}

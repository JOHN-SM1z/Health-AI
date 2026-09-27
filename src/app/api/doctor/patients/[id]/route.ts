import type { NextRequest } from "next/server";
import { requireLinkedDoctor } from "@/lib/auth/guards";
import { uuidSchema } from "@/lib/api/validate";
import { ApiError, handleApiError, ok } from "@/lib/api/errors";
import { rateLimit } from "@/lib/rate-limit";
import { getPatientWorkspace } from "@/lib/clinical-access/workspace";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

// Per doctor: ample for looking through patients, slows down id guessing
// (and the audit rows every refusal writes).
const LOOKUPS_PER_MINUTE = 60;

/**
 * A patient's clinical workspace as the calling doctor may see it: their own
 * patient, or one actively referred to them — consultations, clinical records
 * with provenance, referrals and what the doctor can start. A referral of
 * theirs that lapsed is 410 with the reason; anything else — including an id
 * from another clinic or a malformed id — is 404.
 */
export async function GET(_request: NextRequest, ctx: RouteContext) {
  try {
    const doctor = await requireLinkedDoctor();
    const limit = rateLimit({ key: `doctor-patient-record:${doctor.profileId}`, limit: LOOKUPS_PER_MINUTE, windowMs: 60_000 });
    if (!limit.ok) throw new ApiError(429, "Juda ko‘p so‘rov, birozdan keyin urinib ko‘ring", "rate_limited");

    const { id } = await ctx.params;
    if (!uuidSchema.safeParse(id).success) throw new ApiError(404, "Bemor topilmadi", "patient_not_found");
    return ok({ record: await getPatientWorkspace(doctor, id) });
  } catch (e) {
    return handleApiError(e);
  }
}

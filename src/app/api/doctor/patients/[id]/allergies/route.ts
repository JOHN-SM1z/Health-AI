import type { NextRequest } from "next/server";
import { requireLinkedDoctor } from "@/lib/auth/guards";
import { parseBody, uuidSchema } from "@/lib/api/validate";
import { ApiError, handleApiError, ok } from "@/lib/api/errors";
import { sharedRateLimit } from "@/lib/rate-limit-shared";
import { listPatientAllergies, recordPatientAllergy } from "@/lib/prescribing/allergies";
import { allergySchema } from "@/lib/prescribing/schemas";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

const READS_PER_MINUTE = 60;

/** The allergies on the card of a patient the calling doctor treats (own patient or active referral). */
export async function GET(_request: NextRequest, ctx: RouteContext) {
  try {
    const doctor = await requireLinkedDoctor();
    const limit = await sharedRateLimit({ key: `doctor-patient-allergies:${doctor.profileId}`, limit: READS_PER_MINUTE, windowMs: 60_000 });
    if (!limit.ok) throw new ApiError(429, "Juda ko‘p so‘rov, birozdan keyin urinib ko‘ring", "rate_limited");
    const { id } = await ctx.params;
    if (!uuidSchema.safeParse(id).success) throw new ApiError(404, "Bemor topilmadi", "patient_not_found");
    return ok({ allergies: await listPatientAllergies(doctor, id) }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (e) {
    return handleApiError(e);
  }
}

/** The calling doctor records an allergy. The recorder, the clinic and the time are set by the server. */
export async function POST(request: NextRequest, ctx: RouteContext) {
  try {
    const doctor = await requireLinkedDoctor();
    const { id } = await ctx.params;
    if (!uuidSchema.safeParse(id).success) throw new ApiError(404, "Bemor topilmadi", "patient_not_found");
    const body = await parseBody(request, allergySchema);
    const allergy = await recordPatientAllergy(doctor, id, body);
    return ok({ allergy }, { status: allergy.replayed ? 200 : 201 });
  } catch (e) {
    return handleApiError(e);
  }
}

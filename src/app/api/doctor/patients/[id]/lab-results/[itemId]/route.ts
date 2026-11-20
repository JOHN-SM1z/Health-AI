import type { NextRequest } from "next/server";
import { requireLinkedDoctor } from "@/lib/auth/guards";
import { uuidSchema } from "@/lib/api/validate";
import { ApiError, handleApiError, ok } from "@/lib/api/errors";
import { getVerifiedLabResultForDoctor } from "@/lib/labs/ordering";
import { sharedRateLimit } from "@/lib/rate-limit-shared";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string; itemId: string }> };

/** The verified result of one of the patient's lab tests; every read is audited. */
export async function GET(_request: NextRequest, ctx: RouteContext) {
  try {
    const doctor = await requireLinkedDoctor();
    const limit = await sharedRateLimit({ key: `doctor-lab-result:${doctor.profileId}`, limit: 60, windowMs: 60_000 });
    if (!limit.ok) throw new ApiError(429, "Juda ko‘p so‘rov, birozdan keyin urinib ko‘ring", "rate_limited");
    const { id, itemId } = await ctx.params;
    if (!uuidSchema.safeParse(id).success || !uuidSchema.safeParse(itemId).success) {
      throw new ApiError(404, "Natija topilmadi", "result_not_found");
    }
    return ok({ result: await getVerifiedLabResultForDoctor(doctor, id, itemId) });
  } catch (e) {
    return handleApiError(e);
  }
}

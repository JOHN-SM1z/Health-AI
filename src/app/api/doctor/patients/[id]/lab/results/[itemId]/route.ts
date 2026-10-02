import type { NextRequest } from "next/server";
import { requireLinkedDoctor } from "@/lib/auth/guards";
import { uuidSchema } from "@/lib/api/validate";
import { ApiError, handleApiError, ok } from "@/lib/api/errors";
import { sharedRateLimit } from "@/lib/rate-limit-shared";
import { getFinalisedLabResult } from "@/lib/labs/longitudinal";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string; itemId: string }> };

/**
 * One finalised result: values with the configured reference range and flag, its earlier finalised versions (corrections keep the
 * old version), who entered and verified each, dates (ordered, collected, verified) and documents. Read-only for every doctor -
 * there is no write method on this route, and the laboratory routes admit laboratory staff only.
 */
export async function GET(_request: NextRequest, ctx: RouteContext) {
  try {
    const doctor = await requireLinkedDoctor();
    const limit = await sharedRateLimit({ key: `doctor-lab-lookup:${doctor.profileId}`, limit: 60, windowMs: 60_000 });
    if (!limit.ok) throw new ApiError(429, "Juda ko‘p so‘rov, birozdan keyin urinib ko‘ring", "rate_limited");
    const { id, itemId } = await ctx.params;
    if (!uuidSchema.safeParse(id).success) throw new ApiError(404, "Bemor topilmadi", "patient_not_found");
    if (!uuidSchema.safeParse(itemId).success) throw new ApiError(404, "Natija topilmadi", "lab_not_found");
    return ok({ result: await getFinalisedLabResult(doctor, id, itemId) });
  } catch (e) {
    return handleApiError(e);
  }
}

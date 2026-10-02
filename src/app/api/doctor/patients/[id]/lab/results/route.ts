import type { NextRequest } from "next/server";
import { requireLinkedDoctor } from "@/lib/auth/guards";
import { uuidSchema } from "@/lib/api/validate";
import { ApiError, handleApiError, ok } from "@/lib/api/errors";
import { sharedRateLimit } from "@/lib/rate-limit-shared";
import { listFinalisedLabResults } from "@/lib/labs/longitudinal";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * The patient's FINALISED laboratory results (summaries, no values), every doctor's, as part of the longitudinal record. Reachable
 * only through the clinical access decision (404/410 otherwise, audited) and read-only: drafts, unverified and abandoned work never
 * appear. Every read is audited (ids only).
 */
export async function GET(_request: NextRequest, ctx: RouteContext) {
  try {
    const doctor = await requireLinkedDoctor();
    const limit = await sharedRateLimit({ key: `doctor-lab-lookup:${doctor.profileId}`, limit: 60, windowMs: 60_000 });
    if (!limit.ok) throw new ApiError(429, "Juda ko‘p so‘rov, birozdan keyin urinib ko‘ring", "rate_limited");
    const { id } = await ctx.params;
    if (!uuidSchema.safeParse(id).success) throw new ApiError(404, "Bemor topilmadi", "patient_not_found");
    return ok({ results: await listFinalisedLabResults(doctor, id) });
  } catch (e) {
    return handleApiError(e);
  }
}

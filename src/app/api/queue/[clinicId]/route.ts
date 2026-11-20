import type { NextRequest } from "next/server";
import { ApiError, handleApiError, ok } from "@/lib/api/errors";
import { uuidSchema } from "@/lib/api/validate";
import { sharedRateLimit } from "@/lib/rate-limit-shared";
import { publicQueue } from "@/lib/operations/outpatient";

export const dynamic = "force-dynamic";
type RouteContext = { params: Promise<{ clinicId: string }> };

/**
 * The waiting-room screen: called and waiting queue numbers per doctor.
 * Public by design (it is what the hall display shows) — numbers and doctor
 * names only, never a patient's name, id or anything clinical.
 */
export async function GET(request: NextRequest, ctx: RouteContext) {
  try {
    const { clinicId } = await ctx.params;
    if (!uuidSchema.safeParse(clinicId).success) throw new ApiError(404, "Topilmadi", "not_found");
    const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
    const limit = await sharedRateLimit({ key: `queue-screen:${clinicId}:${ip}`, limit: 120, windowMs: 60_000 });
    if (!limit.ok) throw new ApiError(429, "Juda ko‘p so‘rov", "rate_limited");
    const queue = await publicQueue(clinicId);
    if (!queue) throw new ApiError(404, "Topilmadi", "not_found");
    return ok({ ...queue, at: new Date().toISOString() });
  } catch (e) {
    return handleApiError(e);
  }
}

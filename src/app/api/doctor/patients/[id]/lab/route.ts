import type { NextRequest } from "next/server";
import { requireLinkedDoctor } from "@/lib/auth/guards";
import { uuidSchema } from "@/lib/api/validate";
import { ApiError, handleApiError, ok } from "@/lib/api/errors";
import { sharedRateLimit } from "@/lib/rate-limit-shared";
import { listPatientLabOrders } from "@/lib/labs/ordering";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * The patient's laboratory orders — every doctor's, as the longitudinal record — with each test's status and
 * whether a verified result exists. Reachable only through the clinical access decision (404/410 otherwise)
 * and audited on every read. Result VALUES are not part of this response (phase 7 adds the result view).
 */
export async function GET(_request: NextRequest, ctx: RouteContext) {
  try {
    const doctor = await requireLinkedDoctor();
    const limit = await sharedRateLimit({ key: `doctor-lab-lookup:${doctor.profileId}`, limit: 60, windowMs: 60_000 });
    if (!limit.ok) throw new ApiError(429, "Juda ko‘p so‘rov, birozdan keyin urinib ko‘ring", "rate_limited");
    const { id } = await ctx.params;
    if (!uuidSchema.safeParse(id).success) throw new ApiError(404, "Bemor topilmadi", "patient_not_found");
    return ok({ orders: await listPatientLabOrders(doctor, id) });
  } catch (e) {
    return handleApiError(e);
  }
}

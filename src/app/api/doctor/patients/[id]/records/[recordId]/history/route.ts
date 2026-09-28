import type { NextRequest } from "next/server";
import { requireLinkedDoctor } from "@/lib/auth/guards";
import { uuidSchema } from "@/lib/api/validate";
import { ApiError, handleApiError, ok } from "@/lib/api/errors";
import { sharedRateLimit } from "@/lib/rate-limit-shared";
import { getClinicalRecordHistory } from "@/lib/clinical-records/service";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string; recordId: string }> };

// Shares the workspace's per-doctor budget: history is part of reading a
// patient's records.
const LOOKUPS_PER_MINUTE = 60;

/**
 * Every version of a record the calling doctor may see, oldest first —
 * read-only (there is no write on this path) and audited. 404 for a record
 * the doctor may not see, whether or not it exists.
 */
export async function GET(_request: NextRequest, ctx: RouteContext) {
  try {
    const doctor = await requireLinkedDoctor();
    const limit = await sharedRateLimit({ key: `doctor-patient-record:${doctor.profileId}`, limit: LOOKUPS_PER_MINUTE, windowMs: 60_000 });
    if (!limit.ok) throw new ApiError(429, "Juda ko‘p so‘rov, birozdan keyin urinib ko‘ring", "rate_limited");

    const { id, recordId } = await ctx.params;
    if (!uuidSchema.safeParse(id).success) throw new ApiError(404, "Bemor topilmadi", "patient_not_found");
    if (!uuidSchema.safeParse(recordId).success) throw new ApiError(404, "Yozuv topilmadi", "record_not_found");
    return ok({ history: await getClinicalRecordHistory(doctor, id, recordId) });
  } catch (e) {
    return handleApiError(e);
  }
}

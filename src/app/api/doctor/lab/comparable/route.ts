import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireLinkedDoctor } from "@/lib/auth/guards";
import { parseBody, uuidSchema } from "@/lib/api/validate";
import { ApiError, handleApiError, ok } from "@/lib/api/errors";
import { sharedRateLimit } from "@/lib/rate-limit-shared";
import { findSimilarRecentTests } from "@/lib/labs/ordering";

export const dynamic = "force-dynamic";

const schema = z
  .object({
    patientId: uuidSchema,
    testIds: z.array(uuidSchema).max(50).default([]),
    panelIds: z.array(uuidSchema).max(20).default([]),
  })
  .strict();

/**
 * The advisory "similar test N days ago" notice for a selection, before ordering. It never blocks or
 * recommends anything and carries no result value; the doctor decides. POST only because the selection is
 * a list — it changes nothing (and, like every read of a patient's history, it is audited).
 */
export async function POST(request: NextRequest) {
  try {
    const doctor = await requireLinkedDoctor();
    const limit = await sharedRateLimit({ key: `doctor-lab-lookup:${doctor.profileId}`, limit: 60, windowMs: 60_000 });
    if (!limit.ok) throw new ApiError(429, "Juda ko‘p so‘rov, birozdan keyin urinib ko‘ring", "rate_limited");
    const body = await parseBody(request, schema);
    return ok({ notices: await findSimilarRecentTests(doctor, body.patientId, { testIds: body.testIds, panelIds: body.panelIds }) });
  } catch (e) {
    return handleApiError(e);
  }
}

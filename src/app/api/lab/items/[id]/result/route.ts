import type { NextRequest } from "next/server";
import { z } from "zod";
import { ApiError, handleApiError, ok } from "@/lib/api/errors";
import { parseBody, uuidSchema } from "@/lib/api/validate";
import { requireLabCapability } from "@/lib/labs/guards";
import { getResultEntry, saveResultDraft } from "@/lib/labs/results";
import { sharedRateLimit } from "@/lib/rate-limit-shared";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

async function itemIdOf(ctx: RouteContext): Promise<string> {
  const { id } = await ctx.params;
  if (!uuidSchema.safeParse(id).success) throw new ApiError(404, "Tahlil topilmadi", "not_found");
  return id;
}

/** The test's parameters with the applicable ranges and the current result being entered (audited read). */
export async function GET(_request: NextRequest, ctx: RouteContext) {
  try {
    const staff = await requireLabCapability("result.enter");
    const limit = await sharedRateLimit({ key: `lab-result-entry:${staff.profileId}`, limit: 120, windowMs: 60_000 });
    if (!limit.ok) throw new ApiError(429, "Juda ko‘p so‘rov, birozdan keyin urinib ko‘ring", "rate_limited");
    return ok({ entry: await getResultEntry(staff, await itemIdOf(ctx)) });
  } catch (e) {
    return handleApiError(e);
  }
}

// Values by parameter id; empty / null clears. Unit, range and flag are the database's.
const saveSchema = z.object({
  values: z
    .array(z.object({ parameterId: uuidSchema, value: z.union([z.string().max(500), z.boolean(), z.null()]) }))
    .max(200),
  labComment: z.string().trim().max(1000).nullable().optional(),
});

/** Saves the caller's draft result for this test (created on first save). */
export async function PUT(request: NextRequest, ctx: RouteContext) {
  try {
    const staff = await requireLabCapability("result.enter");
    const itemId = await itemIdOf(ctx);
    const body = await parseBody(request, saveSchema);
    const result = await saveResultDraft(staff, itemId, { values: body.values, labComment: body.labComment || null });
    return ok(result, { status: result.created ? 201 : 200 });
  } catch (e) {
    return handleApiError(e);
  }
}

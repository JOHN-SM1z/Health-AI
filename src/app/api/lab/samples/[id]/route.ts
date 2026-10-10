import type { NextRequest } from "next/server";
import { z } from "zod";
import { ApiError, handleApiError, ok } from "@/lib/api/errors";
import { parseBody, uuidSchema } from "@/lib/api/validate";
import { requireLabCapability } from "@/lib/labs/guards";
import { receiveSample, rejectSample } from "@/lib/labs/collection";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

const schema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("receive") }),
  z.object({ action: z.literal("reject"), reason: z.string().trim().min(1).max(300) }),
]);

/** The lab receives a sample (its tests move to processing) or rejects it (tests return for a new sample). */
export async function POST(request: NextRequest, ctx: RouteContext) {
  try {
    const staff = await requireLabCapability("sample.process");
    const { id } = await ctx.params;
    if (!uuidSchema.safeParse(id).success) throw new ApiError(404, "Namuna topilmadi", "sample_not_found");
    const body = await parseBody(request, schema);
    const result = body.action === "receive" ? await receiveSample(staff, id) : await rejectSample(staff, id, body.reason);
    return ok(result);
  } catch (e) {
    return handleApiError(e);
  }
}

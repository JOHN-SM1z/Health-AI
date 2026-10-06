import type { NextRequest } from "next/server";
import { z } from "zod";
import { ApiError, handleApiError, ok } from "@/lib/api/errors";
import { parseBody, uuidSchema } from "@/lib/api/validate";
import { requireLabCapability } from "@/lib/labs/guards";
import { discardDraft, submitResult } from "@/lib/labs/results";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

const schema = z.object({ action: z.enum(["submit", "discard"]) });

/**
 * submit: the author sends a complete draft for second-person verification.
 * discard: any authorized staff member discards a draft (audited).
 */
export async function POST(request: NextRequest, ctx: RouteContext) {
  try {
    const staff = await requireLabCapability("result.enter");
    const { id } = await ctx.params;
    if (!uuidSchema.safeParse(id).success) throw new ApiError(404, "Natija topilmadi", "result_not_found");
    const body = await parseBody(request, schema);
    return ok(body.action === "submit" ? await submitResult(staff, id) : await discardDraft(staff, id));
  } catch (e) {
    return handleApiError(e);
  }
}

import type { NextRequest } from "next/server";
import { z } from "zod";
import { ApiError, handleApiError, ok } from "@/lib/api/errors";
import { parseBody, uuidSchema } from "@/lib/api/validate";
import { requireLabCapability } from "@/lib/labs/guards";
import { discardDraft, returnResult, startCorrection, submitResult, verifyResult } from "@/lib/labs/results";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

const schema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("submit") }),
  z.object({ action: z.literal("discard") }),
  z.object({ action: z.literal("verify") }),
  z.object({ action: z.literal("return") }),
  z.object({ action: z.literal("correct"), reason: z.string().trim().min(1).max(300) }),
]);

/**
 * submit:  the author sends a complete draft for second-person verification.
 * discard: an authorized staff member discards a draft (audited).
 * verify:  a second person verifies a submitted result (clinic verifier setting applies).
 * return:  a reviewer, or the author, sends a submitted result back as a draft.
 * correct: starts a new version of the current verified result (reason required).
 * Every action is checked again by the database in one locked transaction.
 */
export async function POST(request: NextRequest, ctx: RouteContext) {
  try {
    const staff = await requireLabCapability("result.enter");
    const { id } = await ctx.params;
    if (!uuidSchema.safeParse(id).success) throw new ApiError(404, "Natija topilmadi", "result_not_found");
    const body = await parseBody(request, schema);
    switch (body.action) {
      case "submit":
        return ok(await submitResult(staff, id));
      case "discard":
        return ok(await discardDraft(staff, id));
      case "verify":
        return ok(await verifyResult(await requireLabCapability("result.verify"), id));
      case "return":
        return ok(await returnResult(staff, id));
      case "correct": {
        const result = await startCorrection(staff, id, body.reason);
        return ok(result, { status: result.created ? 201 : 200 });
      }
    }
  } catch (e) {
    return handleApiError(e);
  }
}

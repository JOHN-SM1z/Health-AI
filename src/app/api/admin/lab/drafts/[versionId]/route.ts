import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireLabConfig } from "@/lib/labs/access";
import { parseBody, uuidSchema } from "@/lib/api/validate";
import { ApiError, handleApiError, ok } from "@/lib/api/errors";
import { moveResultVersion } from "@/lib/labs/results";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ versionId: string }> };
const schema = z.object({ action: z.literal("abandon"), reason: z.string().trim().min(3).max(300) }).strict();

/**
 * Owner/admin/manager abandon an ORPHANED draft (never delete: the draft stays, cancelled, with who, when and why). The database
 * refuses it for a draft whose holder is still active. Management cannot take a draft over: that would be writing a clinical value.
 */
export async function POST(request: NextRequest, ctx: RouteContext) {
  try {
    const staff = await requireLabConfig();
    const { versionId } = await ctx.params;
    if (!uuidSchema.safeParse(versionId).success) throw new ApiError(404, "Topilmadi", "lab_not_found");
    const body = await parseBody(request, schema);
    return ok(await moveResultVersion(staff, versionId, body));
  } catch (e) {
    return handleApiError(e);
  }
}

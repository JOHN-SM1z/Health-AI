import type { NextRequest } from "next/server";
import { z } from "zod";
import { ApiError, handleApiError, ok } from "@/lib/api/errors";
import { parseBody, uuidSchema } from "@/lib/api/validate";
import { requireLabCapability } from "@/lib/labs/guards";
import { cancelSendOut } from "@/lib/labs/providers/service";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

const schema = z.object({ action: z.literal("cancel") });

/** Stops a live send-out (lab staff); the lab may then enter the result itself. */
export async function POST(request: NextRequest, ctx: RouteContext) {
  try {
    const staff = await requireLabCapability("sample.process");
    const { id } = await ctx.params;
    if (!uuidSchema.safeParse(id).success) throw new ApiError(404, "Yuborish topilmadi", "not_found");
    await parseBody(request, schema);
    return ok(await cancelSendOut(staff, id));
  } catch (e) {
    return handleApiError(e);
  }
}

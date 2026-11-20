import type { NextRequest } from "next/server";
import { z } from "zod";
import { ApiError, handleApiError, ok } from "@/lib/api/errors";
import { parseBody, uuidSchema } from "@/lib/api/validate";
import { requireLabCapability } from "@/lib/labs/guards";
import { setProviderCodes } from "@/lib/labs/providers/service";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

const schema = z.object({
  codes: z
    .array(z.object({ kind: z.enum(["test", "parameter"]), internalId: uuidSchema, externalCode: z.string().trim().min(1).max(64) }))
    .max(2000),
});

/** Replaces the provider's codes for the clinic's tests and parameters (catalog.configure). */
export async function PUT(request: NextRequest, ctx: RouteContext) {
  try {
    const staff = await requireLabCapability("catalog.configure");
    const { id } = await ctx.params;
    if (!uuidSchema.safeParse(id).success) throw new ApiError(404, "Laboratoriya topilmadi", "provider_not_found");
    return ok(await setProviderCodes(staff, id, (await parseBody(request, schema)).codes));
  } catch (e) {
    return handleApiError(e);
  }
}

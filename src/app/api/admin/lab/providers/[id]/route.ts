import type { NextRequest } from "next/server";
import { ApiError, handleApiError, ok } from "@/lib/api/errors";
import { parseBody, uuidSchema } from "@/lib/api/validate";
import { requireLabCapability } from "@/lib/labs/guards";
import { updateProvider } from "@/lib/labs/providers/service";
import { providerSchema } from "@/lib/labs/providers/schema";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

export async function PATCH(request: NextRequest, ctx: RouteContext) {
  try {
    const staff = await requireLabCapability("catalog.configure");
    const { id } = await ctx.params;
    if (!uuidSchema.safeParse(id).success) throw new ApiError(404, "Laboratoriya topilmadi", "provider_not_found");
    return ok(await updateProvider(staff, id, await parseBody(request, providerSchema)));
  } catch (e) {
    return handleApiError(e);
  }
}

import type { NextRequest } from "next/server";
import { z } from "zod";
import { ApiError, handleApiError, ok } from "@/lib/api/errors";
import { parseBody, uuidSchema } from "@/lib/api/validate";
import { requireLabCapability } from "@/lib/labs/guards";
import { collectSample } from "@/lib/labs/collection";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

// Which tests the tube serves; the sample type, patient and code come from the database.
const schema = z.object({
  idempotencyKey: uuidSchema,
  itemIds: z.array(uuidSchema).min(1).max(50),
  notes: z.string().trim().max(500).nullable().optional(),
});

/** Records one collected sample for tests of this order (reception, lab). */
export async function POST(request: NextRequest, ctx: RouteContext) {
  try {
    const staff = await requireLabCapability("sample.collect");
    const { id } = await ctx.params;
    if (!uuidSchema.safeParse(id).success) throw new ApiError(404, "Buyurtma topilmadi", "order_not_found");
    const body = await parseBody(request, schema);
    const result = await collectSample(staff, id, {
      itemIds: body.itemIds,
      notes: body.notes || null,
      creationKey: body.idempotencyKey,
    });
    return ok(result, { status: result.replayed ? 200 : 201 });
  } catch (e) {
    return handleApiError(e);
  }
}

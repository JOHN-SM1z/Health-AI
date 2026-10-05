import type { NextRequest } from "next/server";
import { z } from "zod";
import { ApiError, handleApiError, ok } from "@/lib/api/errors";
import { parseBody, uuidSchema } from "@/lib/api/validate";
import { requireLabCapability } from "@/lib/labs/guards";
import { changeLabPayment } from "@/lib/labs/payments";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

// Only a status and how it was paid: the amount always comes from the order.
const schema = z.object({
  status: z.enum(["paid", "refunded", "manual_review", "failed"]),
  method: z.enum(["cash", "card_terminal"]).optional(),
});

/** Records a desk payment / refund for a lab order (owner, admin — the existing payment roles). */
export async function POST(request: NextRequest, ctx: RouteContext) {
  try {
    const staff = await requireLabCapability("finance.view");
    const { id } = await ctx.params;
    if (!uuidSchema.safeParse(id).success) throw new ApiError(404, "To‘lov topilmadi", "payment_not_found");
    const body = await parseBody(request, schema);
    const result = await changeLabPayment(staff, id, body);
    return ok({ updated: true, alreadyInState: result.alreadyInState ?? false });
  } catch (e) {
    return handleApiError(e);
  }
}

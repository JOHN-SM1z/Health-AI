import type { NextRequest } from "next/server";
import { z } from "zod";
import { ApiError, handleApiError, ok } from "@/lib/api/errors";
import { parseBody, uuidSchema } from "@/lib/api/validate";
import { requireRoles } from "@/lib/auth/guards";
import { markRefundDone } from "@/lib/payments/online/service";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };
const schema = z.object({ reference: z.string().trim().min(3).max(120) });

/**
 * Owner/manager: the money went back through the payment provider's cabinet — record it with the provider's refund
 * reference. (Automatic refunds come with the provider's refund API.)
 */
export async function POST(request: NextRequest, ctx: RouteContext) {
  try {
    const staff = await requireRoles("owner", "manager");
    const { id } = await ctx.params;
    if (!uuidSchema.safeParse(id).success) throw new ApiError(404, "Qaytarish topilmadi", "refund_not_found");
    const body = await parseBody(request, schema);
    return ok(await markRefundDone(staff, id, body.reference));
  } catch (e) {
    return handleApiError(e);
  }
}

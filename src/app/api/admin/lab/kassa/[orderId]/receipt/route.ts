import type { NextRequest } from "next/server";
import { requireRoles } from "@/lib/auth/guards";
import { LAB_KASSA_READ_ROLES } from "@/lib/auth/staff";
import { uuidSchema } from "@/lib/api/validate";
import { ApiError, handleApiError, ok } from "@/lib/api/errors";
import { buildLabReceipt } from "@/lib/labs/kassa";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ orderId: string }> };

/** The payment confirmation of a laboratory order (not a fiscal receipt) — only once the payment was received. */
export async function GET(_request: NextRequest, ctx: RouteContext) {
  try {
    const staff = await requireRoles(...LAB_KASSA_READ_ROLES);
    const { orderId } = await ctx.params;
    if (!uuidSchema.safeParse(orderId).success) throw new ApiError(404, "Buyurtma topilmadi", "lab_not_found");
    return ok({ receipt: await buildLabReceipt(staff.clinicId, orderId) });
  } catch (e) {
    return handleApiError(e);
  }
}

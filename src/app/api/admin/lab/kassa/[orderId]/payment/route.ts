import type { NextRequest } from "next/server";
import { requireRoles } from "@/lib/auth/guards";
import { LAB_PAYMENT_CONFIRM_ROLES, LAB_REFUND_ROLES, hasAnyRole } from "@/lib/auth/staff";
import { parseBody, uuidSchema } from "@/lib/api/validate";
import { ApiError, handleApiError, ok } from "@/lib/api/errors";
import { confirmLabPayment, paymentActionSchema, refundLabPayment } from "@/lib/labs/kassa";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ orderId: string }> };

/**
 * Staff record that a laboratory order was paid, or refund it. The body carries only the action and a coded
 * method/reason — never an amount, a currency or a status: the amount is what the server computed when the
 * order was written, and the status change is the existing payment engine's (legal transitions only).
 * Confirming is for the cashier roles; refunding for owner/admin.
 */
export async function POST(request: NextRequest, ctx: RouteContext) {
  try {
    // Who is asking is settled before anything about the request is read; a refund then needs the narrower set.
    const staff = await requireRoles(...LAB_PAYMENT_CONFIRM_ROLES);
    const { orderId } = await ctx.params;
    if (!uuidSchema.safeParse(orderId).success) throw new ApiError(404, "Buyurtma topilmadi", "lab_not_found");
    const body = await parseBody(request, paymentActionSchema);
    if (body.action === "refund" && !hasAnyRole(staff.roles, LAB_REFUND_ROLES)) throw new ApiError(403, "Bu amal uchun ruxsat yo‘q", "forbidden");
    const result =
      body.action === "confirm" ? await confirmLabPayment(staff, orderId, body.method) : await refundLabPayment(staff, orderId, body.reason);
    return ok(result);
  } catch (e) {
    return handleApiError(e);
  }
}

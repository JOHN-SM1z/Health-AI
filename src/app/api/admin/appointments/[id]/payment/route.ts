import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireRoles } from "@/lib/auth/guards";
import { hasAnyRole } from "@/lib/auth/staff";
import { parseBody } from "@/lib/api/validate";
import { handleApiError, ApiError, ok } from "@/lib/api/errors";
import { transitionPaymentStatus } from "@/lib/payments/status";
import { isManualPaymentMode } from "@/lib/payments/provider";

export const dynamic = "force-dynamic";

const schema = z
  .object({
    status: z.enum(["paid", "refunded", "manual_review", "failed"]),
    // Only meaningful (and required) for "paid": how the payment was
    // actually collected. "click"/"payme" are provider-driven via their own
    // signed webhooks and are never staff-selected here.
    provider: z.enum(["cash", "card_terminal", "manual"]).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.status === "paid" && !v.provider) {
      ctx.addIssue({ code: "custom", message: "To‘lov usulini tanlang", path: ["provider"] });
    }
  });

type RouteContext = { params: Promise<{ id: string }> };

/**
 * Staff-authorized payment status change (manual/test mode).
 * Status transitions are validated server-side, audited, and only legal
 * transitions are accepted. Never callable from the patient side.
 *
 * Recording a collected payment ("paid") is a routine front-desk action —
 * the receptionist who took the patient's cash needs to be able to record
 * it without an owner/admin in the room — so it's open to every clinic-
 * staff role. Reversing or flagging one (refunded/manual_review/failed)
 * stays owner/admin-only: the same separation-of-duties that keeps the
 * person collecting money from also being the one who can undo it.
 */
export async function POST(request: NextRequest, ctx: RouteContext) {
  try {
    const staff = await requireRoles("owner", "admin", "manager", "receptionist");
    const { id } = await ctx.params;
    const body = await parseBody(request, schema);

    if (body.status !== "paid" && !hasAnyRole(staff.roles, ["owner", "admin"])) {
      throw new ApiError(403, "Faqat klinika egasi yoki administrator bu holatni o‘zgartira oladi", "forbidden");
    }

    if (!isManualPaymentMode()) {
      return new NextResponse(
        JSON.stringify({ ok: false, error: "Real payment provider active — status is provider-managed" }),
        { status: 409, headers: { "Content-Type": "application/json" } },
      );
    }

    const result = await transitionPaymentStatus({
      appointmentId: id,
      clinicId: staff.clinicId,
      to: body.status,
      provider: body.status === "paid" ? body.provider : undefined,
      actorId: staff.profileId,
      actorType: "staff",
      metadata: { manual_confirmation: true },
    });

    return ok({ updated: true, alreadyInState: result.alreadyInState ?? false });
  } catch (e) {
    return handleApiError(e);
  }
}

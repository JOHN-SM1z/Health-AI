import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireStaff } from "@/lib/auth/guards";
import { parseBody } from "@/lib/api/validate";
import { handleApiError, ok } from "@/lib/api/errors";
import { transitionPaymentStatus } from "@/lib/payments/status";
import { isManualPaymentMode } from "@/lib/payments/provider";

export const dynamic = "force-dynamic";

const schema = z.object({
  status: z.enum(["paid", "refunded", "manual_review", "failed"]),
});

type RouteContext = { params: Promise<{ id: string }> };

/**
 * Staff-authorized payment status change (manual/test mode).
 * Status transitions are validated server-side, audited, and only legal
 * transitions are accepted. Never callable from the patient side.
 */
export async function POST(request: NextRequest, ctx: RouteContext) {
  try {
    const staff = await requireStaff("admin");
    const { id } = await ctx.params;
    const body = await parseBody(request, schema);

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
      actorId: staff.profileId,
      actorType: "staff",
      metadata: { manual_confirmation: true, provider: "manual" },
    });

    return ok({ updated: true, alreadyInState: result.alreadyInState ?? false });
  } catch (e) {
    return handleApiError(e);
  }
}
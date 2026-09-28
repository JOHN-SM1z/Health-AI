import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireLinkedDoctor } from "@/lib/auth/guards";
import { parseBody, uuidSchema } from "@/lib/api/validate";
import { ApiError, handleApiError, ok } from "@/lib/api/errors";
import { actOnReferral, getReferralForDoctor } from "@/lib/referrals/service";

export const dynamic = "force-dynamic";

const actionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("accept") }),
  z.object({ action: z.literal("decline"), reason: z.string().trim().max(1000).optional() }),
  z.object({ action: z.literal("complete") }),
  z.object({ action: z.literal("revoke"), reason: z.string().trim().min(3, "Bekor qilish sababini yozing").max(1000) }),
]);

type RouteContext = { params: Promise<{ id: string }> };

async function referralId(ctx: RouteContext): Promise<string> {
  const { id } = await ctx.params;
  if (!uuidSchema.safeParse(id).success) throw new ApiError(404, "Yo‘llanma topilmadi", "referral_not_found");
  return id;
}

/** A referral the calling doctor is on, with the patient context they may see (access-logged). */
export async function GET(_request: NextRequest, ctx: RouteContext) {
  try {
    const doctor = await requireLinkedDoctor();
    return ok({ referral: await getReferralForDoctor(doctor, await referralId(ctx)) });
  } catch (e) {
    return handleApiError(e);
  }
}

/** accept / decline / complete (receiving doctor) or revoke (referring doctor). */
export async function PATCH(request: NextRequest, ctx: RouteContext) {
  try {
    const doctor = await requireLinkedDoctor();
    const id = await referralId(ctx);
    const body = await parseBody(request, actionSchema);
    const reason = body.action === "decline" || body.action === "revoke" ? body.reason : undefined;
    return ok(await actOnReferral(doctor, id, body.action, reason));
  } catch (e) {
    return handleApiError(e);
  }
}

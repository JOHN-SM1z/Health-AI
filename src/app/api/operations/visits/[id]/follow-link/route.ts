import type { NextRequest } from "next/server";
import { ApiError, handleApiError, ok } from "@/lib/api/errors";
import { uuidSchema } from "@/lib/api/validate";
import { requireRoles } from "@/lib/auth/guards";
import { RECEPTION_ROLES, KASSA_ROLES } from "@/lib/auth/staff";
import { createVisitFollowLink } from "@/lib/operations/outpatient";

export const dynamic = "force-dynamic";
type RouteContext = { params: Promise<{ id: string }> };

/**
 * A one-time Telegram link (shown as a QR code) for the patient to follow
 * this visit's queue in the clinic's bot: the number, how many are ahead and
 * "you are called". It opens nothing else — not the card, records or results.
 * The clinic and the actor come from the session; the body is ignored.
 */
export async function POST(_request: NextRequest, ctx: RouteContext) {
  try {
    const staff = await requireRoles(...new Set([...RECEPTION_ROLES, ...KASSA_ROLES]));
    const { id } = await ctx.params;
    if (!uuidSchema.safeParse(id).success) throw new ApiError(404, "Tashrif topilmadi", "visit_not_found");
    return ok(await createVisitFollowLink(staff, id), { status: 201 });
  } catch (e) {
    return handleApiError(e);
  }
}

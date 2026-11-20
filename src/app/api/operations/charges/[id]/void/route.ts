import type { NextRequest } from "next/server";
import { z } from "zod";
import { ApiError, handleApiError, ok } from "@/lib/api/errors";
import { parseBody, uuidSchema } from "@/lib/api/validate";
import { requireRoles } from "@/lib/auth/guards";
import { RECEPTION_ROLES, KASSA_ROLES } from "@/lib/auth/staff";
import { voidVisitCharge } from "@/lib/operations/outpatient";

export const dynamic = "force-dynamic";
type RouteContext = { params: Promise<{ id: string }> };

const schema = z.object({ reason: z.string().trim().min(3, "Sababini yozing").max(500) }).strict();

/** Removes a wrong service line (voided with a reason, never edited); refused while it would leave money unreturned. */
export async function POST(request: NextRequest, ctx: RouteContext) {
  try {
    const staff = await requireRoles(...new Set([...RECEPTION_ROLES, ...KASSA_ROLES]));
    const { id } = await ctx.params;
    if (!uuidSchema.safeParse(id).success) throw new ApiError(404, "Xizmat qatori topilmadi", "charge_not_found");
    const body = await parseBody(request, schema);
    await voidVisitCharge(staff, id, body.reason);
    return ok({ voided: true });
  } catch (e) {
    return handleApiError(e);
  }
}

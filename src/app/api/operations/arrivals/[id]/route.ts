import type { NextRequest } from "next/server";
import { z } from "zod";
import { ApiError, handleApiError, ok } from "@/lib/api/errors";
import { parseBody, uuidSchema } from "@/lib/api/validate";
import { requireRoles } from "@/lib/auth/guards";
import { RECEPTION_ROLES, KASSA_ROLES } from "@/lib/auth/staff";
import { getVisit, transitionVisit } from "@/lib/operations/outpatient";

export const dynamic = "force-dynamic";
type RouteContext = { params: Promise<{ id: string }> };

const STATUS = z.enum(["awaiting_payment", "waiting", "called", "in_progress", "completed", "cancelled"]);
const schema = z.object({ expected: STATUS, status: z.enum(["waiting", "called", "cancelled"]), reason: z.string().trim().max(500).nullish() }).strict();

export async function GET(_request: NextRequest, ctx: RouteContext) {
  try {
    const staff = await requireRoles(...new Set([...RECEPTION_ROLES, ...KASSA_ROLES]));
    const { id } = await ctx.params;
    if (!uuidSchema.safeParse(id).success) throw new ApiError(404, "Tashrif topilmadi", "visit_not_found");
    return ok({ visit: await getVisit(staff.clinicId, id) });
  } catch (e) {
    return handleApiError(e);
  }
}

/** Desk queue actions: call, back to waiting, cancel (reason required; refused while money is held). */
export async function POST(request: NextRequest, ctx: RouteContext) {
  try {
    const staff = await requireRoles(...RECEPTION_ROLES);
    const { id } = await ctx.params;
    if (!uuidSchema.safeParse(id).success) throw new ApiError(404, "Tashrif topilmadi", "visit_not_found");
    const body = await parseBody(request, schema);
    return ok(await transitionVisit(staff, id, body));
  } catch (e) {
    return handleApiError(e);
  }
}

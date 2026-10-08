import type { NextRequest } from "next/server";
import { z } from "zod";
import { ApiError, handleApiError, ok } from "@/lib/api/errors";
import { parseBody, uuidSchema } from "@/lib/api/validate";
import { requireRoles } from "@/lib/auth/guards";
import { RECEPTION_ROLES, KASSA_ROLES } from "@/lib/auth/staff";
import { addVisitCharge } from "@/lib/operations/outpatient";

export const dynamic = "force-dynamic";
type RouteContext = { params: Promise<{ id: string }> };

const schema = z.object({ key: uuidSchema, serviceId: uuidSchema }).strict();

/** Adds a service line to a visit, priced by the database. */
export async function POST(request: NextRequest, ctx: RouteContext) {
  try {
    const staff = await requireRoles(...new Set([...RECEPTION_ROLES, ...KASSA_ROLES]));
    const { id } = await ctx.params;
    if (!uuidSchema.safeParse(id).success) throw new ApiError(404, "Tashrif topilmadi", "visit_not_found");
    const body = await parseBody(request, schema);
    const r = await addVisitCharge(staff, id, body);
    return ok({ chargeId: r.charge_id, replayed: r.replayed }, { status: r.replayed ? 200 : 201 });
  } catch (e) {
    return handleApiError(e);
  }
}

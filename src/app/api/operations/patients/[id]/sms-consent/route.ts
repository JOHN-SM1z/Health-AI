import type { NextRequest } from "next/server";
import { z } from "zod";
import { ApiError, handleApiError, ok } from "@/lib/api/errors";
import { parseBody, uuidSchema } from "@/lib/api/validate";
import { requireRoles } from "@/lib/auth/guards";
import { RECEPTION_ROLES } from "@/lib/auth/staff";
import { setSmsConsent } from "@/lib/operations/outpatient";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };
const schema = z.object({ consent: z.boolean() });

/** Reception records that the patient agreed (or no longer agrees) to queue SMS. */
export async function POST(request: NextRequest, ctx: RouteContext) {
  try {
    const staff = await requireRoles(...RECEPTION_ROLES);
    const { id } = await ctx.params;
    if (!uuidSchema.safeParse(id).success) throw new ApiError(404, "Bemor topilmadi", "patient_not_found");
    const body = await parseBody(request, schema);
    return ok(await setSmsConsent(staff, id, body.consent));
  } catch (e) {
    return handleApiError(e);
  }
}

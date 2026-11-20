import type { NextRequest } from "next/server";
import { z } from "zod";
import { ApiError, handleApiError, ok } from "@/lib/api/errors";
import { parseBody, uuidSchema } from "@/lib/api/validate";
import { requireRoles } from "@/lib/auth/guards";
import { RECEPTION_ROLES } from "@/lib/auth/staff";
import { verifyIdentityAtDesk } from "@/lib/operations/outpatient";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };
const schema = z
  .object({
    document: z.string().trim().min(5).max(40),
    dateOfBirth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  })
  .strict();

/**
 * Reception checks the patient's passport/ID card in hand against the card: the answer is only whether it matches
 * (never the stored values). A match marks the card's identity confirmed.
 */
export async function POST(request: NextRequest, ctx: RouteContext) {
  try {
    const staff = await requireRoles(...RECEPTION_ROLES);
    const { id } = await ctx.params;
    if (!uuidSchema.safeParse(id).success) throw new ApiError(404, "Bemor topilmadi", "patient_not_found");
    const body = await parseBody(request, schema);
    return ok(await verifyIdentityAtDesk(staff, id, body));
  } catch (e) {
    return handleApiError(e);
  }
}

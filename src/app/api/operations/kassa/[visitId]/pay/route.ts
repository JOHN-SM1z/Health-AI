import type { NextRequest } from "next/server";
import { z } from "zod";
import { ApiError, handleApiError, ok } from "@/lib/api/errors";
import { parseBody, uuidSchema } from "@/lib/api/validate";
import { requireRoles } from "@/lib/auth/guards";
import { KASSA_ROLES } from "@/lib/auth/staff";
import { recordVisitPayment } from "@/lib/operations/outpatient";

export const dynamic = "force-dynamic";
type RouteContext = { params: Promise<{ visitId: string }> };

const money = z.number().positive().max(1_000_000_000).refine((n) => Math.round(n * 100) === n * 100, "Summa noto‘g‘ri");
// The amounts must settle exactly what the database says is due
// (expectedOutstanding guards against a bill that changed meanwhile).
const schema = z
  .object({
    key: uuidSchema,
    expectedOutstanding: z.number().nonnegative(),
    lines: z.array(z.object({ method: z.enum(["cash", "terminal"]), amount: money }).strict()).min(1).max(2),
  })
  .strict();

/** Records money received at the kassa (cash and/or card terminal). Not a fiscal receipt. */
export async function POST(request: NextRequest, ctx: RouteContext) {
  try {
    const staff = await requireRoles(...KASSA_ROLES);
    const { visitId } = await ctx.params;
    if (!uuidSchema.safeParse(visitId).success) throw new ApiError(404, "Tashrif topilmadi", "visit_not_found");
    const body = await parseBody(request, schema);
    return ok(await recordVisitPayment(staff, visitId, body));
  } catch (e) {
    return handleApiError(e);
  }
}

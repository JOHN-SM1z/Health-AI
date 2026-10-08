import type { NextRequest } from "next/server";
import { z } from "zod";
import { ApiError, handleApiError, ok } from "@/lib/api/errors";
import { parseBody, uuidSchema } from "@/lib/api/validate";
import { requireRoles } from "@/lib/auth/guards";
import { refundVisitPayment } from "@/lib/operations/outpatient";

export const dynamic = "force-dynamic";
type RouteContext = { params: Promise<{ visitId: string }> };

const schema = z
  .object({
    key: uuidSchema,
    method: z.enum(["cash", "terminal"]),
    amount: z.number().positive().max(1_000_000_000).refine((n) => Math.round(n * 100) === n * 100, "Summa noto‘g‘ri"),
    reason: z.string().trim().min(3, "Sababini yozing").max(500),
  })
  .strict();

/**
 * Records money paid back (full or partial). Owner and manager on their own
 * authority; a cashier only while holding a manager's grant — checked in the
 * database, which records both who authorized and who executed it. This
 * records the refund; it does not move money through a bank or terminal.
 */
export async function POST(request: NextRequest, ctx: RouteContext) {
  try {
    const staff = await requireRoles("owner", "manager", "cashier");
    const { visitId } = await ctx.params;
    if (!uuidSchema.safeParse(visitId).success) throw new ApiError(404, "Tashrif topilmadi", "visit_not_found");
    const body = await parseBody(request, schema);
    return ok(await refundVisitPayment(staff, visitId, body));
  } catch (e) {
    return handleApiError(e);
  }
}

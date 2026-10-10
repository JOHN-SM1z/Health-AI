import type { NextRequest } from "next/server";
import { z } from "zod";
import { ApiError, handleApiError, ok } from "@/lib/api/errors";
import { parseBody, uuidSchema } from "@/lib/api/validate";
import { requireRoles } from "@/lib/auth/guards";
import { transitionVisit } from "@/lib/operations/outpatient";

export const dynamic = "force-dynamic";
type RouteContext = { params: Promise<{ id: string }> };

const schema = z
  .object({
    action: z.enum(["call", "recall", "start", "complete"]),
    expected: z.enum(["waiting", "called", "in_progress"]),
  })
  .strict();

const STATUS = { call: "called", recall: "waiting", start: "in_progress", complete: "completed" } as const;

/** Lab staff move a laboratory visit through the lab queue (the database allows lab visits only). */
export async function POST(request: NextRequest, ctx: RouteContext) {
  try {
    const staff = await requireRoles("lab");
    const { id } = await ctx.params;
    if (!uuidSchema.safeParse(id).success) throw new ApiError(404, "Tashrif topilmadi", "visit_not_found");
    const body = await parseBody(request, schema);
    return ok(await transitionVisit(staff, id, { expected: body.expected, status: STATUS[body.action] }));
  } catch (e) {
    return handleApiError(e);
  }
}

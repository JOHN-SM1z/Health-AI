import type { NextRequest } from "next/server";
import { z } from "zod";
import { ApiError, handleApiError, ok } from "@/lib/api/errors";
import { parseBody, uuidSchema } from "@/lib/api/validate";
import { requireLinkedDoctor } from "@/lib/auth/guards";
import { startVisitConsultation, transitionVisit } from "@/lib/operations/outpatient";

export const dynamic = "force-dynamic";
type RouteContext = { params: Promise<{ id: string }> };

const schema = z
  .object({
    action: z.enum(["call", "recall", "start", "complete"]),
    expected: z.enum(["waiting", "called", "in_progress"]),
  })
  .strict();

/**
 * The visit's own doctor: call the patient, put them back, start the
 * consultation (returns the patient to open the workspace) or complete it.
 * Another doctor's visit is refused by the database.
 */
export async function POST(request: NextRequest, ctx: RouteContext) {
  try {
    const doctor = await requireLinkedDoctor();
    const { id } = await ctx.params;
    if (!uuidSchema.safeParse(id).success) throw new ApiError(404, "Tashrif topilmadi", "visit_not_found");
    const body = await parseBody(request, schema);
    if (body.action === "start") return ok(await startVisitConsultation(doctor, id, body.expected));
    const status = body.action === "call" ? "called" : body.action === "recall" ? "waiting" : "completed";
    return ok(await transitionVisit(doctor, id, { expected: body.expected, status }));
  } catch (e) {
    return handleApiError(e);
  }
}

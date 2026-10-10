import type { NextRequest } from "next/server";
import { z } from "zod";
import { ApiError, handleApiError, ok } from "@/lib/api/errors";
import { parseBody, uuidSchema } from "@/lib/api/validate";
import { requireRoles } from "@/lib/auth/guards";
import { unmergePatients } from "@/lib/patients/merge";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

const schema = z.object({ action: z.literal("unmerge"), reason: z.string().trim().min(3, "Sababini yozing").max(500) });

/** Undoes a merge (owner / admin). */
export async function POST(request: NextRequest, ctx: RouteContext) {
  try {
    const staff = await requireRoles("owner", "admin");
    const { id } = await ctx.params;
    if (!uuidSchema.safeParse(id).success) throw new ApiError(404, "Bemor yoki birlashtirish topilmadi", "not_found");
    const body = await parseBody(request, schema);
    return ok(await unmergePatients(staff, id, body.reason));
  } catch (e) {
    return handleApiError(e);
  }
}

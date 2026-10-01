import type { NextRequest } from "next/server";
import { handleApiError, ok } from "@/lib/api/errors";
import { parseBody } from "@/lib/api/validate";
import { idParam, requireLabConfig } from "@/lib/labs/access";
import { createRange, updateRange } from "@/lib/labs/catalog";
import { rangeCreateSchema, rangeUpdateSchema } from "@/lib/labs/schemas";

export const dynamic = "force-dynamic";

/**
 * Reference ranges and critical thresholds of a numeric parameter — configured per clinic, never global
 * constants. A result copies the range it was evaluated against, so editing a range later never re-flags
 * stored results.
 */
export async function POST(request: NextRequest) {
  try {
    const staff = await requireLabConfig();
    const body = await parseBody(request, rangeCreateSchema);
    return ok({ range: await createRange(staff.clinicId, staff.profileId, body) }, { status: 201 });
  } catch (e) {
    return handleApiError(e);
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const staff = await requireLabConfig();
    const id = idParam(request);
    const body = await parseBody(request, rangeUpdateSchema);
    return ok({ range: await updateRange(staff.clinicId, staff.profileId, id, body) });
  } catch (e) {
    return handleApiError(e);
  }
}

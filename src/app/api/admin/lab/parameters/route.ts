import type { NextRequest } from "next/server";
import { handleApiError, ok } from "@/lib/api/errors";
import { parseBody } from "@/lib/api/validate";
import { idParam, requireLabConfig } from "@/lib/labs/access";
import { createParameter, updateParameter } from "@/lib/labs/catalog";
import { parameterCreateSchema, parameterUpdateSchema } from "@/lib/labs/schemas";

export const dynamic = "force-dynamic";

/** Parameters of a test (unit, data type, display order). Read them through GET /api/admin/lab/tests?id=. */
export async function POST(request: NextRequest) {
  try {
    const staff = await requireLabConfig();
    const body = await parseBody(request, parameterCreateSchema);
    return ok({ parameter: await createParameter(staff.clinicId, staff.profileId, body) }, { status: 201 });
  } catch (e) {
    return handleApiError(e);
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const staff = await requireLabConfig();
    const id = idParam(request);
    const body = await parseBody(request, parameterUpdateSchema);
    return ok({ parameter: await updateParameter(staff.clinicId, staff.profileId, id, body) });
  } catch (e) {
    return handleApiError(e);
  }
}

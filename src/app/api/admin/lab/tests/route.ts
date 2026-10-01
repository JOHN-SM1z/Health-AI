import type { NextRequest } from "next/server";
import { handleApiError, ok } from "@/lib/api/errors";
import { parseBody } from "@/lib/api/validate";
import { idParam, requireLabCatalogRead, requireLabConfig } from "@/lib/labs/access";
import { createTest, getTest, listTests, updateTest } from "@/lib/labs/catalog";
import { testCreateSchema, testUpdateSchema } from "@/lib/labs/schemas";

export const dynamic = "force-dynamic";

/**
 * The clinic's laboratory tests. `?id=` returns one test with its parameters and reference ranges;
 * otherwise the list (active tests by default, `?includeInactive=1` for the configuration screens).
 * Inactive tests cannot be newly ordered (database rule); their history stays readable.
 */
export async function GET(request: NextRequest) {
  try {
    const staff = await requireLabCatalogRead();
    if (request.nextUrl.searchParams.has("id")) return ok({ test: await getTest(staff.clinicId, idParam(request)) });
    const includeInactive = request.nextUrl.searchParams.get("includeInactive") === "1";
    return ok({ tests: await listTests(staff.clinicId, { includeInactive }) });
  } catch (e) {
    return handleApiError(e);
  }
}

export async function POST(request: NextRequest) {
  try {
    const staff = await requireLabConfig();
    const body = await parseBody(request, testCreateSchema);
    return ok({ test: await createTest(staff.clinicId, staff.profileId, body) }, { status: 201 });
  } catch (e) {
    return handleApiError(e);
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const staff = await requireLabConfig();
    const id = idParam(request);
    const body = await parseBody(request, testUpdateSchema);
    return ok({ test: await updateTest(staff.clinicId, staff.profileId, id, body) });
  } catch (e) {
    return handleApiError(e);
  }
}

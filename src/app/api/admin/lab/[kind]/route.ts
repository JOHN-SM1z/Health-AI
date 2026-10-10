import type { NextRequest } from "next/server";
import { handleApiError, ApiError, ok } from "@/lib/api/errors";
import { parseBody, uuidSchema } from "@/lib/api/validate";
import { requireLabCapability } from "@/lib/labs/guards";
import {
  categorySchema,
  createParameter,
  createRange,
  panelSchema,
  parameterSchema,
  parameterUpdateSchema,
  rangeSchema,
  rangeUpdateSchema,
  saveCategory,
  savePanel,
  saveTest,
  setRangeActive,
  testSchema,
  updateParameter,
} from "@/lib/labs/catalog";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ kind: string }> };

const KINDS = ["categories", "tests", "parameters", "ranges", "panels"] as const;
type Kind = (typeof KINDS)[number];

async function kindOf(context: RouteContext): Promise<Kind> {
  const { kind } = await context.params;
  if (!(KINDS as readonly string[]).includes(kind)) throw new ApiError(404, "Topilmadi", "not_found");
  return kind as Kind;
}

function idOf(request: NextRequest): string {
  const parsed = uuidSchema.safeParse(request.nextUrl.searchParams.get("id"));
  if (!parsed.success) throw new ApiError(400, "id parametri kerak", "missing_id");
  return parsed.data;
}

/** Creates a lab catalog row. Clinic management only (catalog.configure). */
export async function POST(request: NextRequest, context: RouteContext) {
  try {
    const kind = await kindOf(context);
    const staff = await requireLabCapability("catalog.configure");
    switch (kind) {
      case "categories":
        return ok({ category: await saveCategory(staff, null, await parseBody(request, categorySchema)) }, { status: 201 });
      case "tests":
        return ok({ test: await saveTest(staff, null, await parseBody(request, testSchema)) }, { status: 201 });
      case "parameters":
        return ok({ parameter: await createParameter(staff, await parseBody(request, parameterSchema)) }, { status: 201 });
      case "ranges":
        return ok({ range: await createRange(staff, await parseBody(request, rangeSchema)) }, { status: 201 });
      case "panels":
        return ok({ panel: await savePanel(staff, null, await parseBody(request, panelSchema)) }, { status: 201 });
    }
  } catch (e) {
    return handleApiError(e);
  }
}

/**
 * Updates a lab catalog row (`?id=`). Nothing is ever deleted: deactivate
 * with `active: false`. A reference range only (de)activates — a different
 * range is a new range.
 */
export async function PATCH(request: NextRequest, context: RouteContext) {
  try {
    const kind = await kindOf(context);
    const staff = await requireLabCapability("catalog.configure");
    const id = idOf(request);
    switch (kind) {
      case "categories":
        return ok({ category: await saveCategory(staff, id, await parseBody(request, categorySchema.partial())) });
      case "tests":
        return ok({ test: await saveTest(staff, id, await parseBody(request, testSchema.partial())) });
      case "parameters":
        return ok({ parameter: await updateParameter(staff, id, await parseBody(request, parameterUpdateSchema)) });
      case "ranges":
        return ok({ range: await setRangeActive(staff, id, (await parseBody(request, rangeUpdateSchema)).active) });
      case "panels":
        return ok({ panel: await savePanel(staff, id, await parseBody(request, panelSchema.partial())) });
    }
  } catch (e) {
    return handleApiError(e);
  }
}

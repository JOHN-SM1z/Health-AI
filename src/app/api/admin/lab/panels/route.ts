import type { NextRequest } from "next/server";
import { handleApiError, ok } from "@/lib/api/errors";
import { parseBody } from "@/lib/api/validate";
import { idParam, requireLabCatalogRead, requireLabConfig } from "@/lib/labs/access";
import { createPanel, listPanels, updatePanel } from "@/lib/labs/catalog";
import { panelCreateSchema, panelUpdateSchema } from "@/lib/labs/schemas";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    const staff = await requireLabCatalogRead();
    const includeInactive = request.nextUrl.searchParams.get("includeInactive") === "1";
    return ok({ panels: await listPanels(staff.clinicId, { includeInactive }) });
  } catch (e) {
    return handleApiError(e);
  }
}

export async function POST(request: NextRequest) {
  try {
    const staff = await requireLabConfig();
    const body = await parseBody(request, panelCreateSchema);
    return ok({ panel: await createPanel(staff.clinicId, staff.profileId, body) }, { status: 201 });
  } catch (e) {
    return handleApiError(e);
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const staff = await requireLabConfig();
    const id = idParam(request);
    const body = await parseBody(request, panelUpdateSchema);
    return ok({ panel: await updatePanel(staff.clinicId, staff.profileId, id, body) });
  } catch (e) {
    return handleApiError(e);
  }
}

import type { NextRequest } from "next/server";
import { handleApiError, ok } from "@/lib/api/errors";
import { parseBody } from "@/lib/api/validate";
import { idParam, requireLabCatalogRead, requireLabConfig } from "@/lib/labs/access";
import { createCategory, listCategories, updateCategory } from "@/lib/labs/catalog";
import { categoryCreateSchema, categoryUpdateSchema } from "@/lib/labs/schemas";

export const dynamic = "force-dynamic";

/** Laboratory sections (Blood, Urine, …) of the staff member's own clinic. */
export async function GET() {
  try {
    const staff = await requireLabCatalogRead();
    return ok({ categories: await listCategories(staff.clinicId) });
  } catch (e) {
    return handleApiError(e);
  }
}

export async function POST(request: NextRequest) {
  try {
    const staff = await requireLabConfig();
    const body = await parseBody(request, categoryCreateSchema);
    return ok({ category: await createCategory(staff.clinicId, staff.profileId, body) }, { status: 201 });
  } catch (e) {
    return handleApiError(e);
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const staff = await requireLabConfig();
    const id = idParam(request);
    const body = await parseBody(request, categoryUpdateSchema);
    return ok({ category: await updateCategory(staff.clinicId, staff.profileId, id, body) });
  } catch (e) {
    return handleApiError(e);
  }
}

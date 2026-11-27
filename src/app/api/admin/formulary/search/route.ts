import type { NextRequest } from "next/server";
import { requireRoles } from "@/lib/auth/guards";
import { handleApiError, ok } from "@/lib/api/errors";
import { searchCatalogueForFormulary } from "@/lib/prescribing/catalog";
import { parseSearchQuery } from "@/lib/prescribing/schemas";

export const dynamic = "force-dynamic";

/** Finds medicines of the shared catalogue to put on the clinic's formulary. Owner and administrator only. */
export async function GET(request: NextRequest) {
  try {
    const staff = await requireRoles("owner", "admin");
    const query = parseSearchQuery(request.nextUrl.searchParams.get("q"));
    return ok({ drugs: query ? await searchCatalogueForFormulary(staff.clinicId, query) : [] });
  } catch (e) {
    return handleApiError(e);
  }
}

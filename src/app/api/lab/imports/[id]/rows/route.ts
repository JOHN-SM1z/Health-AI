import type { NextRequest } from "next/server";
import { ApiError, handleApiError, ok } from "@/lib/api/errors";
import { uuidSchema } from "@/lib/api/validate";
import { requireLabCapability } from "@/lib/labs/guards";
import { listImportRows, ROW_FILTERS, type RowFilter } from "@/lib/labs/imports";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

/** A page of rows with their cells, reading and status (audited). Lab staff. */
export async function GET(request: NextRequest, ctx: RouteContext) {
  try {
    const staff = await requireLabCapability("import.manage");
    const { id } = await ctx.params;
    if (!uuidSchema.safeParse(id).success) throw new ApiError(404, "Import topilmadi", "import_not_found");
    const params = request.nextUrl.searchParams;
    const filter = (params.get("filter") ?? "all") as RowFilter;
    if (!ROW_FILTERS.includes(filter)) throw new ApiError(400, "Noto‘g‘ri filtr", "validation");
    const offset = Number(params.get("offset") ?? "0");
    if (!Number.isInteger(offset) || offset < 0 || offset > 5000) throw new ApiError(400, "Noto‘g‘ri sahifa", "validation");
    return ok(await listImportRows(staff, id, filter, offset));
  } catch (e) {
    return handleApiError(e);
  }
}

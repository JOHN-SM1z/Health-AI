import type { NextRequest } from "next/server";
import { ApiError, handleApiError } from "@/lib/api/errors";
import { uuidSchema } from "@/lib/api/validate";
import { requireLabCapability } from "@/lib/labs/guards";
import { importReportCsv } from "@/lib/labs/imports";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

/** The import report: row number, status and reasons as CSV — no values or identifiers. Lab staff. */
export async function GET(_request: NextRequest, ctx: RouteContext) {
  try {
    const staff = await requireLabCapability("import.manage");
    const { id } = await ctx.params;
    if (!uuidSchema.safeParse(id).success) throw new ApiError(404, "Import topilmadi", "import_not_found");
    const { fileName, csv } = await importReportCsv(staff, id);
    return new Response(csv, {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="${fileName}"`,
        "cache-control": "no-store",
      },
    });
  } catch (e) {
    return handleApiError(e);
  }
}

import type { NextRequest } from "next/server";
import { requireRoles } from "@/lib/auth/guards";
import { LAB_WORK_ROLES } from "@/lib/auth/staff";
import { handleApiError, ok } from "@/lib/api/errors";
import { listResultItems, type ResultListFilter } from "@/lib/labs/results";

export const dynamic = "force-dynamic";

/** The bench's result list: ordered tests with their result STATE (never a value). Laboratory staff only. */
export async function GET(request: NextRequest) {
  try {
    const staff = await requireRoles(...LAB_WORK_ROLES);
    const raw = request.nextUrl.searchParams.get("filter");
    const filter: ResultListFilter = raw === "review" || raw === "verified" || raw === "all" ? raw : "todo";
    return ok({ items: await listResultItems(staff, filter) });
  } catch (e) {
    return handleApiError(e);
  }
}

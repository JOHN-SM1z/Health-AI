import "server-only";
import type { NextRequest } from "next/server";
import { requireRoles } from "@/lib/auth/guards";
import { LAB_CATALOG_READ_ROLES, LAB_CONFIG_ROLES } from "@/lib/auth/staff";
import { ApiError } from "@/lib/api/errors";
import { uuidSchema } from "@/lib/api/validate";

/** Owner/admin/manager: configure the laboratory. Never grants result access (clinical text). */
export const requireLabConfig = () => requireRoles(...LAB_CONFIG_ROLES);

/** Configuration may also be READ by laboratory staff (they work from it); they never write it. */
export const requireLabCatalogRead = () => requireRoles(...LAB_CATALOG_READ_ROLES);

/** The ?id= of a request. A malformed id answers like a missing row (no probing). */
export function idParam(request: NextRequest): string {
  const id = request.nextUrl.searchParams.get("id");
  if (!id || !uuidSchema.safeParse(id).success) throw new ApiError(404, "Topilmadi", "lab_not_found");
  return id;
}

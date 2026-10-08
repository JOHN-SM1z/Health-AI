import type { NextRequest } from "next/server";
import { handleApiError, ok, ApiError } from "@/lib/api/errors";
import { requireRoles } from "@/lib/auth/guards";
import { RECEPTION_ROLES } from "@/lib/auth/staff";
import { searchPatients } from "@/lib/operations/outpatient";

export const dynamic = "force-dynamic";

/**
 * Reception: find a returning patient by patient number, PINFL, passport/ID
 * number, phone or name (optionally with date of birth) to confirm identity.
 * Returns only what confirmation needs; document and phone are masked.
 */
export async function GET(request: NextRequest) {
  try {
    const staff = await requireRoles(...RECEPTION_ROLES);
    const q = request.nextUrl.searchParams.get("q") ?? "";
    const dob = request.nextUrl.searchParams.get("dob") ?? undefined;
    if (q.length > 80) throw new ApiError(400, "So‘rov juda uzun", "validation");
    if (dob && !/^\d{4}-\d{2}-\d{2}$/.test(dob)) throw new ApiError(400, "Tug‘ilgan sana noto‘g‘ri", "validation");
    return ok({ patients: await searchPatients(staff, q, dob) });
  } catch (e) {
    return handleApiError(e);
  }
}

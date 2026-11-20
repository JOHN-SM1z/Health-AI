import type { NextRequest } from "next/server";
import { handleApiError, ok, ApiError } from "@/lib/api/errors";
import { requireRoles } from "@/lib/auth/guards";
import { RECEPTION_ROLES } from "@/lib/auth/staff";
import { searchPatients } from "@/lib/operations/outpatient";

export const dynamic = "force-dynamic";

/**
 * Reception: find a returning patient — passport/ID or JSHSHIR with the date
 * of birth in one step (`exact`), or patient number, phone or name. Returns
 * only what the desk needs; document and phone are masked. A document whose
 * card has another date of birth is reported (`dobMismatch`), never shown.
 */
export async function GET(request: NextRequest) {
  try {
    const staff = await requireRoles(...RECEPTION_ROLES);
    const q = request.nextUrl.searchParams.get("q") ?? "";
    const dob = request.nextUrl.searchParams.get("dob") ?? undefined;
    if (q.length > 80) throw new ApiError(400, "So‘rov juda uzun", "validation");
    if (dob && !/^\d{4}-\d{2}-\d{2}$/.test(dob)) throw new ApiError(400, "Tug‘ilgan sana noto‘g‘ri", "validation");
    return ok(await searchPatients(staff, q, dob));
  } catch (e) {
    return handleApiError(e);
  }
}

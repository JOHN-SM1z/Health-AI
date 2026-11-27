import type { NextRequest } from "next/server";
import { z } from "zod";
import { handleApiError, ok, ApiError } from "@/lib/api/errors";
import { parseBody } from "@/lib/api/validate";
import { requireRoles } from "@/lib/auth/guards";
import { RECEPTION_ROLES } from "@/lib/auth/staff";
import { searchPatients } from "@/lib/operations/outpatient";

export const dynamic = "force-dynamic";

const searchSchema = z.object({
  query: z.string().trim().max(80, "So‘rov juda uzun"),
  dateOfBirth: z.iso.date("Tug‘ilgan sana noto‘g‘ri").optional(),
});

/**
 * Reception: find a returning patient — passport/ID or JSHSHIR with the date
 * of birth, or patient number, phone or name. Return only the details needed
 * at reception. Use POST so search values stay out of the request URL.
 */
export async function POST(request: NextRequest) {
  try {
    const staff = await requireRoles(...RECEPTION_ROLES);
    if (request.nextUrl.search) throw new ApiError(400, "Qidiruv ma’lumotlarini so‘rov tanasida yuboring", "query_in_url");
    const body = await parseBody(request, searchSchema, { maxBytes: 1024 });
    return ok(await searchPatients(staff, body.query, body.dateOfBirth), { headers: { "Cache-Control": "private, no-store" } });
  } catch (e) {
    const response = handleApiError(e);
    response.headers.set("Cache-Control", "private, no-store");
    return response;
  }
}

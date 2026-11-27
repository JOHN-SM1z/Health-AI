import type { NextRequest } from "next/server";
import { requireLinkedDoctor } from "@/lib/auth/guards";
import { ApiError, handleApiError, ok } from "@/lib/api/errors";
import { sharedRateLimit } from "@/lib/rate-limit-shared";
import { searchIcd10 } from "@/lib/prescribing/catalog";
import { parseSearchQuery } from "@/lib/prescribing/schemas";

export const dynamic = "force-dynamic";

const SEARCHES_PER_MINUTE = 240;

/**
 * ICD-10 picker: codes matching a code prefix ("J06") or words of the name.
 * The doctor chooses the diagnosis; this only looks up what they typed.
 */
export async function GET(request: NextRequest) {
  try {
    const doctor = await requireLinkedDoctor();
    const limit = await sharedRateLimit({ key: `icd10-search:${doctor.profileId}`, limit: SEARCHES_PER_MINUTE, windowMs: 60_000 });
    if (!limit.ok) throw new ApiError(429, "Juda ko‘p so‘rov, birozdan keyin urinib ko‘ring", "rate_limited");
    const query = parseSearchQuery(request.nextUrl.searchParams.get("q"));
    return ok({ codes: query ? await searchIcd10(query) : [] });
  } catch (e) {
    return handleApiError(e);
  }
}

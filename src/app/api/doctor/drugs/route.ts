import type { NextRequest } from "next/server";
import { requireLinkedDoctor } from "@/lib/auth/guards";
import { ApiError, handleApiError, ok } from "@/lib/api/errors";
import { sharedRateLimit } from "@/lib/rate-limit-shared";
import { searchDrugs } from "@/lib/prescribing/catalog";
import { parseSearchQuery } from "@/lib/prescribing/schemas";

export const dynamic = "force-dynamic";

// Typing fires a search per pause; ample for that, not for scraping the catalogue.
const SEARCHES_PER_MINUTE = 240;

/**
 * Drug autocomplete of the prescribing screen: medicines matching what the
 * doctor typed (two characters or more), by INN, trade name or alias in Latin
 * or Cyrillic — the clinic's formulary and the doctor's recent choices first.
 * Reference data only; no patient is involved.
 */
export async function GET(request: NextRequest) {
  try {
    const doctor = await requireLinkedDoctor();
    const limit = await sharedRateLimit({ key: `drug-search:${doctor.profileId}`, limit: SEARCHES_PER_MINUTE, windowMs: 60_000 });
    if (!limit.ok) throw new ApiError(429, "Juda ko‘p so‘rov, birozdan keyin urinib ko‘ring", "rate_limited");
    const query = parseSearchQuery(request.nextUrl.searchParams.get("q"));
    return ok({ drugs: query ? await searchDrugs(doctor, query) : [] });
  } catch (e) {
    return handleApiError(e);
  }
}

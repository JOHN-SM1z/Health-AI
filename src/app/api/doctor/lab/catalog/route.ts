import type { NextRequest } from "next/server";
import { requireLinkedDoctor } from "@/lib/auth/guards";
import { handleApiError, ok } from "@/lib/api/errors";
import { searchLabCatalog } from "@/lib/labs/ordering";

export const dynamic = "force-dynamic";

/**
 * What the calling doctor can order: the ACTIVE tests and panels of their own clinic, searchable by code,
 * name or section, with price, sample type, preparation and turnaround. Configuration, not clinical data —
 * no patient is involved. Inactive tests never appear (they cannot be newly ordered).
 */
export async function GET(request: NextRequest) {
  try {
    const doctor = await requireLinkedDoctor();
    return ok(await searchLabCatalog(doctor, request.nextUrl.searchParams.get("q") ?? ""));
  } catch (e) {
    return handleApiError(e);
  }
}

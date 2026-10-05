import type { NextRequest } from "next/server";
import { handleApiError, ok } from "@/lib/api/errors";
import { requireLabCapability } from "@/lib/labs/guards";
import { searchPatients } from "@/lib/labs/collection";

export const dynamic = "force-dynamic";

/** Finds a patient of the clinic for a walk-in order: name, date of birth, last phone digits. */
export async function GET(request: NextRequest) {
  try {
    const staff = await requireLabCapability("queue.read");
    return ok({ patients: await searchPatients(staff, request.nextUrl.searchParams.get("q") ?? "") });
  } catch (e) {
    return handleApiError(e);
  }
}

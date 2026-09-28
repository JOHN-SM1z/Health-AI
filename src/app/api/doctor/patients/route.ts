import type { NextRequest } from "next/server";
import { requireLinkedDoctor } from "@/lib/auth/guards";
import { handleApiError, ok } from "@/lib/api/errors";
import { listDoctorPatients } from "@/lib/clinical-access/patients";

export const dynamic = "force-dynamic";

/**
 * The calling doctor's patients: their own and those actively referred to
 * them, optionally filtered by ?q= (name or phone). Never another doctor's
 * patient, never another clinic's.
 */
export async function GET(request: NextRequest) {
  try {
    const doctor = await requireLinkedDoctor();
    const q = (request.nextUrl.searchParams.get("q") ?? "").slice(0, 80);
    return ok({ patients: await listDoctorPatients(doctor, q) });
  } catch (e) {
    return handleApiError(e);
  }
}

import type { NextRequest } from "next/server";
import { z } from "zod";
import { handleApiError, ok } from "@/lib/api/errors";
import { requireMiniAppPatientWith } from "@/lib/patients/mini-app-patient";
import { lookupOnlineIdentity } from "@/lib/patients/online-identity";

export const dynamic = "force-dynamic";

const schema = z.object({
  initData: z.string().nullable().optional(),
  document: z.string().trim().min(5).max(30),
  dateOfBirth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

/** Step 1: passport/ID or JSHSHIR + date of birth. The answer is the same whatever the database holds. */
export async function POST(request: NextRequest) {
  try {
    const { clinic, patient, body } = await requireMiniAppPatientWith(request, "mini-app-identity", schema);
    return ok(await lookupOnlineIdentity(clinic.id, patient, { document: body.document, dateOfBirth: body.dateOfBirth }));
  } catch (e) {
    return handleApiError(e);
  }
}

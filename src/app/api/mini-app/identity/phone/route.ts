import type { NextRequest } from "next/server";
import { z } from "zod";
import { handleApiError, ok } from "@/lib/api/errors";
import { requireMiniAppPatientWith } from "@/lib/patients/mini-app-patient";
import { confirmOnlinePhone } from "@/lib/patients/online-identity";

export const dynamic = "force-dynamic";

const schema = z.object({ initData: z.string().nullable().optional(), lookupId: z.string().uuid() });

/** Step 2: the phone the patient shared with the clinic's bot links their card, or they continue as a new patient. */
export async function POST(request: NextRequest) {
  try {
    const { clinic, patient, body } = await requireMiniAppPatientWith(request, "mini-app-identity", schema);
    return ok(await confirmOnlinePhone(clinic.id, patient, body.lookupId));
  } catch (e) {
    return handleApiError(e);
  }
}

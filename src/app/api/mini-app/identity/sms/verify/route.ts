import type { NextRequest } from "next/server";
import { z } from "zod";
import { handleApiError, ok } from "@/lib/api/errors";
import { requireMiniAppPatientWith } from "@/lib/patients/mini-app-patient";
import { verifyCardLinkCode } from "@/lib/patients/online-identity";

export const dynamic = "force-dynamic";

const schema = z.object({ initData: z.string().nullable().optional(), lookupId: z.string().uuid(), code: z.string().trim().max(6) });

/** The SMS code proves the card is the patient's: it is linked to their Telegram and its details appear. */
export async function POST(request: NextRequest) {
  try {
    const { clinic, patient, body } = await requireMiniAppPatientWith(request, "mini-app-identity", schema);
    return ok(await verifyCardLinkCode(clinic.id, patient, body.lookupId, body.code));
  } catch (e) {
    return handleApiError(e);
  }
}

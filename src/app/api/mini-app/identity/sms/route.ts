import type { NextRequest } from "next/server";
import { z } from "zod";
import { handleApiError, ok } from "@/lib/api/errors";
import { requireMiniAppPatientWith } from "@/lib/patients/mini-app-patient";
import { sendCardLinkCode } from "@/lib/patients/online-identity";

export const dynamic = "force-dynamic";

const schema = z.object({ initData: z.string().nullable().optional(), lookupId: z.string().uuid() });

/** A one-time code to the phone on the card the patient typed. Always the same answer: "sent if a card has a phone". */
export async function POST(request: NextRequest) {
  try {
    const { clinic, patient, body } = await requireMiniAppPatientWith(request, "mini-app-identity", schema);
    return ok(await sendCardLinkCode(clinic.id, patient, body.lookupId));
  } catch (e) {
    return handleApiError(e);
  }
}

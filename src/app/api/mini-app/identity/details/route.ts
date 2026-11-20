import type { NextRequest } from "next/server";
import { z } from "zod";
import { handleApiError, ok } from "@/lib/api/errors";
import { nameSchema } from "@/lib/api/validate";
import { requireMiniAppPatientWith } from "@/lib/patients/mini-app-patient";
import { completeOnlineDetails } from "@/lib/patients/online-identity";

export const dynamic = "force-dynamic";

const schema = z.object({
  initData: z.string().nullable().optional(),
  lookupId: z.string().uuid(),
  fullName: nameSchema,
  sex: z.enum(["female", "male"]).nullish(),
  homeAddress: z.string().trim().max(300).nullish(),
});

/** Step 3: a new patient's details, on their own record. The phone is the one Telegram verified, never typed. */
export async function POST(request: NextRequest) {
  try {
    const { clinic, patient, body } = await requireMiniAppPatientWith(request, "mini-app-identity", schema);
    return ok(
      await completeOnlineDetails(clinic.id, patient, {
        lookupId: body.lookupId,
        fullName: body.fullName,
        sex: body.sex ?? null,
        homeAddress: body.homeAddress || null,
      }),
    );
  } catch (e) {
    return handleApiError(e);
  }
}

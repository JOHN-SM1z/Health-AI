import { requireLinkedDoctor } from "@/lib/auth/guards";
import { handleApiError, ok } from "@/lib/api/errors";
import { listReferralRecipients } from "@/lib/referrals/service";

export const dynamic = "force-dynamic";

/** Colleagues the calling doctor can refer a patient to. */
export async function GET() {
  try {
    const doctor = await requireLinkedDoctor();
    return ok({ doctors: await listReferralRecipients(doctor) });
  } catch (e) {
    return handleApiError(e);
  }
}

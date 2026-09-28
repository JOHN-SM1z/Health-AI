import { requireLinkedDoctor } from "@/lib/auth/guards";
import { handleApiError, ok } from "@/lib/api/errors";
import { listReferralDepartments, listReferralRecipients } from "@/lib/referrals/service";

export const dynamic = "force-dynamic";

/** Departments and colleagues the calling doctor can refer a patient to. */
export async function GET() {
  try {
    const doctor = await requireLinkedDoctor();
    const [doctors, departments] = await Promise.all([listReferralRecipients(doctor), listReferralDepartments(doctor)]);
    return ok({ doctors, departments });
  } catch (e) {
    return handleApiError(e);
  }
}

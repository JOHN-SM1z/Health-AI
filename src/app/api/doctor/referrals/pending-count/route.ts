import { requireLinkedDoctor } from "@/lib/auth/guards";
import { createAdminClient } from "@/lib/supabase/admin";
import { handleApiError, ok } from "@/lib/api/errors";

export const dynamic = "force-dynamic";

/**
 * How many referrals await this doctor's answer — the number on the
 * "Yo‘llanmalar" link. A count only: no referral text is read, so polling it
 * leaves no clinical-access audit rows.
 */
export async function GET() {
  try {
    const doctor = await requireLinkedDoctor();
    const { count, error } = await createAdminClient()
      .from("referrals")
      .select("id", { count: "exact", head: true })
      .eq("clinic_id", doctor.clinicId)
      .eq("referred_to_doctor_id", doctor.doctorId)
      .eq("status", "pending")
      .gt("expires_at", new Date().toISOString());
    if (error) throw error;
    return ok({ pending: count ?? 0 });
  } catch (e) {
    return handleApiError(e);
  }
}

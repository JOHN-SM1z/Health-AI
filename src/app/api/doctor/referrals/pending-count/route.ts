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
      // Addressed to the doctor, or to their department while nobody has taken it (never one they raised).
      .or(
        doctor.specialtyId
          ? `referred_to_doctor_id.eq.${doctor.doctorId},and(referred_to_doctor_id.is.null,referred_to_specialty_id.eq.${doctor.specialtyId},referring_doctor_id.neq.${doctor.doctorId})`
          : `referred_to_doctor_id.eq.${doctor.doctorId}`,
      )
      .eq("status", "pending")
      .gt("expires_at", new Date().toISOString());
    if (error) throw error;
    return ok({ pending: count ?? 0 });
  } catch (e) {
    return handleApiError(e);
  }
}

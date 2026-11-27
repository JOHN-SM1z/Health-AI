import type { NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireRoles } from "@/lib/auth/guards";
import { uuidSchema } from "@/lib/api/validate";
import { handleApiError, ok } from "@/lib/api/errors";
import type { Database } from "@/lib/supabase/database.types";

export const dynamic = "force-dynamic";

type ReferralStatus = Database["public"]["Enums"]["referral_status"];

/**
 * GET /api/admin/referrals
 * Admin and receptionist overview of clinic referrals.
 * Optional query parameters:
 *   patientId - filter by specific patient
 *   doctorId - filter by referring or receiving doctor
 *   status - filter by referral status
 */
export async function GET(request: NextRequest) {
  try {
    const staff = await requireRoles("owner", "admin", "manager", "receptionist");
    const supabase = createAdminClient();

    const params = request.nextUrl.searchParams;
    const patientId = params.get("patientId") ? uuidSchema.parse(params.get("patientId")) : null;
    const doctorId = params.get("doctorId") ? uuidSchema.parse(params.get("doctorId")) : null;
    const status = params.get("status");

    let query = supabase
      .from("referrals")
      .select(
        `id, status, urgency:priority, referred_at:created_at, responded_at:accepted_at, completed_at, created_at,
         referring_doctor:doctors!referrals_referring_doctor_id_fkey(id, name, specialty_id, specialties(name)),
         receiving_doctor:doctors!referrals_referred_to_doctor_id_fkey(id, name, specialty_id, specialties(name)),
         patient:patients!referrals_patient_id_fkey(id, full_name, phone, telegram_username)`,
      )
      .eq("clinic_id", staff.clinicId)
      .order("created_at", { ascending: false })
      .limit(100);

    if (patientId) {
      query = query.eq("patient_id", patientId);
    }

    if (doctorId) {
      query = query.or(
        `referring_doctor_id.eq.${doctorId},referred_to_doctor_id.eq.${doctorId}`,
      );
    }

    const validStatuses: ReferralStatus[] = ["pending", "accepted", "declined", "completed"];
    if (status && validStatuses.includes(status as ReferralStatus)) {
      query = query.eq("status", status as ReferralStatus);
    }

    const { data, error } = await query;
    if (error) throw error;

    return ok({ referrals: data ?? [] });
  } catch (e) {
    return handleApiError(e);
  }
}

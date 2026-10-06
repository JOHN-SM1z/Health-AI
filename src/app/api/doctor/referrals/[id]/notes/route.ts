import type { NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireStaff } from "@/lib/auth/guards";
import { handleApiError, ApiError, ok } from "@/lib/api/errors";
import { assertReferralAccess } from "@/lib/referrals/access";

import { recordAudit } from "@/lib/audit";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * GET /api/doctor/referrals/[id]/notes
 * Fetches clinical notes and relevant appointment history for the referred patient.
 *
 * Security & Access Termination:
 * - Caller must have access to this referral (assertReferralAccess).
 * - Declined referrals do not grant access to medical history (403 referral_declined).
 * - Revoked referrals immediately lose all access (403 referral_revoked).
 * - Expired referrals immediately lose all access (403 referral_expired).
 * - Completed referrals: access is strictly scoped to records created during this
 *   referral consultation (referral_id) or authored by the caller doctor. General
 *   ongoing appointment history is withheld.
 * - Emits a tenant-isolated `clinical_records_viewed` audit event.
 */
export async function GET(_request: NextRequest, routeContext: RouteContext) {
  try {
    const ctx = await requireStaff("doctor");
    const { id } = await routeContext.params;
    const { referral, callerRole, callerDoctorId } = await assertReferralAccess(id, ctx);

    // 1. Terminate access if declined
    if (referral.status === "declined") {
      throw new ApiError(
        403,
        "Rad etilgan yo'llanma bo'yicha bemorning tibbiy tarixiga kirish taqiqlangan",
        "referral_declined",
      );
    }

    // 2. Terminate access immediately if revoked
    if (referral.status === "revoked" || referral.revoked_at) {
      throw new ApiError(
        403,
        "Bekor qilingan yo'llanma bo'yicha bemorning tibbiy tarixiga kirish taqiqlangan",
        "referral_revoked",
      );
    }

    // 3. Terminate access if expired
    const now = new Date().toISOString();
    if (referral.status === "expired" || (referral.expires_at && referral.expires_at <= now)) {
      throw new ApiError(
        403,
        "Muddati o'tgan yo'llanma bo'yicha bemorning tibbiy tarixiga kirish taqiqlangan",
        "referral_expired",
      );
    }

    const supabase = createAdminClient();

    // Fetch patient details
    const { data: patient, error: patientError } = await supabase
      .from("patients")
      .select("id, full_name, phone, telegram_username, created_at")
      .eq("id", referral.patient_id)
      .eq("clinic_id", ctx.clinicId)
      .single();

    if (patientError || !patient) {
      throw new ApiError(404, "Bemor topilmadi", "patient_not_found");
    }

    // Fetch clinical notes:
    // Filter private notes unless author is caller or caller is management
    let notesQuery = supabase
      .from("clinical_notes")
      .select(
        `id, title, content, note_type, is_private, created_at, updated_at, doctor_id, appointment_id,
         doctor:doctors!clinical_notes_doctor_id_fkey(id, name, specialties(name))`,
      )
      .eq("patient_id", referral.patient_id)
      .eq("clinic_id", ctx.clinicId)
      .order("created_at", { ascending: false });

    // 4. Completed referral access policy:
    // If the referral is completed, the receiving doctor may ONLY see notes
    // created under this referral or authored by themselves. They do not get
    // unrestricted ongoing access to the patient's wider medical/appointment history.
    const isCompleted = referral.status === "completed";

    if (callerRole === "receiving_doctor" && isCompleted) {
      if (callerDoctorId) {
        notesQuery = notesQuery.or(
          `and(referral_id.eq.${id},is_private.eq.false),doctor_id.eq.${callerDoctorId}`,
        );
      } else {
        notesQuery = notesQuery.eq("referral_id", id).eq("is_private", false);
      }
    } else if (callerRole !== "management") {
      // Non-management callers see non-private notes OR their own notes
      if (callerDoctorId) {
        notesQuery = notesQuery.or(
          `is_private.eq.false,doctor_id.eq.${callerDoctorId}`,
        );
      } else {
        notesQuery = notesQuery.eq("is_private", false);
      }
    }

    const { data: notes, error: notesError } = await notesQuery;
    if (notesError) throw notesError;

    // Fetch previous appointments history (withheld for completed receiving doctor access)
    let appointments: unknown[] = [];
    if (!isCompleted || callerRole !== "receiving_doctor") {
      const { data: apts, error: appointmentsError } = await supabase
        .from("appointments")
        .select(
          `id, start_time:start_at, end_time:end_at, status,
           doctor:doctors!appointments_doctor_id_fkey(id, name, specialties(name)),
           service:services!appointments_service_id_fkey(id, name, duration_minutes)`,
        )
        .eq("patient_id", referral.patient_id)
        .eq("clinic_id", ctx.clinicId)
        .order("start_at", { ascending: false });

      if (appointmentsError) throw appointmentsError;
      appointments = apts ?? [];
    }

    // 5. Emit tenant-isolated audit event for clinical record access
    await recordAudit({
      clinicId: ctx.clinicId,
      action: "clinical_records_viewed",
      entityType: "referrals",
      entityId: id,
      actor: { actorId: ctx.profileId, actorType: "staff" },
      metadata: {
        patientId: referral.patient_id,
        referralId: id,
        callerRole,
        referralStatus: referral.status,
      },
    });

    return ok({
      patient,
      referral,
      notes: notes ?? [],
      appointments,
    });
  } catch (e) {
    return handleApiError(e);
  }
}

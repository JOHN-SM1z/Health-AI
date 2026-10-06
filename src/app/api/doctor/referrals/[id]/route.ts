import type { NextRequest } from "next/server";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireStaff } from "@/lib/auth/guards";
import { handleApiError, ApiError, ok } from "@/lib/api/errors";
import { parseBody } from "@/lib/api/validate";
import { recordAudit } from "@/lib/audit";
import { assertReferralAccess } from "@/lib/referrals/access";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * Status values the API accepts.
 * - accepted     PENDING → ACCEPTED          (receiving doctor or management)
 * - declined     PENDING → DECLINED          (receiving doctor or management)
 * - in_progress  ACCEPTED → IN_PROGRESS      (receiving doctor — starts consultation)
 * - completed    ACCEPTED|IN_PROGRESS → COMPLETED (referring/receiving doctor or management)
 */
const updateReferralSchema = z.object({
  status: z.enum(["accepted", "declined", "in_progress", "completed", "revoked"]).optional(),
  reason: z.string().trim().max(1000).optional(),
}).strict();

/** Maps a status transition to a granular audit action string. */
function auditAction(
  from: string,
  to: string,
):
  | "referral_accepted"
  | "referral_declined"
  | "consultation_started"
  | "referral_completed"
  | "referral_revoked"
  | "referral_expired"
  | "referral_updated" {
  if (to === "accepted") return "referral_accepted";
  if (to === "declined") return "referral_declined";
  if (to === "in_progress") return "consultation_started";
  if (to === "completed") return "referral_completed";
  if (to === "revoked") return "referral_revoked";
  if (to === "expired") return "referral_expired";
  return "referral_updated";
}

/**
 * GET /api/doctor/referrals/[id]
 * Retrieves details of a specific referral including patient and doctor info.
 * Caller must be management, referring doctor, or receiving doctor.
 */
export async function GET(_request: NextRequest, routeContext: RouteContext) {
  try {
    const ctx = await requireStaff("doctor");
    const { id } = await routeContext.params;
    const { referral, callerRole, callerDoctorId } = await assertReferralAccess(id, ctx);
    const supabase = createAdminClient();

    // Audit the referral viewed event
    await recordAudit({
      clinicId: ctx.clinicId,
      action: "referral_viewed",
      entityType: "referrals",
      entityId: id,
      actor: { actorId: ctx.profileId, actorType: "staff" },
      metadata: {
        patientId: referral.patient_id,
        referralId: id,
        callerRole,
      },
    });

    const { data: fullReferral, error } = await supabase
      .from("referrals")
      .select(
        `id, clinic_id, patient_id, referring_doctor_id, referred_to_doctor_id, originating_appointment_id,
         status, priority, referral_reason, clinical_handoff_note, created_at, accepted_at, completed_at,
         updated_at, expires_at, revoked_at,
         referring_doctor:doctors!referrals_referring_doctor_id_fkey(id, name, specialty_id, specialties(name)),
         referred_to_doctor:doctors!referrals_referred_to_doctor_id_fkey(id, name, specialty_id, specialties(name)),
         patient:patients!referrals_patient_id_fkey(id, full_name, phone, telegram_username)`,
      )
      .eq("id", id)
      .eq("clinic_id", ctx.clinicId)
      .single();

    if (error || !fullReferral) {
      return ok({ referral, callerRole, callerDoctorId });
    }

    return ok({ referral: fullReferral, callerRole, callerDoctorId });
  } catch (e) {
    return handleApiError(e);
  }
}

/**
 * PATCH /api/doctor/referrals/[id]
 * Updates status or notes on a referral.
 *
 * Lifecycle transitions:
 *   - pending  → accepted:     receiving doctor or management
 *   - pending  → declined:     receiving doctor or management
 *   - accepted → in_progress:  receiving doctor (starts consultation); sets consultation_started audit
 *   - accepted | in_progress → completed: receiving doctor, referring doctor, or management
 *
 * Notes update: any involved party (referring, receiving, management).
 */
export async function PATCH(request: NextRequest, routeContext: RouteContext) {
  try {
    const ctx = await requireStaff("doctor");
    const { id } = await routeContext.params;
    const { referral, callerRole } = await assertReferralAccess(id, ctx);
    const body = await parseBody(request, updateReferralSchema);
    const supabase = createAdminClient();

    const updates: {
      status?: "accepted" | "declined" | "in_progress" | "completed" | "revoked";
      accepted_at?: string;
      completed_at?: string;
      revoked_at?: string;
      revoked_by?: string;
      revocation_reason?: string | null;
      clinical_handoff_note?: string;
      updated_by: string;
    } = {
      updated_by: ctx.profileId,
    };

    if (!body.status) throw new ApiError(400, "Holat ko‘rsatilishi shart");

    if (body.status) {
      switch (body.status) {
        case "accepted":
        case "declined": {
          if (referral.status !== "pending") {
            throw new ApiError(
              400,
              `Faqat kutilayotgan (pending) yo'llanmalarni qabul qilish yoki rad etish mumkin. Hozirgi holat: ${referral.status}`,
              "invalid_transition",
            );
          }
          if (callerRole !== "receiving_doctor" && callerRole !== "management") {
            throw new ApiError(
              403,
              "Faqat qabul qiluvchi shifokor yo'llanmani qabul qilishi yoki rad etishi mumkin",
              "forbidden",
            );
          }
          updates.status = body.status;
          if (body.status === "accepted") {
            updates.accepted_at = new Date().toISOString();
          }
          break;
        }

        case "in_progress": {
          // Accepting doctor starts the consultation — transitions accepted → in_progress
          if (referral.status !== "accepted") {
            throw new ApiError(
              400,
              `Konsultatsiyani boshlash uchun yo'llanma qabul qilingan (accepted) bo'lishi shart. Hozirgi holat: ${referral.status}`,
              "invalid_transition",
            );
          }
          if (callerRole !== "receiving_doctor" && callerRole !== "management") {
            throw new ApiError(
              403,
              "Faqat qabul qiluvchi shifokor konsultatsiyani boshlashi mumkin",
              "forbidden",
            );
          }
          updates.status = "in_progress";
          break;
        }

        case "completed": {
          if (!["pending", "accepted", "in_progress"].includes(referral.status)) {
            throw new ApiError(
              400,
              `Faqat faol yo'llanma yakunlanadi. Hozirgi holat: ${referral.status}`,
              "invalid_transition",
            );
          }
          updates.status = "completed";
          updates.completed_at = new Date().toISOString();
          break;
        }

        case "revoked": {
          // Revocation is permitted for the referring doctor or management only
          if (callerRole !== "referring_doctor" && callerRole !== "management") {
            throw new ApiError(
              403,
              "Faqat yo'llanma bergan shifokor yoki ma'muriyat yo'llanmani bekor qilishi mumkin",
              "forbidden",
            );
          }
          if (!["pending", "accepted", "in_progress"].includes(referral.status)) {
            throw new ApiError(
              400,
              `Yakunlangan, rad etilgan yoki muddati o'tgan yo'llanmani bekor qilib bo'lmaydi. Hozirgi holat: ${referral.status}`,
              "invalid_transition",
            );
          }
          updates.status = "revoked";
          updates.revoked_at = new Date().toISOString();
          updates.revoked_by = ctx.profileId;
          updates.revocation_reason = body.reason ?? null;
          break;
        }
      }
    }

    const { data: updatedReferral, error } = await supabase
      .from("referrals")
      .update(updates)
      .eq("id", id)
      .eq("clinic_id", ctx.clinicId)
      .eq("status", referral.status)
      .select(
        `id, clinic_id, patient_id, referring_doctor_id, referred_to_doctor_id, originating_appointment_id,
         status, priority, referral_reason, clinical_handoff_note, created_at, accepted_at, completed_at,
         updated_at, expires_at, revoked_at,
         referring_doctor:doctors!referrals_referring_doctor_id_fkey(id, name, specialty_id, specialties(name)),
         referred_to_doctor:doctors!referrals_referred_to_doctor_id_fkey(id, name, specialty_id, specialties(name)),
         patient:patients!referrals_patient_id_fkey(id, full_name, phone, telegram_username)`,
      )
      .single();

    if (error || !updatedReferral) {
      throw new ApiError(409, "Yo‘llanma o‘zgargan. Yangilang va qayta urinib ko‘ring");
    }

    // Emit a granular audit event that names the exact lifecycle transition.
    const action = body.status
      ? auditAction(referral.status, body.status)
      : "referral_updated";

    await recordAudit({
      clinicId: ctx.clinicId,
      action,
      entityType: "referrals",
      entityId: id,
      actor: { actorId: ctx.profileId, actorType: "staff" },
      oldValues: { status: referral.status },
      newValues: {
        status: updatedReferral.status,
      },
      metadata: {
        patientId: referral.patient_id,
        referralId: id,
        callerRole,
      },
    });

    return ok({ referral: updatedReferral });
  } catch (e) {
    return handleApiError(e);
  }
}

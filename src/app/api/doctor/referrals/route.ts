import type { NextRequest } from "next/server";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireStaff } from "@/lib/auth/guards";
import { handleApiError, ApiError, ok } from "@/lib/api/errors";
import { parseBody, uuidSchema } from "@/lib/api/validate";
import { recordAudit } from "@/lib/audit";
import { requireLinkedDoctor } from "@/lib/referrals/access";

export const dynamic = "force-dynamic";

const createReferralSchema = z.object({
  patientId: uuidSchema,
  receivingDoctorId: uuidSchema,
  originatingAppointmentId: uuidSchema.optional(),
  urgency: z.enum(["routine", "urgent", "emergency"]).default("routine"),
  reason: z.string().trim().min(1, "Yo'llanma sababi kiritilishi shart").max(1000),
  notes: z.string().trim().max(10000).optional(),
  expiresAt: z.string().datetime({ offset: true }).or(z.string().datetime()).optional(),
  idempotencyKey: z.string().trim().max(128).optional(),
});

/**
 * GET /api/doctor/referrals
 * Lists referrals involving the authenticated doctor (both incoming and outgoing).
 * Query params:
 *   direction=incoming|outgoing|all (default: all)
 *   status=pending|accepted|declined|completed (optional filter)
 */
export async function GET(request: NextRequest) {
  try {
    const ctx = await requireStaff("doctor");
    const doctor = await requireLinkedDoctor(ctx);
    const supabase = createAdminClient();

    const params = request.nextUrl.searchParams;
    const direction = params.get("direction") ?? "all";
    const status = params.get("status");

    let query = supabase
      .from("referrals")
      .select(
        `id, patient_id, status, expires_at, priority, referral_reason, clinical_handoff_note, created_at, accepted_at, completed_at,
         referring_doctor:doctors!referrals_referring_doctor_id_fkey(id, name, specialty_id, specialties(name)),
         referred_to_doctor:doctors!referrals_referred_to_doctor_id_fkey(id, name, specialty_id, specialties(name)),
         patient:patients!referrals_patient_id_fkey(id, full_name, phone, telegram_username)`,
      )
      .eq("clinic_id", ctx.clinicId);

    if (direction === "incoming") {
      query = query.eq("referred_to_doctor_id", doctor.id);
    } else if (direction === "outgoing") {
      query = query.eq("referring_doctor_id", doctor.id);
    } else {
      // all: must be referring OR receiving
      query = query.or(
        `referring_doctor_id.eq.${doctor.id},referred_to_doctor_id.eq.${doctor.id}`,
      );
    }

    const validStatuses = [
      "pending",
      "accepted",
      "in_progress",
      "completed",
      "declined",
      "expired",
      "revoked",
    ] as const;
    type ValidStatus = (typeof validStatuses)[number];

    if (status && validStatuses.includes(status as ValidStatus)) {
      query = query.eq("status", status as ValidStatus);
    }

    const { data, error } = await query
      .order("created_at", { ascending: false })
      .limit(100);
    if (error) throw error;

    return ok({ referrals: data ?? [] });
  } catch (e) {
    return handleApiError(e);
  }
}

/**
 * POST /api/doctor/referrals
 * Creates a new referral. The caller must be a doctor in the clinic. The
 * receiving doctor must also belong to the same clinic. The patient must also
 * belong to the same clinic. All three constraints are enforced by the DB
 * trigger (referrals_check_same_clinic) in addition to the application layer.
 */
export async function POST(request: NextRequest) {
  try {
    const ctx = await requireStaff("doctor");
    const doctor = await requireLinkedDoctor(ctx);
    const body = await parseBody(request, createReferralSchema);
    const supabase = createAdminClient();

    // 1. Idempotency Key check (body or header)
    const idempotencyKey =
      body.idempotencyKey ??
      request.headers.get("x-idempotency-key") ??
      request.headers.get("idempotency-key") ??
      undefined;

    if (idempotencyKey) {
      const { data: existingByKey } = await supabase
        .from("referrals")
        .select("*")
        .eq("clinic_id", ctx.clinicId)
        .eq("created_by", ctx.profileId)
        .eq("idempotency_key", idempotencyKey)
        .maybeSingle();

      if (existingByKey) {
        assertSameRequest(existingByKey, body);
        return ok({ referral: existingByKey, idempotentReplay: true }, { status: 200 });
      }
    } else {
      // Prevent accidental double-submission within 15 seconds
      const recentWindow = new Date(Date.now() - 15_000).toISOString();
      const { data: recentDup } = await supabase
        .from("referrals")
        .select("*")
        .eq("clinic_id", ctx.clinicId)
        .eq("patient_id", body.patientId)
        .eq("referring_doctor_id", doctor.id)
        .eq("referred_to_doctor_id", body.receivingDoctorId)
        .eq("referral_reason", body.reason)
        .eq("status", "pending")
        .gte("created_at", recentWindow)
        .maybeSingle();

      if (recentDup) {
        return ok({ referral: recentDup, duplicatePrevented: true }, { status: 200 });
      }
    }

    // 2. Verify the receiving doctor exists and belongs to the same clinic.
    const { data: receivingDoctor } = await supabase
      .from("doctors")
      .select("id, name, clinic_id")
      .eq("id", body.receivingDoctorId)
      .eq("clinic_id", ctx.clinicId)
      .eq("active", true)
      .maybeSingle();

    if (!receivingDoctor) {
      throw new ApiError(
        404,
        "Qabul qiluvchi shifokor klinikangizda topilmadi",
        "receiving_doctor_not_found",
      );
    }

    if (receivingDoctor.id === doctor.id) {
      throw new ApiError(
        400,
        "O'zingizga yo'llanma bera olmaysiz",
        "self_referral",
      );
    }

    // 3. Verify the patient exists and belongs to the same clinic.
    const { data: patient } = await supabase
      .from("patients")
      .select("id, full_name, clinic_id")
      .eq("id", body.patientId)
      .eq("clinic_id", ctx.clinicId)
      .maybeSingle();

    if (!patient) {
      throw new ApiError(404, "Bemor klinikangizda topilmadi", "patient_not_found");
    }

    // 4. Verify referring doctor has authorized clinical access to this patient
    //    Uses the centralized authorization function.
    const { canDoctorAccessPatientClinicalData } = await import("@/lib/referrals/access");
    let accessResult;
    try {
      accessResult = await canDoctorAccessPatientClinicalData(
        ctx.profileId,
        body.patientId,
        ctx.clinicId,
        ctx.roles,
      );
    } catch {
      // If the access check fails (e.g., DB errors), treat as no access to prevent leaking internal errors
      throw new ApiError(
        403,
        "Ushbu bemor bo'yicha yo'llanma berish huquqiga ega emassiz",
        "unauthorized_patient_access",
      );
    }

    if (accessResult.level === "none") {
      throw new ApiError(
        403,
        "Ushbu bemor bo'yicha yo'llanma berish huquqiga ega emassiz",
        "unauthorized_patient_access",
      );
    }

    // 5. Calculate expiration: never leave referral open-ended
    let calculatedExpiresAt: string;
    if (body.expiresAt) {
      const expTime = new Date(body.expiresAt).getTime();
      const nowTime = Date.now();
      if (isNaN(expTime) || expTime <= nowTime) {
        throw new ApiError(400, "Amal qilish muddati kelajakda bo'lishi shart", "invalid_expiration");
      }
      const maxTime = nowTime + 90 * 24 * 60 * 60 * 1000;
      if (expTime > maxTime) {
        throw new ApiError(400, "Amal qilish muddati ko'pi bilan 90 kun bo'lishi mumkin", "expiration_too_long");
      }
      calculatedExpiresAt = new Date(expTime).toISOString();
    } else {
      const days = body.urgency === "emergency" ? 2 : body.urgency === "urgent" ? 7 : 30;
      calculatedExpiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
    }

    // 6. Insert referral
    const { data: referral, error } = await supabase
      .from("referrals")
      .insert({
        clinic_id: ctx.clinicId,
        patient_id: body.patientId,
        referring_doctor_id: doctor.id,
        referred_to_doctor_id: body.receivingDoctorId,
        originating_appointment_id: body.originatingAppointmentId ?? null,
        priority: body.urgency,
        referral_reason: body.reason,
        clinical_handoff_note: body.notes ?? null,
        expires_at: calculatedExpiresAt,
        idempotency_key: idempotencyKey ?? null,
        created_by: ctx.profileId,
        updated_by: ctx.profileId,
      })
      .select("*")
      .single();

    if (error) {
      if (error.message.includes("referrals_check_same_clinic") || error.message.includes("must all belong to clinic")) {
        throw new ApiError(400, "Shifokor yoki bemor klinikaga tegishli emas", "clinic_mismatch");
      }
      if (error.message.includes("referrals_clinic_idempotency_key_idx") || error.code === "23505") {
        // Unique constraint violation on idempotency key
        const { data: existing } = await supabase
          .from("referrals")
          .select("*")
          .eq("clinic_id", ctx.clinicId)
          .eq("created_by", ctx.profileId)
          .eq("idempotency_key", idempotencyKey!)
          .maybeSingle();
        if (existing) {
          assertSameRequest(existing, body);
          return ok({ referral: existing, idempotentReplay: true }, { status: 200 });
        }
      }
      throw new ApiError(500, "Yo'llanmani yaratib bo'lmadi");
    }

    // 7. Record audit event
    await recordAudit({
      clinicId: ctx.clinicId,
      action: "referral_created",
      entityType: "referrals",
      entityId: referral.id,
      actor: { actorId: ctx.profileId, actorType: "staff" },
      metadata: {
        patientId: body.patientId,
        referralId: referral.id,
        priority: body.urgency,
      },
      newValues: {
        referring_doctor_id: doctor.id,
        referred_to_doctor_id: body.receivingDoctorId,
        patient_id: body.patientId,
        originating_appointment_id: body.originatingAppointmentId ?? null,
        priority: body.urgency,
        expires_at: calculatedExpiresAt,
        idempotency_key: idempotencyKey ?? null,
      },
    });

    return ok({ referral }, { status: 201 });
  } catch (e) {
    return handleApiError(e);
  }
}

function assertSameRequest(row: { patient_id: string; referred_to_doctor_id: string; referral_reason: string; clinical_handoff_note: string | null; priority: string; originating_appointment_id: string | null }, body: z.infer<typeof createReferralSchema>) {
  if (row.patient_id !== body.patientId || row.referred_to_doctor_id !== body.receivingDoctorId ||
      row.referral_reason !== body.reason || row.clinical_handoff_note !== (body.notes ?? null) ||
      row.priority !== body.urgency || row.originating_appointment_id !== (body.originatingAppointmentId ?? null)) {
    throw new ApiError(409, "Takroriy so'rov kaliti boshqa ma'lumot bilan ishlatilgan", "idempotency_conflict");
  }
}

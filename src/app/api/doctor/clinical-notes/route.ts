import type { NextRequest } from "next/server";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireStaff } from "@/lib/auth/guards";
import { handleApiError, ApiError, ok } from "@/lib/api/errors";
import { parseBody, uuidSchema } from "@/lib/api/validate";
import { recordAudit } from "@/lib/audit";
import { requireLinkedDoctor, requirePatientClinicalAccess } from "@/lib/referrals/access";

export const dynamic = "force-dynamic";

/**
 * All supported note types. The first three are legacy values kept for
 * backward compatibility with notes created before Phase 2.
 *
 * Clinical record taxonomy (Phase 2):
 *   historical_diagnosis  — pre-existing diagnosis authored by another doctor
 *   current_assessment    — receiving doctor's working assessment
 *   new_diagnosis         — formal new diagnosis authored by receiving doctor
 *   clinical_note         — general free-text clinical note
 *   prescription          — medication order
 *   laboratory_order      — lab test / investigation order
 *   follow_up_referral    — follow-up or onward referral note
 */
const NOTE_TYPES = [
  // Legacy
  "encounter",
  "referral_summary",
  "follow_up",
  // Phase-2 extended set
  "historical_diagnosis",
  "current_assessment",
  "new_diagnosis",
  "clinical_note",
  "prescription",
  "laboratory_order",
  "follow_up_referral",
] as const;

type NoteType = (typeof NOTE_TYPES)[number];

const createNoteSchema = z.object({
  patientId: uuidSchema,
  appointmentId: uuidSchema.optional(),
  visitId: uuidSchema.optional(),
  /**
   * Referral that prompted this note. When provided the note is explicitly
   * linked to the referral consultation. The caller must have valid access
   * to both the patient and the referral — the referral must be in a
   * non-declined, non-revoked, non-expired state.
   */
  referralId: uuidSchema.optional(),
  title: z.string().trim().min(1, "Sarlavha kiritilishi shart").max(200),
  content: z.string().trim().min(1, "Qayd mazmuni kiritilishi shart").max(10000),
  noteType: z.enum(NOTE_TYPES).default("clinical_note"),
  isPrivate: z.boolean().default(false),
});

/**
 * GET /api/doctor/clinical-notes?patientId=...
 * Retrieves clinical notes for a patient.
 *
 * Authorization enforced via `requirePatientClinicalAccess`:
 *   - own_patient  → own private notes + all non-private
 *   - referral     → shared notes and caller-authored private notes
 *   - none         → 403
 */
export async function GET(request: NextRequest) {
  try {
    const ctx = await requireStaff("doctor");
    const supabase = createAdminClient();

    const patientId = request.nextUrl.searchParams.get("patientId");
    if (!patientId) {
      throw new ApiError(400, "patientId parametri ko'rsatilishi shart", "missing_patient_id");
    }

    const access = await requirePatientClinicalAccess(ctx, patientId);

    let query = supabase
      .from("clinical_notes")
      .select(
        `id, title, content, note_type, is_private, created_at, updated_at,
         doctor_id, appointment_id, visit_id, referral_id,
         doctor:doctors!clinical_notes_doctor_id_fkey(id, name, specialties(name))`,
      )
      .eq("clinic_id", ctx.clinicId)
      .eq("patient_id", patientId)
      .order("created_at", { ascending: false });

    if (!access.doctorId) throw new ApiError(403, "Shifokor kirishi talab qilinadi");
    query = query.or(`is_private.eq.false,doctor_id.eq.${access.doctorId}`);

    const { data: notes, error } = await query;
    if (error) throw error;

    await recordAudit({ clinicId: ctx.clinicId, action: "clinical_records_viewed",
      entityType: "patients", entityId: patientId,
      actor: { actorId: ctx.profileId, actorType: "staff" } });
    return ok({ notes: notes ?? [], accessLevel: access.level });
  } catch (e) {
    return handleApiError(e);
  }
}

/**
 * POST /api/doctor/clinical-notes
 * Creates a new clinical note for a patient.
 *
 * New records are always authored by the calling doctor (doctor_id = caller's
 * doctor row). Historical records authored by other doctors are never modified
 * by this endpoint — each POST creates a new, attributed row.
 *
 * When `referralId` is provided:
 *   1. The referral must exist and belong to the caller's clinic.
 *   2. The referral's patient must match `patientId`.
 *   3. The referral must not be declined, revoked, or expired.
 *   4. The note is linked to the referral via `referral_id`.
 */
export async function POST(request: NextRequest) {
  try {
    const ctx = await requireStaff("doctor");
    const doctor = await requireLinkedDoctor(ctx);
    const body = await parseBody(request, createNoteSchema);
    const supabase = createAdminClient();

    await requirePatientClinicalAccess(ctx, body.patientId);

    // 1. Verify patient belongs to clinic
    const { data: patient } = await supabase
      .from("patients")
      .select("id")
      .eq("id", body.patientId)
      .eq("clinic_id", ctx.clinicId)
      .maybeSingle();

    if (!patient) {
      throw new ApiError(404, "Bemor klinikangizda topilmadi", "patient_not_found");
    }

    // 2. Verify appointment if provided
    if (body.appointmentId) {
      const { data: appointment } = await supabase
        .from("appointments")
        .select("id")
        .eq("id", body.appointmentId)
        .eq("patient_id", body.patientId).eq("doctor_id", doctor.id)
        .eq("clinic_id", ctx.clinicId)
        .maybeSingle();

      if (!appointment) {
        throw new ApiError(404, "Qabul topilmadi", "appointment_not_found");
      }
    }

    if (body.visitId) {
      const { data: visit, error } = await supabase.from("visits").select("id")
        .eq("id", body.visitId).eq("clinic_id", ctx.clinicId)
        .eq("patient_id", body.patientId).eq("doctor_id", doctor.id)
        .neq("status", "cancelled").maybeSingle();
      if (error || !visit) throw new ApiError(403, "Bu tashrifga qayd yozish huquqi yo'q");
    }
    // 3. Verify referral if provided
    if (body.referralId) {
      const { data: referral } = await supabase
        .from("referrals")
        .select("id, patient_id, status, revoked_at, expires_at")
        .eq("id", body.referralId)
        .or(`referring_doctor_id.eq.${doctor.id},referred_to_doctor_id.eq.${doctor.id}`)
        .eq("clinic_id", ctx.clinicId)
        .maybeSingle();

      if (!referral) {
        throw new ApiError(404, "Yo'llanma topilmadi", "referral_not_found");
      }

      // Referral must be for the same patient
      if (referral.patient_id !== body.patientId) {
        throw new ApiError(
          400,
          "Yo'llanma ushbu bemor uchun emas",
          "referral_patient_mismatch",
        );
      }

      // Referral must be active (not declined, not revoked, not expired, not completed)
      const now = new Date().toISOString();
      const isDeclined = referral.status === "declined";
      const isRevoked = !!referral.revoked_at;
      const isExpired = !referral.expires_at || referral.expires_at <= now || referral.status === "expired";
      const isCompleted = referral.status === "completed";

      if (isDeclined || isRevoked || isExpired || isCompleted) {
        throw new ApiError(
          400,
          "Bekor qilingan, muddati o'tgan yoki yakunlangan yo'llanmaga qayd yozib bo'lmaydi",
          "referral_not_active",
        );
      }
    }

    // 4. Insert note — always authored by the calling doctor
    const { data: note, error } = await supabase
      .from("clinical_notes")
      .insert({
        clinic_id: ctx.clinicId,
        patient_id: body.patientId,
        doctor_id: doctor.id,           // immutable authorship — never overwritten
        appointment_id: body.appointmentId ?? null,
        visit_id: body.visitId ?? null,
        referral_id: body.referralId ?? null,
        title: body.title,
        content: body.content,
        note_type: body.noteType as NoteType,
        is_private: body.isPrivate,
      })
      .select(
        `id, title, content, note_type, is_private, created_at, updated_at,
         doctor_id, appointment_id, visit_id, referral_id,
         doctor:doctors!clinical_notes_doctor_id_fkey(id, name, specialties(name))`,
      )
      .single();

    if (error || !note) {
      throw new ApiError(500, "Qaydni saqlab bo'lmadi");
    }

    await recordAudit({
      clinicId: ctx.clinicId,
      action: "clinical_note_created",
      entityType: "clinical_notes",
      entityId: note.id,
      actor: { actorId: ctx.profileId, actorType: "staff" },
      newValues: {
        patient_id: body.patientId,
        doctor_id: doctor.id,
        note_type: body.noteType,
        is_private: body.isPrivate,
        referral_id: body.referralId ?? null,
      },
    });

    return ok({ note }, { status: 201 });
  } catch (e) {
    return handleApiError(e);
  }
}

import "server-only";
import { patientRecordIds } from "@/lib/patients/record-group";
import { createAdminClient } from "@/lib/supabase/admin";
import { ApiError } from "@/lib/api/errors";
import { logger } from "@/lib/logger";
import type { LinkedDoctor } from "@/lib/auth/guards";
import type { Database } from "@/lib/supabase/database.types";
import { canDoctorAccessPatientClinicalData, type ClinicalAccess } from "@/lib/clinical-access/access";
import { patientAccessDenied } from "@/lib/clinical-access/denial";

/**
 * Doctor-authored clinical records (public.clinical_records). Reading follows
 * the clinical access decision exactly — a record is visible where its
 * consultation is — and writing is only ever the calling doctor documenting
 * their own consultation with this patient. Clinical text is never logged.
 */

export type ClinicalRecordType = Database["public"]["Enums"]["clinical_record_type"];

export type ClinicalRecordView = {
  id: string;
  type: ClinicalRecordType;
  summary: string;
  details: string | null;
  code: string | null;
  createdAt: string;
  /** The consultation the record was written in. */
  appointmentId: string;
  author: { id: string; name: string | null };
  /** Written by the calling doctor. */
  mine: boolean;
  correctsRecordId: string | null;
  /** The later record that corrects this one, if any. */
  correctedByRecordId: string | null;
};

type RecordRow = {
  id: string;
  record_type: ClinicalRecordType;
  summary: string;
  details: string | null;
  code: string | null;
  created_at: string;
  appointment_id: string;
  author_doctor_id: string;
  corrects_record_id: string | null;
  author: { name: string } | null;
};

/** The records of `patientId` that `access` covers for `doctor`, newest first. */
export async function listVisibleClinicalRecords(
  doctor: LinkedDoctor,
  patientId: string,
  access: ClinicalAccess,
): Promise<ClinicalRecordView[]> {
  if (!access.allowed) return [];
  // The same coverage as the appointments the doctor may read: a record's
  // author is its consultation's doctor (foreign key).
  const authors = [...(access.scope.ownAppointments ? [doctor.doctorId] : []), ...access.scope.sharedHistoryDoctorIds];
  const coverage = [
    authors.length > 0 ? `author_doctor_id.in.(${authors.join(",")})` : null,
    access.scope.referralAppointmentIds.length > 0 ? `appointment_id.in.(${access.scope.referralAppointmentIds.join(",")})` : null,
  ].filter(Boolean);
  if (coverage.length === 0) return [];

  // Every record of the person's merged record group (Phase 14), same coverage.
  const ids = await patientRecordIds(doctor.clinicId, patientId);
  const { data, error } = await createAdminClient()
    .from("clinical_records")
    .select(
      "id, record_type, summary, details, code, created_at, appointment_id, author_doctor_id, corrects_record_id, author:doctors!clinical_records_author_same_clinic_fkey(name)",
    )
    .eq("clinic_id", doctor.clinicId)
    .in("patient_id", ids)
    .or(coverage.join(","))
    .order("created_at", { ascending: false })
    .limit(500);
  if (error) throw new ApiError(500, "Tibbiy yozuvlarni yuklab bo‘lmadi");

  const rows = (data ?? []) as unknown as RecordRow[];
  const correctedBy = new Map(rows.filter((r) => r.corrects_record_id).map((r) => [r.corrects_record_id!, r.id]));
  return rows.map((r) => ({
    id: r.id,
    type: r.record_type,
    summary: r.summary,
    details: r.details,
    code: r.code,
    createdAt: r.created_at,
    appointmentId: r.appointment_id,
    author: { id: r.author_doctor_id, name: r.author?.name ?? null },
    mine: r.author_doctor_id === doctor.doctorId,
    correctsRecordId: r.corrects_record_id,
    correctedByRecordId: correctedBy.get(r.id) ?? null,
  }));
}

export type CreateClinicalRecordInput = {
  idempotencyKey: string;
  appointmentId: string;
  recordType: ClinicalRecordType;
  summary: string;
  details?: string | null;
  code?: string | null;
  correctsRecordId?: string | null;
};

type KeyedRecord = {
  id: string;
  patient_id: string;
  appointment_id: string;
  record_type: ClinicalRecordType;
  summary: string;
  details: string | null;
  code: string | null;
  corrects_record_id: string | null;
};

async function findByCreationKey(doctor: LinkedDoctor, key: string): Promise<KeyedRecord | null> {
  const { data, error } = await createAdminClient()
    .from("clinical_records")
    .select("id, patient_id, appointment_id, record_type, summary, details, code, corrects_record_id")
    .eq("clinic_id", doctor.clinicId)
    .eq("author_doctor_id", doctor.doctorId)
    .eq("creation_key", key)
    .maybeSingle();
  if (error) throw new ApiError(500, "Yozuvni tekshirib bo‘lmadi");
  return data;
}

function replay(previous: KeyedRecord, patientId: string, input: CreateClinicalRecordInput) {
  const same =
    previous.patient_id === patientId &&
    previous.appointment_id === input.appointmentId &&
    previous.record_type === input.recordType &&
    previous.summary === input.summary &&
    previous.details === (input.details || null) &&
    previous.code === (input.code || null) &&
    previous.corrects_record_id === (input.correctsRecordId || null);
  if (!same) throw new ApiError(409, "Bu so‘rov boshqa ma‘lumotlar bilan allaqachon yuborilgan", "idempotency_key_reused");
  return { id: previous.id, replayed: true };
}

function recordError(error: { code?: string; message?: string }): ApiError {
  const message = error.message ?? "";
  if (error.code === "23505" && message.includes("clinical_records_one_correction")) {
    return new ApiError(409, "Bu yozuv allaqachon tuzatilgan", "already_corrected");
  }
  if (message.includes("correct their own record") || message.includes("keeps the consultation")) {
    return new ApiError(409, "Faqat o‘z yozuvingizni, o‘sha qabul va turda tuzatish mumkin", "correction_not_allowed");
  }
  if (message.includes("must be in progress or completed")) {
    return new ApiError(409, "Yozuv faqat boshlangan yoki yakunlangan qabulga qo‘shiladi", "consultation_not_active");
  }
  if (error.code === "23503") return new ApiError(404, "Qabul topilmadi", "consultation_not_found");
  if (error.code === "23514" || error.code === "23502") return new ApiError(400, "Yozuv ma‘lumotlari noto‘g‘ri", "validation");
  // Only the code: a database error's detail can echo the clinical text.
  logger.error("clinical record write failed", { code: error.code });
  return new ApiError(500, "Yozuvni saqlab bo‘lmadi", "record_write_failed");
}

/**
 * The calling doctor documents their own consultation with `patientId`
 * (taken from the URL and re-checked against the consultation). Idempotent
 * per `idempotencyKey`.
 */
export async function createClinicalRecord(
  doctor: LinkedDoctor,
  patientId: string,
  input: CreateClinicalRecordInput,
): Promise<{ id: string; replayed: boolean }> {
  const previous = await findByCreationKey(doctor, input.idempotencyKey);
  if (previous) return replay(previous, patientId, input);

  const access = await canDoctorAccessPatientClinicalData(doctor.doctorId, patientId);
  if (!access.allowed) throw await patientAccessDenied(doctor, patientId);

  const supabase = createAdminClient();
  // The doctor's own consultation with THIS patient — an appointment of any
  // other patient or doctor is simply not found.
  const { data: consultation, error } = await supabase
    .from("appointments")
    .select("id, status")
    .eq("id", input.appointmentId)
    .eq("clinic_id", doctor.clinicId)
    .eq("patient_id", patientId)
    .eq("doctor_id", doctor.doctorId)
    .maybeSingle();
  if (error) throw new ApiError(500, "Qabulni tekshirib bo‘lmadi");
  if (!consultation) throw new ApiError(404, "Qabul topilmadi", "consultation_not_found");
  if (consultation.status !== "in_progress" && consultation.status !== "completed") {
    throw new ApiError(409, "Yozuv faqat boshlangan yoki yakunlangan qabulga qo‘shiladi", "consultation_not_active");
  }

  const { data, error: insertError } = await supabase
    .from("clinical_records")
    .insert({
      clinic_id: doctor.clinicId,
      patient_id: patientId,
      author_doctor_id: doctor.doctorId,
      appointment_id: consultation.id,
      record_type: input.recordType,
      summary: input.summary,
      details: input.details || null,
      code: input.code || null,
      corrects_record_id: input.correctsRecordId || null,
      created_by: doctor.profileId,
      creation_key: input.idempotencyKey,
    })
    .select("id")
    .single();
  if (insertError) {
    if (insertError.code === "23505") {
      const winner = await findByCreationKey(doctor, input.idempotencyKey);
      if (winner) return replay(winner, patientId, input);
    }
    throw recordError(insertError);
  }
  return { id: data.id, replayed: false };
}

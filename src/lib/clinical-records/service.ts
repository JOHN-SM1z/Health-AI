import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { ApiError } from "@/lib/api/errors";
import { recordAudit, recordAudits, type AuditEvent } from "@/lib/audit";
import { logger } from "@/lib/logger";
import type { LinkedDoctor } from "@/lib/auth/guards";
import type { Database } from "@/lib/supabase/database.types";
import { canDoctorAccessPatientClinicalData, canSeeAppointment, type ClinicalAccess } from "@/lib/clinical-access/access";
import { patientAccessDenied } from "@/lib/clinical-access/denial";

/**
 * Doctor-authored clinical records (public.clinical_records). Reading follows
 * the clinical access decision exactly — a record is visible where its
 * consultation is — and writing is only ever the calling doctor documenting
 * their own consultation with this patient. Clinical text is never logged.
 *
 * Records are versioned and append-only. Only the doctor who wrote a record
 * — the same doctor record AND the same login — may correct it, and only its
 * current version: the correction is saved as the next version and the one
 * it replaces stays, superseded, in the record's history. A doctor who
 * disagrees with a colleague's record writes their own record in their own
 * consultation instead. The database enforces all of this independently
 * (supabase/migrations/20261001000001_clinical_record_governance.sql); the
 * checks here give the caller a precise answer and an audited refusal.
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
  /** Written by the calling doctor (this login) — the only records they may correct. */
  mine: boolean;
  /** The record's version: 1 for an original, n + 1 after each correction. */
  version: number;
  /** The first version of this record — the id its history is kept under. */
  rootRecordId: string;
};

export type ClinicalRecordVersion = {
  id: string;
  version: number;
  status: "current" | "superseded";
  summary: string;
  details: string | null;
  code: string | null;
  createdAt: string;
  author: { id: string; name: string | null };
  /** When a later version replaced this one (superseded versions only). */
  supersededAt: string | null;
};

export type ClinicalRecordHistory = {
  rootRecordId: string;
  type: ClinicalRecordType;
  appointmentId: string;
  /** Oldest first; the last one is the current version. */
  versions: ClinicalRecordVersion[];
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
  created_by: string;
  root_record_id: string;
  version: number;
  author: { name: string } | null;
};

const isMine = (doctor: LinkedDoctor, row: { author_doctor_id: string; created_by: string }) =>
  row.author_doctor_id === doctor.doctorId && row.created_by === doctor.profileId;

/**
 * The CURRENT version of every record of `patientId` that `access` covers for
 * `doctor`, newest first. Superseded versions are left out: they are kept in
 * each record's history (getClinicalRecordHistory), not shown as findings.
 */
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

  // Current versions are picked by the database before the limit, so no
  // number of corrections can push another record out of the list.
  const { data, error } = await createAdminClient()
    .from("clinical_record_versions")
    .select(
      "id, record_type, summary, details, code, created_at, appointment_id, author_doctor_id, created_by, root_record_id, version, author:doctors!clinical_records_author_same_clinic_fkey(name)",
    )
    .eq("clinic_id", doctor.clinicId)
    .eq("patient_id", patientId)
    .eq("status", "current")
    .or(coverage.join(","))
    .order("created_at", { ascending: false })
    .limit(500);
  if (error) throw new ApiError(500, "Tibbiy yozuvlarni yuklab bo‘lmadi");

  const rows = (data ?? []) as unknown as RecordRow[];
  return rows.map((r) => ({
      id: r.id,
      type: r.record_type,
      summary: r.summary,
      details: r.details,
      code: r.code,
      createdAt: r.created_at,
      appointmentId: r.appointment_id,
      author: { id: r.author_doctor_id, name: r.author?.name ?? null },
      mine: isMine(doctor, r),
      version: r.version,
      rootRecordId: r.root_record_id,
    }));
}

type VersionRow = Database["public"]["Views"]["clinical_record_versions"]["Row"];

/** One version of a record of this patient in the doctor's clinic, or null. */
async function findVersion(doctor: LinkedDoctor, patientId: string, recordId: string): Promise<VersionRow | null> {
  const { data, error } = await createAdminClient()
    .from("clinical_record_versions")
    .select("*")
    .eq("id", recordId)
    .eq("clinic_id", doctor.clinicId)
    .eq("patient_id", patientId)
    .maybeSingle();
  if (error) throw new ApiError(500, "Yozuvni tekshirib bo‘lmadi");
  return data;
}

type DenialReason = "not_found" | "not_visible" | "not_owned";

/**
 * Refuses an action on a clinical record and audits the refusal (ids only).
 * A record the doctor may not see is simply "not found" — its existence is
 * never confirmed; a record they may see but did not write is
 * CLINICAL_RECORD_NOT_OWNED.
 */
async function recordAccessDenied(
  doctor: LinkedDoctor,
  patientId: string,
  recordId: string,
  reason: DenialReason,
  action: "correct" | "history",
): Promise<ApiError> {
  await recordAudit({
    clinicId: doctor.clinicId,
    action: "clinical_record_access_denied",
    entityType: "clinical_records",
    entityId: recordId,
    // The patient was established by the access decision before any record
    // lookup, so it is a patient of this clinic.
    patientId,
    actor: { actorId: doctor.profileId, actorType: "staff" },
    metadata: { reason, attempted: action, doctor_id: doctor.doctorId },
    strict: true,
  });
  return reason === "not_owned"
    ? new ApiError(
        403,
        "Bu yozuv boshqa shifokorniki: uni faqat muallifi tuzata oladi. O‘z xulosangizni o‘z qabulingizda yangi yozuv sifatida qo‘shing.",
        "CLINICAL_RECORD_NOT_OWNED",
      )
    : new ApiError(404, "Yozuv topilmadi", "record_not_found");
}

/** The current version of `rootRecordId`'s lineage (for a VERSION_CONFLICT answer). */
async function currentVersionOf(doctor: LinkedDoctor, rootRecordId: string): Promise<{ id: string; version: number } | null> {
  const { data } = await createAdminClient()
    .from("clinical_record_versions")
    .select("id, version")
    .eq("clinic_id", doctor.clinicId)
    .eq("root_record_id", rootRecordId)
    .eq("status", "current")
    .maybeSingle();
  return data?.id && data.version ? { id: data.id, version: data.version } : null;
}

async function versionConflict(doctor: LinkedDoctor, rootRecordId: string): Promise<ApiError> {
  const current = await currentVersionOf(doctor, rootRecordId);
  return new ApiError(
    409,
    "Yozuv siz ochganingizdan keyin yangilangan. Sahifani yangilab, oxirgi versiyani tuzating.",
    "VERSION_CONFLICT",
    current ? { currentRecordId: current.id, currentVersion: current.version } : undefined,
  );
}

/**
 * Every version of a record, oldest first, read-only — for a doctor who may
 * see the record. The read is audited before anything is returned.
 */
export async function getClinicalRecordHistory(doctor: LinkedDoctor, patientId: string, recordId: string): Promise<ClinicalRecordHistory> {
  const access = await canDoctorAccessPatientClinicalData(doctor.doctorId, patientId);
  if (!access.allowed) throw await patientAccessDenied(doctor, patientId);

  const target = await findVersion(doctor, patientId, recordId);
  if (!target?.root_record_id || !target.appointment_id || !target.author_doctor_id) {
    throw await recordAccessDenied(doctor, patientId, recordId, "not_found", "history");
  }
  if (!canSeeAppointment(access, doctor.doctorId, { id: target.appointment_id, doctorId: target.author_doctor_id })) {
    throw await recordAccessDenied(doctor, patientId, recordId, "not_visible", "history");
  }

  const supabase = createAdminClient();
  const [{ data: rows, error }, { data: author }] = await Promise.all([
    supabase
      .from("clinical_record_versions")
      .select("id, version, status, summary, details, code, created_at, author_doctor_id, superseded_at")
      .eq("clinic_id", doctor.clinicId)
      .eq("patient_id", patientId)
      .eq("root_record_id", target.root_record_id)
      .order("version", { ascending: true }),
    supabase.from("doctors").select("name").eq("id", target.author_doctor_id).eq("clinic_id", doctor.clinicId).maybeSingle(),
  ]);
  if (error) throw new ApiError(500, "Yozuv tarixini yuklab bo‘lmadi");

  const versions = (rows ?? []).map((v) => ({
    id: v.id!,
    version: v.version!,
    status: v.status === "current" ? ("current" as const) : ("superseded" as const),
    summary: v.summary!,
    details: v.details,
    code: v.code,
    createdAt: v.created_at!,
    // Every version of a record has the same author (the database refuses
    // anyone else's correction).
    author: { id: v.author_doctor_id!, name: author?.name ?? null },
    supersededAt: v.superseded_at,
  }));

  const viaReferral = access.relationship === "referred" && target.author_doctor_id !== doctor.doctorId;
  const events: AuditEvent[] = [
    {
      clinicId: doctor.clinicId,
      action: "clinical_record_history_viewed",
      entityType: "clinical_records",
      entityId: target.root_record_id,
      patientId,
      actor: { actorId: doctor.profileId, actorType: "staff" },
      metadata: { relationship: access.relationship, record_ids: versions.map((v) => v.id), version_count: versions.length },
    },
  ];
  if (viaReferral) events.push(referralAccessEvent(doctor, patientId, access, versions.map((v) => v.id), target.root_record_id));
  await recordAudits(events, { strict: true });

  return { rootRecordId: target.root_record_id, type: target.record_type!, appointmentId: target.appointment_id, versions };
}

/** Referral-only access is released by every active incoming handoff, regardless
 * of who authored the historical record. Direct care has its own audit basis. */
export function referralAccessEvent(
  doctor: LinkedDoctor,
  patientId: string,
  access: ClinicalAccess,
  recordIds: string[],
  entityId?: string,
): AuditEvent {
  const referralIds = access.activeReferralIds;
  return {
    clinicId: doctor.clinicId,
    action: "clinical_record_accessed_via_referral",
    entityType: "clinical_records",
    entityId: entityId ?? null,
    patientId,
    referralId: referralIds.length === 1 ? referralIds[0] : null,
    actor: { actorId: doctor.profileId, actorType: "staff" },
    metadata: {
      record_ids: recordIds,
      referral_ids: referralIds,
      shared_history_doctor_ids: access.scope.sharedHistoryDoctorIds,
    },
  };
}

export type CreateClinicalRecordInput = {
  idempotencyKey: string;
  appointmentId: string;
  recordType: ClinicalRecordType;
  summary: string;
  details?: string | null;
  code?: string | null;
  /** Save this as a correction of that record (see correctClinicalRecord). */
  correctsRecordId?: string | null;
  expectedVersion?: number | null;
};

export type CorrectClinicalRecordInput = {
  idempotencyKey: string;
  summary: string;
  details?: string | null;
  code?: string | null;
  /** The version the doctor was looking at; a different current version is a VERSION_CONFLICT. */
  expectedVersion?: number | null;
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
  version: number;
};

async function findByCreationKey(doctor: LinkedDoctor, key: string): Promise<KeyedRecord | null> {
  const { data, error } = await createAdminClient()
    .from("clinical_records")
    .select("id, patient_id, appointment_id, record_type, summary, details, code, corrects_record_id, version")
    .eq("clinic_id", doctor.clinicId)
    .eq("author_doctor_id", doctor.doctorId)
    .eq("created_by", doctor.profileId)
    .eq("creation_key", key)
    .maybeSingle();
  if (error) throw new ApiError(500, "Yozuvni tekshirib bo‘lmadi");
  return data;
}

type Replayable = {
  patientId: string;
  appointmentId?: string;
  recordType?: ClinicalRecordType;
  summary: string;
  details?: string | null;
  code?: string | null;
  correctsRecordId?: string | null;
};

function replay(previous: KeyedRecord, request: Replayable) {
  const same =
    previous.patient_id === request.patientId &&
    (request.appointmentId === undefined || previous.appointment_id === request.appointmentId) &&
    (request.recordType === undefined || previous.record_type === request.recordType) &&
    previous.summary === request.summary &&
    previous.details === (request.details || null) &&
    previous.code === (request.code || null) &&
    previous.corrects_record_id === (request.correctsRecordId || null);
  if (!same) throw new ApiError(409, "Bu so‘rov boshqa ma‘lumotlar bilan allaqachon yuborilgan", "idempotency_key_reused");
  return { id: previous.id, version: previous.version, replayed: true };
}

function isVersionRace(error: { code?: string; message?: string }) {
  const message = error.message ?? "";
  return (
    error.code === "CRVER" ||
    (error.code === "23505" && (message.includes("clinical_records_one_correction") || message.includes("clinical_records_lineage_version_key")))
  );
}

function recordError(error: { code?: string; message?: string }): ApiError {
  const message = error.message ?? "";
  if (message.includes("keeps the consultation")) {
    return new ApiError(409, "Tuzatish o‘sha qabul va yozuv turida qoladi", "correction_not_allowed");
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

type InsertValues = {
  patientId: string;
  appointmentId: string;
  recordType: ClinicalRecordType;
  summary: string;
  details?: string | null;
  code?: string | null;
  correctsRecordId: string | null;
  idempotencyKey: string;
};

/** The insert itself: author, clinic and provenance always from the session. */
async function insertRecord(doctor: LinkedDoctor, values: InsertValues) {
  return createAdminClient()
    .from("clinical_records")
    .insert({
      clinic_id: doctor.clinicId,
      patient_id: values.patientId,
      author_doctor_id: doctor.doctorId,
      appointment_id: values.appointmentId,
      record_type: values.recordType,
      summary: values.summary,
      details: values.details || null,
      code: values.code || null,
      corrects_record_id: values.correctsRecordId,
      created_by: doctor.profileId,
      creation_key: values.idempotencyKey,
    })
    .select("id, version")
    .single();
}

/**
 * The calling doctor documents their own consultation with `patientId`
 * (taken from the URL and re-checked against the consultation). Idempotent
 * per `idempotencyKey`. With `correctsRecordId` it is a correction
 * (correctClinicalRecord); the consultation and type then must be the
 * corrected record's.
 */
export async function createClinicalRecord(
  doctor: LinkedDoctor,
  patientId: string,
  input: CreateClinicalRecordInput,
): Promise<{ id: string; version: number; replayed: boolean }> {
  if (input.correctsRecordId) {
    return correctClinicalRecord(doctor, patientId, input.correctsRecordId, input, {
      appointmentId: input.appointmentId,
      recordType: input.recordType,
    });
  }

  const access = await canDoctorAccessPatientClinicalData(doctor.doctorId, patientId);
  if (!access.allowed) throw await patientAccessDenied(doctor, patientId);

  const previous = await findByCreationKey(doctor, input.idempotencyKey);
  if (previous) return replay(previous, { ...input, patientId, correctsRecordId: null });

  // The doctor's own consultation with THIS patient — an appointment of any
  // other patient or doctor is simply not found.
  const { data: consultation, error } = await createAdminClient()
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

  const { data, error: insertError } = await insertRecord(doctor, {
    patientId,
    appointmentId: consultation.id,
    recordType: input.recordType,
    summary: input.summary,
    details: input.details,
    code: input.code,
    correctsRecordId: null,
    idempotencyKey: input.idempotencyKey,
  });
  if (insertError) {
    if (insertError.code === "23505") {
      const winner = await findByCreationKey(doctor, input.idempotencyKey);
      if (winner) return replay(winner, { ...input, patientId, correctsRecordId: null });
    }
    throw recordError(insertError);
  }
  return { id: data.id, version: data.version, replayed: false };
}

/**
 * The author corrects their own record: the new text is saved as the next
 * version of `recordId`, which must be the record's current version (the
 * one the doctor was looking at); the earlier version stays, superseded, in
 * the record's history. No reason is asked for — the history and the audit
 * trail keep what changed, who changed it and when.
 *
 * Refused, and audited, for a record the doctor did not write (403
 * CLINICAL_RECORD_NOT_OWNED — they write their own record in their own
 * consultation instead) or may not see (404); an outdated version is 409
 * VERSION_CONFLICT, never a silent overwrite.
 */
export async function correctClinicalRecord(
  doctor: LinkedDoctor,
  patientId: string,
  recordId: string,
  input: CorrectClinicalRecordInput,
  expected: { appointmentId?: string; recordType?: ClinicalRecordType } = {},
): Promise<{ id: string; version: number; replayed: boolean }> {
  const access = await canDoctorAccessPatientClinicalData(doctor.doctorId, patientId);
  if (!access.allowed) throw await patientAccessDenied(doctor, patientId);

  const replayRequest = { ...input, ...expected, patientId, correctsRecordId: recordId };
  const previous = await findByCreationKey(doctor, input.idempotencyKey);
  if (previous) return replay(previous, replayRequest);

  const target = await findVersion(doctor, patientId, recordId);
  if (!target?.root_record_id || !target.appointment_id || !target.author_doctor_id || !target.record_type) {
    throw await recordAccessDenied(doctor, patientId, recordId, "not_found", "correct");
  }
  if (!canSeeAppointment(access, doctor.doctorId, { id: target.appointment_id, doctorId: target.author_doctor_id })) {
    throw await recordAccessDenied(doctor, patientId, recordId, "not_visible", "correct");
  }
  if (target.author_doctor_id !== doctor.doctorId || target.created_by !== doctor.profileId) {
    throw await recordAccessDenied(doctor, patientId, recordId, "not_owned", "correct");
  }
  if (
    (expected.appointmentId && expected.appointmentId !== target.appointment_id) ||
    (expected.recordType && expected.recordType !== target.record_type)
  ) {
    throw new ApiError(409, "Tuzatish o‘sha qabul va yozuv turida qoladi", "correction_not_allowed");
  }
  if (target.status !== "current" || (input.expectedVersion != null && input.expectedVersion !== target.version)) {
    throw await versionConflict(doctor, target.root_record_id);
  }

  const { data, error } = await insertRecord(doctor, {
    patientId,
    appointmentId: target.appointment_id,
    recordType: target.record_type,
    summary: input.summary,
    details: input.details,
    code: input.code,
    correctsRecordId: target.id!,
    idempotencyKey: input.idempotencyKey,
  });
  if (error) {
    if (error.code === "23505") {
      const winner = await findByCreationKey(doctor, input.idempotencyKey);
      if (winner) return replay(winner, replayRequest);
    }
    // Another correction of the same version landed first.
    if (isVersionRace(error)) throw await versionConflict(doctor, target.root_record_id);
    if (error.code === "CRNOT") throw await recordAccessDenied(doctor, patientId, recordId, "not_owned", "correct");
    throw recordError(error);
  }
  return { id: data.id, version: data.version, replayed: false };
}

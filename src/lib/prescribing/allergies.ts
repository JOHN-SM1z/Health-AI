import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { ApiError } from "@/lib/api/errors";
import { logger } from "@/lib/logger";
import { recordAudit } from "@/lib/audit";
import type { LinkedDoctor } from "@/lib/auth/guards";
import { patientRecordIds } from "@/lib/patients/record-group";
import { requirePatientClinicalAccess } from "@/lib/prescribing/access";
import type { AllergyKind, AllergySeverity } from "@/lib/prescribing/options";

/**
 * Allergies on the patient card (specification DW-03): recorded by a doctor
 * who treats the patient, shown in the header of every visit, and matched —
 * exactly, without AI — against the medicines of a prescription at signing.
 * A row is never edited: it is marked inactive with a reason and a new one is
 * recorded. Substances and reactions are clinical data: never logged, never
 * in audit values.
 */

export type AllergyView = {
  id: string;
  substance: string;
  substanceKind: AllergyKind;
  drugId: string | null;
  reaction: string | null;
  severity: AllergySeverity;
  recordedAt: string;
  recordedBy: { doctorId: string; name: string | null };
  /** Recorded by the calling doctor. */
  mine: boolean;
  active: boolean;
  inactiveAt: string | null;
  inactiveReason: string | null;
};

type AllergyRow = {
  id: string;
  substance: string;
  substance_kind: string;
  drug_id: string | null;
  reaction: string | null;
  severity: string;
  recorded_at: string;
  recorded_by_doctor_id: string;
  inactive_at: string | null;
  inactive_reason: string | null;
  recorder: { name: string } | null;
};

const COLUMNS =
  "id, substance, substance_kind, drug_id, reaction, severity, recorded_at, recorded_by_doctor_id, inactive_at, inactive_reason, recorder:doctors!patient_allergies_doctor_same_clinic_fkey(name)";

const toView = (doctor: LinkedDoctor, row: AllergyRow): AllergyView => ({
  id: row.id,
  substance: row.substance,
  substanceKind: row.substance_kind as AllergyKind,
  drugId: row.drug_id,
  reaction: row.reaction,
  severity: row.severity as AllergySeverity,
  recordedAt: row.recorded_at,
  recordedBy: { doctorId: row.recorded_by_doctor_id, name: row.recorder?.name ?? null },
  mine: row.recorded_by_doctor_id === doctor.doctorId,
  active: row.inactive_at === null,
  inactiveAt: row.inactive_at,
  inactiveReason: row.inactive_reason,
});

/** The patient's allergies across their merged records: active first, then the inactive history. */
export async function listPatientAllergies(doctor: LinkedDoctor, patientId: string): Promise<AllergyView[]> {
  const access = await requirePatientClinicalAccess(doctor, patientId);
  const ids = await patientRecordIds(doctor.clinicId, patientId);
  const { data, error } = await createAdminClient()
    .from("patient_allergies")
    .select(COLUMNS)
    .eq("clinic_id", doctor.clinicId)
    .in("patient_id", ids)
    .order("recorded_at", { ascending: false })
    .limit(200);
  if (error) {
    logger.error("allergies load failed", { code: error.code });
    throw new ApiError(500, "Allergiyalarni yuklab bo‘lmadi", "allergies_load_failed");
  }
  const rows = (data ?? []) as unknown as AllergyRow[];

  // The read is logged before anything is returned — ids and counts only.
  await recordAudit({
    clinicId: doctor.clinicId,
    action: "patient_allergies_viewed",
    entityType: "patients",
    entityId: patientId,
    patientId,
    actor: { actorId: doctor.profileId, actorType: "staff" },
    metadata: { relationship: access.relationship, count: rows.length },
    strict: true,
  });

  const views = rows.map((row) => toView(doctor, row));
  return [...views.filter((a) => a.active), ...views.filter((a) => !a.active)];
}

export type RecordAllergyInput = {
  idempotencyKey: string;
  substance: string;
  substanceKind: AllergyKind;
  drugId?: string;
  reaction?: string;
  severity: AllergySeverity;
};

type KeyedAllergy = { id: string; patient_id: string; substance: string; substance_kind: string; severity: string };

async function findByCreationKey(doctor: LinkedDoctor, key: string): Promise<KeyedAllergy | null> {
  const { data, error } = await createAdminClient()
    .from("patient_allergies")
    .select("id, patient_id, substance, substance_kind, severity")
    .eq("clinic_id", doctor.clinicId)
    .eq("recorded_by_doctor_id", doctor.doctorId)
    .eq("creation_key", key)
    .maybeSingle();
  if (error) throw new ApiError(500, "Allergiya yozuvini tekshirib bo‘lmadi", "allergy_check_failed");
  return data;
}

function replay(previous: KeyedAllergy, patientId: string, input: RecordAllergyInput) {
  const same =
    previous.patient_id === patientId &&
    previous.substance === input.substance &&
    previous.substance_kind === input.substanceKind &&
    previous.severity === input.severity;
  if (!same) throw new ApiError(409, "Bu so‘rov boshqa ma‘lumotlar bilan allaqachon yuborilgan", "idempotency_key_reused");
  return { id: previous.id, replayed: true };
}

/** The calling doctor records an allergy on the card of a patient they treat. Idempotent per key. */
export async function recordPatientAllergy(
  doctor: LinkedDoctor,
  patientId: string,
  input: RecordAllergyInput,
): Promise<{ id: string; replayed: boolean }> {
  const previous = await findByCreationKey(doctor, input.idempotencyKey);
  if (previous) return replay(previous, patientId, input);

  await requirePatientClinicalAccess(doctor, patientId);

  const { data, error } = await createAdminClient()
    .from("patient_allergies")
    .insert({
      clinic_id: doctor.clinicId,
      patient_id: patientId,
      substance: input.substance,
      substance_kind: input.substanceKind,
      drug_id: input.drugId ?? null,
      reaction: input.reaction ?? null,
      severity: input.severity,
      recorded_by_doctor_id: doctor.doctorId,
      recorded_by: doctor.profileId,
      creation_key: input.idempotencyKey,
    })
    .select("id")
    .single();
  if (error) {
    if (error.code === "23505") {
      const winner = await findByCreationKey(doctor, input.idempotencyKey);
      if (winner) return replay(winner, patientId, input);
    }
    const message = error.message ?? "";
    if (message.includes("not in this clinic")) throw new ApiError(404, "Dori topilmadi", "drug_not_found");
    if (message.includes("no clinical relationship")) throw new ApiError(404, "Bemor topilmadi", "patient_not_found");
    if (error.code === "23503") throw new ApiError(404, "Bemor topilmadi", "patient_not_found");
    if (error.code === "23514" || error.code === "23502") throw new ApiError(400, "Allergiya ma‘lumotlari noto‘g‘ri", "validation");
    // Only the code: a database error's detail can echo the substance.
    logger.error("allergy write failed", { code: error.code });
    throw new ApiError(500, "Allergiyani saqlab bo‘lmadi", "allergy_write_failed");
  }
  return { id: data.id, replayed: false };
}

/** Marks an allergy inactive with a reason (recorded by mistake, disproved…). Nothing is deleted. */
export async function inactivatePatientAllergy(doctor: LinkedDoctor, patientId: string, allergyId: string, reason: string): Promise<void> {
  await requirePatientClinicalAccess(doctor, patientId);
  const ids = await patientRecordIds(doctor.clinicId, patientId);
  const { data, error } = await createAdminClient()
    .from("patient_allergies")
    .update({ inactive_at: new Date().toISOString(), inactivated_by: doctor.profileId, inactive_reason: reason })
    .eq("id", allergyId)
    .eq("clinic_id", doctor.clinicId)
    .in("patient_id", ids)
    .is("inactive_at", null)
    .select("id");
  if (error) {
    logger.error("allergy inactivate failed", { code: error.code });
    throw new ApiError(500, "Allergiyani o‘zgartirib bo‘lmadi", "allergy_write_failed");
  }
  if (!data || data.length === 0) throw new ApiError(404, "Faol allergiya yozuvi topilmadi", "allergy_not_found");
}

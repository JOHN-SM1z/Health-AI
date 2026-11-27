import "server-only";
import { createHash } from "node:crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { ApiError } from "@/lib/api/errors";
import { logger } from "@/lib/logger";
import { recordAudit } from "@/lib/audit";
import type { LinkedDoctor } from "@/lib/auth/guards";
import { patientRecordIds } from "@/lib/patients/record-group";
import { serverHmac } from "@/lib/security/server-hmac";
import { consultationCoverageFilter, requirePatientClinicalAccess } from "@/lib/prescribing/access";
import type { PrescriptionItemInput } from "@/lib/prescribing/schemas";
import type { Timing } from "@/lib/prescribing/options";

/**
 * Structured prescriptions (specification §9.3, RX-03…RX-07). The doctor
 * writes a draft in their own consultation and signs it; signing writes the
 * doctor-authored clinical record, and the signed prescription is immutable —
 * it can only be replaced or cancelled, each with a reason. A prescription is
 * readable exactly where its consultation's clinical records are.
 *
 * The rules themselves live in the database (save_prescription_draft,
 * sign_prescription, cancel_prescription, record_national_rx_number and the
 * guards): this file authorizes, calls them and translates their answers.
 * Medicines, doses and reasons are clinical data — never logged.
 */

export type PrescriptionStatus = "draft" | "signed" | "replaced" | "cancelled";

export type PrescriptionItemView = {
  id: string;
  position: number;
  drugId: string;
  inn: string;
  tradeName: string | null;
  form: string | null;
  strength: string | null;
  rxOnly: boolean;
  dose: number;
  doseUnit: string;
  route: string;
  frequency: string;
  timing: Timing;
  days: number;
  quantity: number;
  instructions: string | null;
  allergyOverrideReason: string | null;
  /** Allergy rows that matched this medicine when it was signed. */
  allergyIds: string[];
};

export type PrescriptionView = {
  id: string;
  status: PrescriptionStatus;
  appointmentId: string;
  createdAt: string;
  signedAt: string | null;
  author: { id: string; name: string | null };
  /** Written by the calling doctor. */
  mine: boolean;
  replacesId: string | null;
  replaceReason: string | null;
  /** The signed prescription that replaced this one, if any. */
  replacedById: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  nationalRxNumber: string | null;
  /** Has prescription-only items and no national Elektron retsept number yet (RX-05). */
  nationalRxRequired: boolean;
  items: PrescriptionItemView[];
};

type ItemRow = {
  id: string;
  position: number;
  drug_id: string;
  inn_snapshot: string;
  trade_name_snapshot: string | null;
  form_snapshot: string | null;
  strength_snapshot: string | null;
  rx_only_snapshot: boolean;
  dose: number;
  dose_unit: string;
  route: string;
  frequency: string;
  timing: string;
  days: number;
  quantity: number;
  instructions: string | null;
  allergy_override_reason: string | null;
  allergy_ids: string[];
};

type PrescriptionRow = {
  id: string;
  status: PrescriptionStatus;
  patient_id: string;
  doctor_id: string;
  appointment_id: string;
  created_at: string;
  signed_at: string | null;
  replaces_id: string | null;
  replace_reason: string | null;
  cancelled_at: string | null;
  cancel_reason: string | null;
  national_rx_number: string | null;
  verification_code_hash: string | null;
  author: { name: string } | null;
  items: ItemRow[] | null;
};

const ITEM_COLUMNS =
  "id, position, drug_id, inn_snapshot, trade_name_snapshot, form_snapshot, strength_snapshot, rx_only_snapshot, dose, dose_unit, route, frequency, timing, days, quantity, instructions, allergy_override_reason, allergy_ids";
const COLUMNS = `id, status, patient_id, doctor_id, appointment_id, created_at, signed_at, replaces_id, replace_reason, cancelled_at, cancel_reason, national_rx_number, verification_code_hash, author:doctors!prescriptions_doctor_same_clinic_fkey(name), items:prescription_items(${ITEM_COLUMNS})`;

const toItem = (row: ItemRow): PrescriptionItemView => ({
  id: row.id,
  position: row.position,
  drugId: row.drug_id,
  inn: row.inn_snapshot,
  tradeName: row.trade_name_snapshot,
  form: row.form_snapshot,
  strength: row.strength_snapshot,
  rxOnly: row.rx_only_snapshot,
  dose: Number(row.dose),
  doseUnit: row.dose_unit,
  route: row.route,
  frequency: row.frequency,
  timing: row.timing as Timing,
  days: row.days,
  quantity: Number(row.quantity),
  instructions: row.instructions,
  allergyOverrideReason: row.allergy_override_reason,
  allergyIds: row.allergy_ids ?? [],
});

function toView(doctor: LinkedDoctor, row: PrescriptionRow, replacedBy: Map<string, string>): PrescriptionView {
  const items = (row.items ?? []).map(toItem).sort((a, b) => a.position - b.position);
  return {
    id: row.id,
    status: row.status,
    appointmentId: row.appointment_id,
    createdAt: row.created_at,
    signedAt: row.signed_at,
    author: { id: row.doctor_id, name: row.author?.name ?? null },
    mine: row.doctor_id === doctor.doctorId,
    replacesId: row.replaces_id,
    replaceReason: row.replace_reason,
    replacedById: replacedBy.get(row.id) ?? null,
    cancelledAt: row.cancelled_at,
    cancelReason: row.cancel_reason,
    nationalRxNumber: row.national_rx_number,
    nationalRxRequired: row.status === "signed" && !row.national_rx_number && items.some((i) => i.rxOnly),
    items,
  };
}

/**
 * The patient's prescriptions the calling doctor may read, newest first: the
 * signed ones wherever the consultation's clinical records are visible, and
 * the doctor's own drafts (a draft is nobody else's business).
 */
export async function listPatientPrescriptions(doctor: LinkedDoctor, patientId: string): Promise<PrescriptionView[]> {
  const access = await requirePatientClinicalAccess(doctor, patientId);
  const coverage = consultationCoverageFilter(doctor, access, "doctor_id");
  let rows: PrescriptionRow[] = [];
  if (coverage) {
    const ids = await patientRecordIds(doctor.clinicId, patientId);
    const { data, error } = await createAdminClient()
      .from("prescriptions")
      .select(COLUMNS)
      .eq("clinic_id", doctor.clinicId)
      .in("patient_id", ids)
      .or(coverage)
      .order("created_at", { ascending: false })
      .limit(200);
    if (error) {
      logger.error("prescriptions load failed", { code: error.code });
      throw new ApiError(500, "Retseptlarni yuklab bo‘lmadi", "prescriptions_load_failed");
    }
    rows = ((data ?? []) as unknown as PrescriptionRow[]).filter((r) => r.status !== "draft" || r.doctor_id === doctor.doctorId);
  }

  const replacedBy = new Map(rows.filter((r) => r.replaces_id && r.status !== "draft").map((r) => [r.replaces_id!, r.id]));

  // Logged before anything is returned — ids and counts only.
  await recordAudit({
    clinicId: doctor.clinicId,
    action: "patient_prescriptions_viewed",
    entityType: "patients",
    entityId: patientId,
    patientId,
    referralId: access.activeReferralIds.length === 1 ? access.activeReferralIds[0] : null,
    actor: { actorId: doctor.profileId, actorType: "staff" },
    metadata: {
      relationship: access.relationship,
      count: rows.length,
      shared_prescription_ids: rows.filter((r) => r.doctor_id !== doctor.doctorId).map((r) => r.id),
    },
    strict: true,
  });

  return rows.map((row) => toView(doctor, row, replacedBy));
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

const ITEM_REJECTIONS: Record<string, string> = {
  drug_not_available: "Bu dori ro‘yxatda yo‘q yoki ro‘yxatdan chiqarilgan",
  controlled_not_allowed:
    "Nazoratdagi (giyohvandlik yoki psixotrop) dori Health AI orqali yozilmaydi — maxsus blanka yoki milliy tartib talab qilinadi",
};

const ERRORS: Record<string, [number, string]> = {
  consultation_not_found: [404, "Qabul topilmadi"],
  consultation_not_active: [409, "Retsept faqat boshlangan yoki yakunlangan qabulda yoziladi"],
  items_invalid: [400, "Retseptga kamida bitta dori qo‘shing"],
  replaced_not_found: [404, "Almashtiriladigan retsept topilmadi"],
  replaced_not_current: [409, "Almashtiriladigan retsept endi amalda emas"],
  idempotency_key_reused: [409, "Bu so‘rov boshqa ma‘lumotlar bilan allaqachon yuborilgan"],
  prescription_not_found: [404, "Retsept topilmadi"],
  not_a_draft: [409, "Bu retsept allaqachon imzolangan"],
  not_current: [409, "Bu retsept endi amalda emas"],
  replace_reason_required: [400, "Retseptni almashtirish sababini yozing"],
  reason_required: [400, "Bekor qilish sababini yozing"],
  number_invalid: [400, "Milliy retsept raqami noto‘g‘ri"],
  national_rx_not_required: [409, "Bu retseptda retsept bilan beriladigan dori yo‘q"],
};

type RpcResult = Record<string, unknown> & { error_code?: string | null };

/** Turns a function's answer into the caller's error, or returns the answer when there is none. */
function unwrap(result: unknown, fallback: string): RpcResult {
  const row = (result ?? {}) as RpcResult;
  const code = row.error_code;
  if (!code) return row;
  if (code === "items_not_allowed") {
    const items = Array.isArray(row.items) ? (row.items as Array<{ position: number; reason: string }>) : [];
    const first = items[0];
    throw new ApiError(409, ITEM_REJECTIONS[first?.reason ?? ""] ?? "Retseptdagi dori endi yozib bo‘lmaydi", first?.reason ?? code, {
      positions: items.map((i) => i.position),
    });
  }
  if (code === "allergy_conflict") {
    const conflicts = Array.isArray(row.conflicts)
      ? (row.conflicts as Array<{ position: number; drug_id: string; allergy_ids: string[] }>)
      : [];
    throw new ApiError(409, "Bemorda bu doriga allergiya qayd etilgan. Davom etish uchun har bir dori bo‘yicha sababini yozing", code, {
      conflicts: conflicts.map((c) => ({ position: c.position, drugId: c.drug_id, allergyIds: c.allergy_ids })),
    });
  }
  const known = ERRORS[code];
  if (known) throw new ApiError(known[0], known[1], code);
  throw new ApiError(500, fallback, "prescription_write_failed");
}

/** A database exception → the caller's error. Only the code is logged: the detail can echo clinical text. */
function writeError(error: { code?: string; message?: string }, fallback: string): ApiError {
  const rejected = /prescription_item_rejected:([a-z_]+):(\d+)/.exec(error.message ?? "");
  if (rejected) {
    return new ApiError(409, ITEM_REJECTIONS[rejected[1]] ?? "Retseptdagi dori yozib bo‘lmaydi", rejected[1], { positions: [Number(rejected[2])] });
  }
  if (error.code === "23514" || error.code === "23502" || error.code === "22P02" || error.code === "22003") {
    return new ApiError(400, "Retsept ma‘lumotlari noto‘g‘ri", "validation");
  }
  logger.error("prescription write failed", { code: error.code });
  return new ApiError(500, fallback, "prescription_write_failed");
}

export type SavePrescriptionInput = {
  idempotencyKey: string;
  appointmentId: string;
  prescriptionId?: string;
  replacesId?: string;
  items: PrescriptionItemInput[];
};

/** Creates the calling doctor's draft in their own consultation, or replaces the items of their draft. */
export async function savePrescriptionDraft(doctor: LinkedDoctor, patientId: string, input: SavePrescriptionInput): Promise<{ id: string }> {
  await requirePatientClinicalAccess(doctor, patientId);
  const { data, error } = await createAdminClient().rpc("save_prescription_draft", {
    p_clinic_id: doctor.clinicId,
    p_doctor_id: doctor.doctorId,
    p_actor: doctor.profileId,
    p_patient_id: patientId,
    p_appointment_id: input.appointmentId,
    p_prescription_id: (input.prescriptionId ?? null) as string,
    p_items: input.items.map((item) => ({
      drug_id: item.drugId,
      dose: item.dose,
      dose_unit: item.doseUnit,
      route: item.route,
      frequency: item.frequency,
      timing: item.timing,
      days: item.days,
      quantity: item.quantity,
      instructions: item.instructions ?? null,
      allergy_override_reason: item.allergyOverrideReason ?? null,
    })),
    p_replaces_id: (input.replacesId ?? null) as string,
    p_creation_key: input.idempotencyKey,
  });
  if (error) throw writeError(error, "Retseptni saqlab bo‘lmadi");
  const result = unwrap(data, "Retseptni saqlab bo‘lmadi");
  return { id: String(result.prescription_id) };
}

/** The doctor's own prescription, or 404 — an id of another doctor or clinic is simply not found. */
async function ownPrescription(doctor: LinkedDoctor, prescriptionId: string): Promise<{ id: string; patient_id: string; status: PrescriptionStatus }> {
  const { data, error } = await createAdminClient()
    .from("prescriptions")
    .select("id, patient_id, status")
    .eq("id", prescriptionId)
    .eq("clinic_id", doctor.clinicId)
    .eq("doctor_id", doctor.doctorId)
    .maybeSingle();
  if (error) throw new ApiError(500, "Retseptni tekshirib bo‘lmadi", "prescription_check_failed");
  if (!data) throw new ApiError(404, "Retsept topilmadi", "prescription_not_found");
  return data as { id: string; patient_id: string; status: PrescriptionStatus };
}

/**
 * The code printed in the prescription's QR link (RX-07). Derived from the
 * prescription id with a server key, so it can be printed again later without
 * ever being stored; the database keeps only its SHA-256.
 */
export function prescriptionVerificationCode(prescriptionId: string): string {
  return Buffer.from(serverHmac("prescription-verification", prescriptionId), "hex").subarray(0, 15).toString("base64url");
}

export const verificationCodeHash = (code: string): string => createHash("sha256").update(code).digest("hex");

export type SignResult = { id: string; signedAt: string; nationalRxRequired: boolean; replacedId: string | null };

/**
 * Signs the calling doctor's draft ("Imzolash"). Reports success only from
 * the database's own answer: the clinical record is written and the items are
 * frozen in the same transaction, or nothing is.
 */
export async function signPrescription(doctor: LinkedDoctor, prescriptionId: string, replaceReason?: string): Promise<SignResult> {
  const prescription = await ownPrescription(doctor, prescriptionId);
  await requirePatientClinicalAccess(doctor, prescription.patient_id);
  const { data, error } = await createAdminClient().rpc("sign_prescription", {
    p_clinic_id: doctor.clinicId,
    p_doctor_id: doctor.doctorId,
    p_actor: doctor.profileId,
    p_prescription_id: prescription.id,
    p_verification_code_hash: verificationCodeHash(prescriptionVerificationCode(prescription.id)),
    p_replace_reason: (replaceReason ?? null) as string,
  });
  if (error) throw writeError(error, "Retseptni imzolab bo‘lmadi");
  const result = unwrap(data, "Retseptni imzolab bo‘lmadi");
  return {
    id: String(result.prescription_id),
    signedAt: String(result.signed_at),
    nationalRxRequired: result.national_rx_required === true,
    replacedId: typeof result.replaced_id === "string" ? result.replaced_id : null,
  };
}

/** Deletes the calling doctor's own draft. A signed prescription cannot be deleted (the database refuses). */
export async function deletePrescriptionDraft(doctor: LinkedDoctor, prescriptionId: string): Promise<void> {
  const prescription = await ownPrescription(doctor, prescriptionId);
  if (prescription.status !== "draft") throw new ApiError(409, "Imzolangan retsept o‘chirilmaydi — uni bekor qiling", "not_a_draft");
  const { error } = await createAdminClient()
    .from("prescriptions")
    .delete()
    .eq("id", prescription.id)
    .eq("clinic_id", doctor.clinicId)
    .eq("doctor_id", doctor.doctorId)
    .eq("status", "draft");
  if (error) throw writeError(error, "Qoralamani o‘chirib bo‘lmadi");
}

export async function cancelPrescription(doctor: LinkedDoctor, prescriptionId: string, reason: string): Promise<void> {
  const prescription = await ownPrescription(doctor, prescriptionId);
  await requirePatientClinicalAccess(doctor, prescription.patient_id);
  const { data, error } = await createAdminClient().rpc("cancel_prescription", {
    p_clinic_id: doctor.clinicId,
    p_doctor_id: doctor.doctorId,
    p_actor: doctor.profileId,
    p_prescription_id: prescription.id,
    p_reason: reason,
  });
  if (error) throw writeError(error, "Retseptni bekor qilib bo‘lmadi");
  unwrap(data, "Retseptni bekor qilib bo‘lmadi");
}

/** RX-05, phase 1: the number the national Elektron retsept system gave, typed in by the doctor. */
export async function recordNationalRxNumber(doctor: LinkedDoctor, prescriptionId: string, number: string): Promise<void> {
  const prescription = await ownPrescription(doctor, prescriptionId);
  await requirePatientClinicalAccess(doctor, prescription.patient_id);
  const { data, error } = await createAdminClient().rpc("record_national_rx_number", {
    p_clinic_id: doctor.clinicId,
    p_doctor_id: doctor.doctorId,
    p_actor: doctor.profileId,
    p_prescription_id: prescription.id,
    p_number: number,
  });
  if (error) throw writeError(error, "Milliy retsept raqamini saqlab bo‘lmadi");
  unwrap(data, "Milliy retsept raqamini saqlab bo‘lmadi");
}

// ---------------------------------------------------------------------------
// The printed document
// ---------------------------------------------------------------------------

export type PrescriptionDocument = {
  prescription: PrescriptionView;
  clinic: { name: string; address: string | null; phone: string | null };
  patient: { fullName: string | null };
  /** "/v/<code>": confirms the printout is genuine and current, never the medicines. Null if the code cannot be rebuilt. */
  verificationPath: string | null;
};

/** The calling doctor's own signed prescription, laid out for printing (RX-07). */
export async function getPrescriptionDocument(doctor: LinkedDoctor, prescriptionId: string): Promise<PrescriptionDocument> {
  const own = await ownPrescription(doctor, prescriptionId);
  if (own.status === "draft") throw new ApiError(409, "Qoralama chop etilmaydi — avval imzolang", "not_signed");
  await requirePatientClinicalAccess(doctor, own.patient_id);

  const db = createAdminClient();
  const [rx, clinic, patient, successor] = await Promise.all([
    db.from("prescriptions").select(COLUMNS).eq("id", own.id).eq("clinic_id", doctor.clinicId).single(),
    db.from("clinics").select("name, address, phone").eq("id", doctor.clinicId).single(),
    db.from("patients").select("full_name").eq("id", own.patient_id).eq("clinic_id", doctor.clinicId).single(),
    db.from("prescriptions").select("id").eq("clinic_id", doctor.clinicId).eq("replaces_id", own.id).neq("status", "draft").maybeSingle(),
  ]);
  if (rx.error || clinic.error || patient.error || successor.error) {
    logger.error("prescription document load failed", {
      code: rx.error?.code ?? clinic.error?.code ?? patient.error?.code ?? successor.error?.code,
    });
    throw new ApiError(500, "Retseptni yuklab bo‘lmadi", "prescription_load_failed");
  }
  const row = rx.data as unknown as PrescriptionRow;
  const code = prescriptionVerificationCode(row.id);

  await recordAudit({
    clinicId: doctor.clinicId,
    action: "prescription_document_opened",
    entityType: "prescriptions",
    entityId: row.id,
    patientId: own.patient_id,
    actor: { actorId: doctor.profileId, actorType: "staff" },
    strict: true,
  });

  return {
    prescription: toView(doctor, row, new Map(successor.data ? [[row.id, successor.data.id]] : [])),
    clinic: { name: clinic.data.name, address: clinic.data.address, phone: clinic.data.phone },
    patient: { fullName: patient.data.full_name },
    // After a key change the stored hash no longer matches: no QR rather than a QR that does not verify.
    verificationPath: verificationCodeHash(code) === row.verification_code_hash ? `/v/${code}` : null,
  };
}

// ---------------------------------------------------------------------------
// Public authenticity check
// ---------------------------------------------------------------------------

export type VerifiedDocument = {
  clinicName: string;
  doctorName: string;
  signedAt: string;
  clinicTimezone: string;
  status: "valid" | "replaced" | "cancelled";
};

/**
 * What anyone holding a printed prescription may learn from its code: that it
 * is genuine, who issued it and whether it is still current. Never a medicine
 * and never the patient (RX-07).
 */
export async function verifyPrescriptionCode(code: string): Promise<VerifiedDocument | null> {
  if (!/^[A-Za-z0-9_-]{20}$/.test(code)) return null;
  const { data, error } = await createAdminClient().rpc("verify_prescription_code", { p_code_hash: verificationCodeHash(code) });
  if (error) {
    logger.error("prescription verification failed", { code: error.code });
    throw new ApiError(503, "Hujjatni tekshirib bo‘lmadi, keyinroq urinib ko‘ring", "verification_unavailable");
  }
  const row = data?.[0];
  if (!row) return null;
  return {
    clinicName: row.clinic_name,
    doctorName: row.doctor_name,
    signedAt: row.signed_at,
    clinicTimezone: row.clinic_timezone,
    status: row.status === "signed" ? "valid" : row.status === "replaced" ? "replaced" : "cancelled",
  };
}

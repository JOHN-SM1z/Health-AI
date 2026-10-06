import "server-only";
import { patientRecordIds } from "@/lib/patients/record-group";
import { createAdminClient } from "@/lib/supabase/admin";
import { ApiError } from "@/lib/api/errors";
import { recordAudit, recordAudits } from "@/lib/audit";
import { logger } from "@/lib/logger";
import type { LinkedDoctor } from "@/lib/auth/guards";
import { canDoctorAccessPatientClinicalData } from "@/lib/clinical-access/access";
import { patientAccessDenied } from "@/lib/clinical-access/denial";

/**
 * The patient's laboratory history in the doctor workspace (Phase 10).
 *
 * Part of the existing longitudinal record, not a second one: a doctor reaches
 * it exactly as they reach the patient's consultations — through
 * doctor_patient_access() (own patient, or an active, unexpired referral),
 * checked on every request. O3: such a doctor sees every VERIFIED result of
 * the patient in their clinic, whoever ordered it (never drafts, never results
 * awaiting review, never other clinics).
 *
 * Results are listed newest first by clinical time (performed, else
 * collected, else verified) — a corrected or late-verified result keeps its
 * place in the patient's timeline.
 *
 * Read-only by construction: verified versions cannot change (database), and
 * nothing here writes. A doctor with a different view records it in their own
 * clinical record. Each read is audited (strict) before data is returned.
 */

const LIMIT = 500;

function loadFailed(what: string, error: { code?: string }) {
  logger.error(`lab history: ${what} failed`, { code: error.code });
  return new ApiError(500, "Laboratoriya tarixini yuklab bo‘lmadi", "load_failed");
}

async function requireAccess(doctor: LinkedDoctor, patientId: string) {
  const access = await canDoctorAccessPatientClinicalData(doctor.doctorId, patientId);
  if (access.relationship === "none") throw await patientAccessDenied(doctor, patientId);
  return access;
}

export type HistoryValue = {
  parameterCode: string;
  parameter: string;
  order: number;
  numeric: number | null;
  display: string;
  unit: string | null;
  flag: string;
  rangeLow: number | null;
  rangeHigh: number | null;
  rangeText: string | null;
};

export type HistoryDocument = { id: string; kind: string; mimeType: string; sizeBytes: number; createdAt: string };

export type HistoryResult = {
  resultId: string;
  itemId: string;
  testCode: string;
  testName: string;
  /** Where the result came from: entered in this clinic's lab, imported, or an external laboratory. */
  source: string;
  orderSource: string;
  orderedAt: string;
  orderedByName: string | null;
  collectedAt: string | null;
  performedAt: string | null;
  verifiedAt: string;
  verifiedByName: string | null;
  version: number;
  correctionReason: string | null;
  labComment: string | null;
  values: HistoryValue[];
  documents: HistoryDocument[];
};

const num = (v: number | string | null) => (v === null ? null : Number(v));

/** `via` names the screen that read the results, for the audit trail. */
export async function getPatientLabHistory(doctor: LinkedDoctor, patientId: string, opts: { via?: "doctor_history" | "lab_summary" } = {}): Promise<HistoryResult[]> {
  await requireAccess(doctor, patientId);
  const db = createAdminClient();
  // The person's merged record group (Phase 14).
  const ids = await patientRecordIds(doctor.clinicId, patientId);

  const { data, error } = await db
    .from("lab_results")
    .select(
      "id, patient_id, order_item_id, version, source, performed_at, verified_at, correction_reason, lab_comment, " +
        "verified:profiles!lab_results_verified_by_fkey(full_name), " +
        "lab_result_values(value_numeric, value_text, value_boolean, unit_snapshot, flag, range_low, range_high, range_text, lab_test_parameters(code, name, sort_order)), " +
        "lab_order_items!lab_results_item_fkey(test_code_snapshot, test_name_snapshot, " +
        "lab_orders!lab_order_items_order_fkey(created_at, source, doctors!lab_orders_ordering_doctor_fkey(name), profiles!lab_orders_ordered_by_fkey(full_name)))",
    )
    .eq("clinic_id", doctor.clinicId)
    .in("patient_id", ids)
    .eq("status", "verified")
    .order("verified_at", { ascending: false })
    .limit(LIMIT);
  if (error) throw loadFailed("results", error);

  type Row = {
    id: string;
    patient_id: string;
    order_item_id: string;
    version: number;
    source: string;
    performed_at: string | null;
    verified_at: string;
    correction_reason: string | null;
    lab_comment: string | null;
    verified: { full_name: string | null } | null;
    lab_result_values: Array<{
      value_numeric: number | string | null;
      value_text: string | null;
      value_boolean: boolean | null;
      unit_snapshot: string | null;
      flag: string;
      range_low: number | string | null;
      range_high: number | string | null;
      range_text: string | null;
      lab_test_parameters: { code: string; name: string; sort_order: number } | null;
    }>;
    lab_order_items: {
      test_code_snapshot: string;
      test_name_snapshot: string;
      lab_orders: { created_at: string; source: string; doctors: { name: string } | null; profiles: { full_name: string | null } | null } | null;
    } | null;
  };
  const rows = (data ?? []) as unknown as Row[];
  if (rows.length === 0) return [];

  const itemIds = rows.map((r) => r.order_item_id);
  const resultIds = rows.map((r) => r.id);
  const [samples, documents] = await Promise.all([
    db
      .from("lab_sample_items")
      .select("order_item_id, lab_samples!lab_sample_items_sample_fkey(collected_at, status)")
      .eq("clinic_id", doctor.clinicId)
      .in("order_item_id", itemIds),
    db
      .from("lab_documents")
      .select("id, result_id, kind, mime_type, size_bytes, created_at")
      .eq("clinic_id", doctor.clinicId)
      .in("patient_id", ids)
      .in("result_id", resultIds)
      .is("withdrawn_at", null)
      .order("created_at"),
  ]);
  if (samples.error) throw loadFailed("samples", samples.error);
  if (documents.error) throw loadFailed("documents", documents.error);

  const collectedAt = new Map<string, string>();
  for (const s of (samples.data ?? []) as unknown as Array<{ order_item_id: string; lab_samples: { collected_at: string; status: string } | null }>) {
    if (s.lab_samples && s.lab_samples.status !== "rejected") collectedAt.set(s.order_item_id, s.lab_samples.collected_at);
  }
  const docsOf = new Map<string, HistoryDocument[]>();
  for (const d of documents.data ?? []) {
    const list = docsOf.get(d.result_id!) ?? [];
    list.push({ id: d.id, kind: d.kind, mimeType: d.mime_type, sizeBytes: Number(d.size_bytes), createdAt: d.created_at });
    docsOf.set(d.result_id!, list);
  }

  // Strict audit of every result shown, before anything is returned.
  await recordAudits(
    rows.map((r) => ({
      clinicId: doctor.clinicId,
      action: "lab_result_viewed",
      entityType: "lab_results",
      entityId: r.id,
      patientId: r.patient_id,
      actor: { actorId: doctor.profileId, actorType: "staff" as const },
      metadata: { order_item_id: r.order_item_id, version: r.version, via: opts.via ?? "doctor_history" },
    })),
    { strict: true },
  );

  const history = rows.map((r) => {
    const order = r.lab_order_items?.lab_orders ?? null;
    return {
      resultId: r.id,
      itemId: r.order_item_id,
      testCode: r.lab_order_items?.test_code_snapshot ?? "",
      testName: r.lab_order_items?.test_name_snapshot ?? "—",
      source: r.source,
      orderSource: order?.source ?? "",
      orderedAt: order?.created_at ?? r.verified_at,
      orderedByName: order?.doctors?.name ?? order?.profiles?.full_name ?? null,
      collectedAt: collectedAt.get(r.order_item_id) ?? null,
      performedAt: r.performed_at,
      verifiedAt: r.verified_at,
      verifiedByName: r.verified?.full_name ?? null,
      version: r.version,
      correctionReason: r.correction_reason,
      labComment: r.lab_comment,
      values: r.lab_result_values
        .map((v) => ({
          parameterCode: v.lab_test_parameters?.code ?? "",
          parameter: v.lab_test_parameters?.name ?? "—",
          order: v.lab_test_parameters?.sort_order ?? 0,
          numeric: num(v.value_numeric),
          display:
            v.value_numeric !== null ? String(v.value_numeric) : v.value_boolean !== null ? (v.value_boolean ? "Ha" : "Yo‘q") : (v.value_text ?? "—"),
          unit: v.unit_snapshot,
          flag: v.flag,
          rangeLow: num(v.range_low),
          rangeHigh: num(v.range_high),
          rangeText: v.range_text,
        }))
        .sort((a, b) => a.order - b.order),
      documents: docsOf.get(r.id) ?? [],
    };
  });
  // Newest first by clinical time: when the test was performed, else collected, else verified.
  const clinicalTime = (h: HistoryResult) => new Date(h.performedAt ?? h.collectedAt ?? h.verifiedAt).getTime();
  return history.sort((a, b) => clinicalTime(b) - clinicalTime(a));
}

/**
 * A short-lived link to one attachment of a verified result of the patient
 * (private bucket lab-documents). Withdrawn documents and documents of
 * unverified results are not available. Audited before the link is issued.
 */
export async function getLabDocumentLink(doctor: LinkedDoctor, patientId: string, documentId: string): Promise<{ url: string; expiresIn: number }> {
  await requireAccess(doctor, patientId);
  const db = createAdminClient();
  const ids = await patientRecordIds(doctor.clinicId, patientId);
  const { data: doc, error } = await db
    .from("lab_documents")
    .select("id, patient_id, storage_path, result_id, kind, lab_results!lab_documents_result_fkey(status)")
    .eq("id", documentId)
    .eq("clinic_id", doctor.clinicId)
    .in("patient_id", ids)
    .is("withdrawn_at", null)
    .maybeSingle();
  if (error) throw loadFailed("document", error);
  const result = (doc as unknown as { lab_results: { status: string } | null } | null)?.lab_results;
  if (!doc || result?.status !== "verified") throw new ApiError(404, "Hujjat topilmadi", "document_not_found");

  await recordAudit({
    clinicId: doctor.clinicId,
    action: "lab_document_viewed",
    entityType: "lab_documents",
    entityId: doc.id,
    patientId: doc.patient_id,
    actor: { actorId: doctor.profileId, actorType: "staff" },
    metadata: { result_id: doc.result_id, kind: doc.kind, via: "doctor_history" },
    strict: true,
  });

  const expiresIn = 60;
  const { data: signed, error: signError } = await db.storage.from("lab-documents").createSignedUrl(doc.storage_path, expiresIn);
  if (signError || !signed) {
    logger.error("lab history: signed url failed", { message: signError?.message });
    throw new ApiError(503, "Hujjatni ochib bo‘lmadi, keyinroq urinib ko‘ring", "document_unavailable");
  }
  return { url: signed.signedUrl, expiresIn };
}

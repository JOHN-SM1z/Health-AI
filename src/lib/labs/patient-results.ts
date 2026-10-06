import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { ApiError } from "@/lib/api/errors";
import { recordAudit } from "@/lib/audit";
import { logger } from "@/lib/logger";
import { patientRecordIds } from "@/lib/patients/record-group";

/**
 * A patient's own laboratory results in the Mini App (Phase 12).
 *
 * The caller has already verified the patient through the existing Telegram
 * identity (resolvePatientFromInitData: initData signed by THIS clinic's bot).
 * Here, every read is scoped to that clinic and that patient, and shows only
 * the current VERIFIED version — never drafts, results in review, superseded
 * versions or withdrawn documents — and only while the clinic releases
 * results to patients (lab_release_to_patient). Anything else, including a
 * guessed id of another patient's result, is the same "not found".
 *
 * Values are placed against the configured range (never interpreted). Each
 * read of values or a document is audited (actor: the patient) before it is
 * returned. No AI is involved.
 */

const NOT_FOUND = () => new ApiError(404, "Natija topilmadi", "result_not_found");

function loadFailed(what: string, error: { code?: string }) {
  logger.error(`patient lab results: ${what} failed`, { code: error.code });
  return new ApiError(500, "Natijalarni yuklab bo‘lmadi", "load_failed");
}

async function released(clinicId: string): Promise<boolean> {
  const { data, error } = await createAdminClient().rpc("lab_release_to_patient", { p_clinic_id: clinicId });
  if (error) throw loadFailed("release setting", error);
  return data === true;
}

export type PatientResultSummary = {
  itemId: string;
  testName: string;
  date: string;
  corrected: boolean;
  outsideRange: number;
};

export async function listPatientLabResults(clinicId: string, patientId: string): Promise<{ released: boolean; results: PatientResultSummary[] }> {
  if (!(await released(clinicId))) return { released: false, results: [] };
  // The patient's merged record group (Phase 14): the person's results, one list.
  const patientIds = await patientRecordIds(clinicId, patientId);
  const { data, error } = await createAdminClient()
    .from("lab_results")
    .select("order_item_id, version, performed_at, verified_at, lab_result_values(flag), lab_order_items!lab_results_item_fkey(test_name_snapshot)")
    .eq("clinic_id", clinicId)
    .in("patient_id", patientIds)
    .eq("status", "verified")
    .order("verified_at", { ascending: false })
    .limit(200);
  if (error) throw loadFailed("list", error);
  type Row = {
    order_item_id: string;
    version: number;
    performed_at: string | null;
    verified_at: string;
    lab_result_values: Array<{ flag: string }>;
    lab_order_items: { test_name_snapshot: string } | null;
  };
  const results = ((data ?? []) as unknown as Row[])
    .map((r) => ({
      itemId: r.order_item_id,
      testName: r.lab_order_items?.test_name_snapshot ?? "Tahlil",
      date: r.performed_at ?? r.verified_at,
      corrected: r.version > 1,
      outsideRange: r.lab_result_values.filter((v) => v.flag !== "normal" && v.flag !== "not_evaluated").length,
    }))
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  return { released: true, results };
}

export type PatientResultDetail = {
  itemId: string;
  testName: string;
  date: string;
  verifiedAt: string;
  corrected: boolean;
  values: Array<{ parameter: string; value: string; unit: string | null; rangeLow: number | null; rangeHigh: number | null; rangeText: string | null; flag: string }>;
  documents: Array<{ id: string; kind: string; mimeType: string; sizeBytes: number }>;
};

const num = (v: number | string | null) => (v === null ? null : Number(v));

export async function getPatientLabResult(clinicId: string, patientId: string, itemId: string): Promise<PatientResultDetail> {
  if (!(await released(clinicId))) throw NOT_FOUND();
  const db = createAdminClient();
  const patientIds = await patientRecordIds(clinicId, patientId);
  const { data, error } = await db
    .from("lab_results")
    .select(
      "id, version, performed_at, verified_at, " +
        "lab_result_values(value_numeric, value_text, value_boolean, unit_snapshot, flag, range_low, range_high, range_text, lab_test_parameters(name, sort_order)), " +
        "lab_order_items!lab_results_item_fkey(test_name_snapshot)",
    )
    .eq("clinic_id", clinicId)
    .in("patient_id", patientIds)
    .eq("order_item_id", itemId)
    .eq("status", "verified")
    .maybeSingle();
  if (error) throw loadFailed("detail", error);
  if (!data) throw NOT_FOUND();
  type Row = {
    id: string;
    version: number;
    performed_at: string | null;
    verified_at: string;
    lab_result_values: Array<{
      value_numeric: number | string | null;
      value_text: string | null;
      value_boolean: boolean | null;
      unit_snapshot: string | null;
      flag: string;
      range_low: number | string | null;
      range_high: number | string | null;
      range_text: string | null;
      lab_test_parameters: { name: string; sort_order: number } | null;
    }>;
    lab_order_items: { test_name_snapshot: string } | null;
  };
  const r = data as unknown as Row;

  const { data: docs, error: docsError } = await db
    .from("lab_documents")
    .select("id, kind, mime_type, size_bytes")
    .eq("clinic_id", clinicId)
    .in("patient_id", patientIds)
    .eq("result_id", r.id)
    .is("withdrawn_at", null)
    .order("created_at");
  if (docsError) throw loadFailed("documents", docsError);

  await recordAudit({
    clinicId,
    action: "lab_result_viewed",
    entityType: "lab_results",
    entityId: r.id,
    patientId,
    actor: { actorType: "patient" },
    metadata: { order_item_id: itemId, version: r.version, via: "mini_app" },
    strict: true,
  });

  return {
    itemId,
    testName: r.lab_order_items?.test_name_snapshot ?? "Tahlil",
    date: r.performed_at ?? r.verified_at,
    verifiedAt: r.verified_at,
    corrected: r.version > 1,
    values: [...r.lab_result_values]
      .sort((a, b) => (a.lab_test_parameters?.sort_order ?? 0) - (b.lab_test_parameters?.sort_order ?? 0))
      .map((v) => ({
        parameter: v.lab_test_parameters?.name ?? "—",
        value:
          v.value_numeric !== null ? String(v.value_numeric) : v.value_boolean !== null ? (v.value_boolean ? "Ha" : "Yo‘q") : (v.value_text ?? "—"),
        unit: v.unit_snapshot,
        rangeLow: num(v.range_low),
        rangeHigh: num(v.range_high),
        rangeText: v.range_text,
        flag: v.flag,
      })),
    documents: (docs ?? []).map((d) => ({ id: d.id, kind: d.kind, mimeType: d.mime_type, sizeBytes: Number(d.size_bytes) })),
  };
}

/** A 60-second signed link to a document of the patient's own current verified result. Audited first. */
export async function getPatientDocumentLink(clinicId: string, patientId: string, documentId: string): Promise<{ url: string; expiresIn: number }> {
  if (!(await released(clinicId))) throw new ApiError(404, "Hujjat topilmadi", "document_not_found");
  const db = createAdminClient();
  const patientIds = await patientRecordIds(clinicId, patientId);
  const { data, error } = await db
    .from("lab_documents")
    .select("id, storage_path, result_id, kind, lab_results!lab_documents_result_fkey(status)")
    .eq("id", documentId)
    .eq("clinic_id", clinicId)
    .in("patient_id", patientIds)
    .is("withdrawn_at", null)
    .maybeSingle();
  if (error) throw loadFailed("document", error);
  const doc = data as unknown as { id: string; storage_path: string; result_id: string | null; kind: string; lab_results: { status: string } | null } | null;
  if (!doc || doc.lab_results?.status !== "verified") throw new ApiError(404, "Hujjat topilmadi", "document_not_found");

  await recordAudit({
    clinicId,
    action: "lab_document_viewed",
    entityType: "lab_documents",
    entityId: doc.id,
    patientId,
    actor: { actorType: "patient" },
    metadata: { result_id: doc.result_id, kind: doc.kind, via: "mini_app" },
    strict: true,
  });
  const expiresIn = 60;
  const { data: signed, error: signError } = await db.storage.from("lab-documents").createSignedUrl(doc.storage_path, expiresIn, { download: true });
  if (signError || !signed) {
    logger.error("patient lab results: signed url failed", { message: signError?.message });
    throw new ApiError(503, "Hujjatni ochib bo‘lmadi, keyinroq urinib ko‘ring", "document_unavailable");
  }
  return { url: signed.signedUrl, expiresIn };
}

/**
 * What the "result ready" message may say about one result version: whether
 * it is still the current verified version, whether the clinic releases
 * results, the patient's Telegram identity, the test name and date — never
 * values. Used by the notification worker (Phase 12).
 */
export type LabResultNotice = {
  current: boolean;
  released: boolean;
  telegramUserId: number | null;
  itemId: string;
  testName: string;
  date: string;
  corrected: boolean;
};

export async function loadLabResultNotice(clinicId: string, resultId: string): Promise<LabResultNotice | null> {
  const db = createAdminClient();
  const { data, error } = await db
    .from("lab_results")
    .select("status, version, patient_id, performed_at, verified_at, order_item_id, lab_order_items!lab_results_item_fkey(test_name_snapshot)")
    .eq("id", resultId)
    .eq("clinic_id", clinicId)
    .maybeSingle();
  if (error) throw loadFailed("notice", error);
  if (!data) return null;
  const r = data as unknown as {
    status: string;
    version: number;
    patient_id: string;
    performed_at: string | null;
    verified_at: string | null;
    order_item_id: string;
    lab_order_items: { test_name_snapshot: string } | null;
  };
  const [isReleased, patient] = await Promise.all([
    released(clinicId),
    // The person's Telegram identity lives on the canonical record after a merge (Phase 14).
    db.from("patients").select("telegram_user_id").eq("id", (await patientRecordIds(clinicId, r.patient_id))[0]).eq("clinic_id", clinicId).maybeSingle(),
  ]);
  if (patient.error) throw loadFailed("notice patient", patient.error);
  return {
    current: r.status === "verified",
    released: isReleased,
    telegramUserId: patient.data?.telegram_user_id ?? null,
    itemId: r.order_item_id,
    testName: r.lab_order_items?.test_name_snapshot ?? "Laboratoriya tahlili",
    date: r.performed_at ?? r.verified_at ?? new Date().toISOString(),
    corrected: r.version > 1,
  };
}

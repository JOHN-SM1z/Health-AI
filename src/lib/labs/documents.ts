import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { ApiError } from "@/lib/api/errors";
import { recordAudit } from "@/lib/audit";
import { logger } from "@/lib/logger";
import { resolveLabResultAccess, type ClinicStaff } from "@/lib/labs/guards";
import { LAB_DOCUMENT_MAX_BYTES, sniffLabDocumentType } from "@/lib/labs/file-type";

/**
 * Laboratory result documents (Phase 11): reports, scans, images and imported
 * source files, in the existing private bucket lab-documents with the same
 * conventions as voice-messages (<clinic_id>/<id>, server-only access).
 *
 *   upload     lab staff of the clinic; the file type comes from its bytes;
 *              1 byte … 20 MiB; attached to an order and, while the result is
 *              still a draft or in review, to that result (the database
 *              refuses a final one). The bytes go to storage first and the
 *              row second; if the row is refused the bytes are removed.
 *   retrieval  never a public URL: a 60-second signed link, issued after the
 *              role / clinic / patient check and audited.
 *   withdrawal with a reason; the row and the bytes are retained (clinical
 *              retention) and the document is no longer offered.
 *
 * Audit rows carry ids and kinds only — never file names or contents.
 */

export const DOCUMENT_KINDS = ["report", "scan", "image", "import_source"] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];

const LINK_SECONDS = 60;

function loadFailed(what: string, error: { code?: string; message?: string }) {
  logger.error(`lab documents: ${what} failed`, { code: error.code });
  return new ApiError(500, "Hujjatni qayta ishlab bo‘lmadi", "document_failed");
}

/** Lab staff only, and only for a patient of their clinic. */
async function requireLabAccess(staff: ClinicStaff, patientId: string) {
  const access = await resolveLabResultAccess(staff, patientId);
  if (access.kind !== "lab") throw new ApiError(404, "Buyurtma topilmadi", "order_not_found");
}

async function orderOf(staff: ClinicStaff, orderId: string) {
  const { data, error } = await createAdminClient()
    .from("lab_orders")
    .select("id, patient_id")
    .eq("id", orderId)
    .eq("clinic_id", staff.clinicId)
    .maybeSingle();
  if (error) throw loadFailed("order", error);
  if (!data) throw new ApiError(404, "Buyurtma topilmadi", "order_not_found");
  await requireLabAccess(staff, data.patient_id);
  return data;
}

async function documentOf(staff: ClinicStaff, documentId: string) {
  const { data, error } = await createAdminClient()
    .from("lab_documents")
    .select("id, patient_id, order_id, result_id, kind, storage_path, withdrawn_at")
    .eq("id", documentId)
    .eq("clinic_id", staff.clinicId)
    .maybeSingle();
  if (error) throw loadFailed("document", error);
  if (!data) throw new ApiError(404, "Hujjat topilmadi", "document_not_found");
  await requireLabAccess(staff, data.patient_id);
  return data;
}

// ---------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------

export type UploadInput = { resultId: string | null; kind: DocumentKind; bytes: Uint8Array };

export async function uploadLabDocument(staff: ClinicStaff, orderId: string, input: UploadInput): Promise<{ id: string; mimeType: string; sizeBytes: number }> {
  const order = await orderOf(staff, orderId);
  const db = createAdminClient();

  if (input.resultId) {
    const { data: result, error } = await db
      .from("lab_results")
      .select("id, status, lab_order_items!lab_results_item_fkey(order_id)")
      .eq("id", input.resultId)
      .eq("clinic_id", staff.clinicId)
      .maybeSingle();
    if (error) throw loadFailed("result", error);
    const r = result as unknown as { status: string; lab_order_items: { order_id: string } | null } | null;
    if (!r || r.lab_order_items?.order_id !== order.id) throw new ApiError(404, "Natija bu buyurtmaga tegishli emas", "result_not_found");
    if (r.status !== "draft" && r.status !== "submitted") {
      throw new ApiError(409, "Tasdiqlangan natijaga hujjat qo‘shilmaydi — tuzatish (yangi versiya) orqali qo‘shing", "result_final");
    }
  }

  if (input.bytes.byteLength === 0) throw new ApiError(400, "Fayl bo‘sh", "empty_file");
  if (input.bytes.byteLength > LAB_DOCUMENT_MAX_BYTES) throw new ApiError(413, "Fayl 20 MB dan katta", "file_too_large");
  const mimeType = sniffLabDocumentType(input.bytes);
  if (!mimeType) throw new ApiError(415, "Faqat PDF, JPEG, PNG yoki WebP fayl yuklanadi", "unsupported_file_type");

  const id = randomUUID();
  const path = `${staff.clinicId}/${id}`;
  const sha256 = createHash("sha256").update(input.bytes).digest("hex");

  const { error: uploadError } = await db.storage.from("lab-documents").upload(path, input.bytes, { contentType: mimeType, upsert: false });
  if (uploadError) {
    logger.error("lab documents: storage upload failed", { message: uploadError.message });
    throw new ApiError(503, "Faylni saqlab bo‘lmadi, keyinroq urinib ko‘ring", "storage_unavailable");
  }

  const { error: insertError } = await db.from("lab_documents").insert({
    id,
    clinic_id: staff.clinicId,
    patient_id: order.patient_id,
    order_id: order.id,
    result_id: input.resultId,
    kind: input.kind,
    storage_path: path,
    mime_type: mimeType,
    size_bytes: input.bytes.byteLength,
    sha256,
    uploaded_by: staff.profileId,
  });
  if (insertError) {
    // No row, no file: remove the orphaned bytes.
    await db.storage.from("lab-documents").remove([path]).catch(() => undefined);
    if (/lab_document_result_final/.test(insertError.message ?? "")) {
      throw new ApiError(409, "Tasdiqlangan natijaga hujjat qo‘shilmaydi — tuzatish (yangi versiya) orqali qo‘shing", "result_final");
    }
    throw loadFailed("insert", insertError);
  }
  return { id, mimeType, sizeBytes: input.bytes.byteLength };
}

// ---------------------------------------------------------------------------
// List / open / withdraw (lab workspace)
// ---------------------------------------------------------------------------

export type LabDocumentRow = {
  id: string;
  resultId: string | null;
  resultVersion: number | null;
  kind: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: string;
  uploadedByName: string | null;
  withdrawnAt: string | null;
  withdrawReason: string | null;
};

export async function listOrderDocuments(staff: ClinicStaff, orderId: string): Promise<LabDocumentRow[]> {
  const order = await orderOf(staff, orderId);
  const { data, error } = await createAdminClient()
    .from("lab_documents")
    .select(
      "id, result_id, kind, mime_type, size_bytes, created_at, withdrawn_at, withdraw_reason, " +
        "uploader:profiles!lab_documents_uploaded_by_fkey(full_name), lab_results!lab_documents_result_fkey(version)",
    )
    .eq("clinic_id", staff.clinicId)
    .eq("order_id", order.id)
    .order("created_at");
  if (error) throw loadFailed("list", error);
  type Row = {
    id: string;
    result_id: string | null;
    kind: string;
    mime_type: string;
    size_bytes: number;
    created_at: string;
    withdrawn_at: string | null;
    withdraw_reason: string | null;
    uploader: { full_name: string | null } | null;
    lab_results: { version: number } | null;
  };
  return ((data ?? []) as unknown as Row[]).map((d) => ({
    id: d.id,
    resultId: d.result_id,
    resultVersion: d.lab_results?.version ?? null,
    kind: d.kind,
    mimeType: d.mime_type,
    sizeBytes: Number(d.size_bytes),
    createdAt: d.created_at,
    uploadedByName: d.uploader?.full_name ?? null,
    withdrawnAt: d.withdrawn_at,
    withdrawReason: d.withdraw_reason,
  }));
}

/** A 60-second signed link for lab staff; withdrawn documents are not offered. Audited first. */
export async function getDocumentLinkForLab(staff: ClinicStaff, documentId: string): Promise<{ url: string; expiresIn: number }> {
  const doc = await documentOf(staff, documentId);
  if (doc.withdrawn_at) throw new ApiError(404, "Hujjat topilmadi", "document_not_found");
  await recordAudit({
    clinicId: staff.clinicId,
    action: "lab_document_viewed",
    entityType: "lab_documents",
    entityId: doc.id,
    patientId: doc.patient_id,
    actor: { actorId: staff.profileId, actorType: "staff" },
    metadata: { order_id: doc.order_id, result_id: doc.result_id, kind: doc.kind, via: "lab_workspace" },
    strict: true,
  });
  const { data, error } = await createAdminClient().storage.from("lab-documents").createSignedUrl(doc.storage_path, LINK_SECONDS);
  if (error || !data) {
    logger.error("lab documents: signed url failed", { message: error?.message });
    throw new ApiError(503, "Hujjatni ochib bo‘lmadi, keyinroq urinib ko‘ring", "storage_unavailable");
  }
  return { url: data.signedUrl, expiresIn: LINK_SECONDS };
}

/** Withdraws a document with a reason; the row and the file are retained, never deleted. */
export async function withdrawLabDocument(staff: ClinicStaff, documentId: string, reason: string): Promise<{ changed: boolean }> {
  const doc = await documentOf(staff, documentId);
  if (doc.withdrawn_at) throw new ApiError(409, "Hujjat allaqachon olib tashlangan", "already_withdrawn");
  const { data, error } = await createAdminClient()
    .from("lab_documents")
    .update({ withdrawn_by: staff.profileId, withdraw_reason: reason, withdrawn_at: new Date().toISOString() })
    .eq("id", doc.id)
    .eq("clinic_id", staff.clinicId)
    .is("withdrawn_at", null)
    .select("id");
  if (error) {
    if (/already withdrawn/.test(error.message ?? "")) throw new ApiError(409, "Hujjat allaqachon olib tashlangan", "already_withdrawn");
    throw loadFailed("withdraw", error);
  }
  if (!data || data.length === 0) throw new ApiError(409, "Hujjat allaqachon olib tashlangan", "already_withdrawn");
  return { changed: true };
}

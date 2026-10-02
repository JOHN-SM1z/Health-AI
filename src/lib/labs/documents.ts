import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { ApiError } from "@/lib/api/errors";
import { recordAudit } from "@/lib/audit";
import { logger } from "@/lib/logger";

/**
 * Laboratory result documents (phase 7): a PDF report, a scan, a photo, an imported report — in the project's private storage
 * (bucket `lab-documents`, clinic-scoped paths, server-only access; the same architecture as the voice-message bucket).
 *
 * There is NO public, signed or otherwise shareable URL. A document is reached only through a route that, for that request,
 * re-checks the clinic, the patient, the caller's authorisation and that the document belongs to that result of that patient -
 * so a forged, guessed or leaked id/URL gives nothing to anyone who is not authorised for it right now.
 *
 * Upload (laboratory staff): the size is limited, the type is decided by the file's own signature (never the client's content type or
 * name), the storage path is built here from the database's own ids, the sha256 is stored and checked on every download. Nothing about
 * the file's name is kept. Documents are never edited or deleted.
 */

export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;
export const DOCUMENT_KINDS = ["report", "scan", "image", "imported"] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];
const BUCKET = "lab-documents";

type Detected = { contentType: "application/pdf" | "image/png" | "image/jpeg"; extension: "pdf" | "png" | "jpg" };

/** The type of a file from its first bytes. Anything else is refused; the client's claim is never used. */
export function detectDocumentType(bytes: Uint8Array): Detected | null {
  const starts = (sig: number[]) => sig.every((b, i) => bytes[i] === b);
  if (bytes.length >= 5 && starts([0x25, 0x50, 0x44, 0x46, 0x2d])) return { contentType: "application/pdf", extension: "pdf" };
  if (bytes.length >= 8 && starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { contentType: "image/png", extension: "png" };
  if (bytes.length >= 3 && starts([0xff, 0xd8, 0xff])) return { contentType: "image/jpeg", extension: "jpg" };
  return null;
}

export type DocumentView = { id: string; kind: DocumentKind; contentType: string; sizeBytes: number; addedAt: string };

function uploadError(error: { code?: string; message?: string }): ApiError {
  const m = error.message ?? "";
  if (m.includes("start a correction")) return new ApiError(409, "Natija tasdiqlangan — hujjat qo‘shish uchun avval tuzatish kiriting", "already_verified");
  if (m.includes("at most 20")) return new ApiError(409, "Bir natijaga 20 tadan ko‘p hujjat qo‘shib bo‘lmaydi", "too_many_documents");
  if (m.includes("cancelled")) return new ApiError(409, "Buyurtma yoki tahlil bekor qilingan", "order_closed");
  if (m.includes("only active lab staff")) return new ApiError(403, "Bu amal uchun ruxsat yo‘q", "forbidden");
  logger.error("lab document insert failed", { code: error.code });
  return new ApiError(500, "Hujjatni saqlab bo‘lmadi", "lab_document_failed");
}

/** Adds a document to the result of an ordered test. Laboratory staff only (the route requires the role). */
export async function uploadLabDocument(
  staff: { clinicId: string; profileId: string },
  itemId: string,
  input: { kind: DocumentKind; bytes: Uint8Array },
): Promise<DocumentView> {
  if (input.bytes.length === 0) throw new ApiError(400, "Fayl bo‘sh", "validation");
  if (input.bytes.length > MAX_DOCUMENT_BYTES) throw new ApiError(413, "Fayl hajmi 10 MB dan oshmasligi kerak", "file_too_large");
  const detected = detectDocumentType(input.bytes);
  if (!detected) throw new ApiError(415, "Faqat PDF, PNG yoki JPEG fayllar qabul qilinadi", "unsupported_type");

  const db = createAdminClient();
  const { data: result } = await db
    .from("lab_results")
    .select("id, patient_id, lab_order_items!inner(id)")
    .eq("clinic_id", staff.clinicId)
    .eq("order_item_id", itemId)
    .maybeSingle();
  if (!result) throw new ApiError(404, "Natija topilmadi — avval natija qoralamasini saqlang", "lab_not_found");

  const id = randomUUID();
  const path = `${staff.clinicId}/${result.patient_id}/${result.id}/${id}.${detected.extension}`;
  const { error: uploadErr } = await db.storage.from(BUCKET).upload(path, input.bytes, { contentType: detected.contentType, upsert: false });
  if (uploadErr) {
    logger.error("lab document upload failed", { message: uploadErr.message });
    throw new ApiError(500, "Hujjatni saqlab bo‘lmadi", "lab_document_failed");
  }
  const { data, error } = await db
    .from("lab_result_attachments")
    .insert({
      id,
      clinic_id: staff.clinicId,
      result_id: result.id,
      storage_path: path,
      content_type: detected.contentType,
      size_bytes: input.bytes.length,
      sha256: createHash("sha256").update(input.bytes).digest("hex"),
      uploaded_by: staff.profileId,
      kind: input.kind,
    })
    .select("id, kind, content_type, size_bytes, created_at")
    .single();
  if (error || !data) {
    // The database refused the row: the object must not stay behind.
    await db.storage.from(BUCKET).remove([path]);
    throw uploadError(error ?? {});
  }
  return { id: data.id, kind: data.kind as DocumentKind, contentType: data.content_type, sizeBytes: Number(data.size_bytes), addedAt: data.created_at };
}

export type DownloadedDocument = { bytes: Uint8Array; contentType: string; id: string };

/**
 * Reads a stored document after the caller has been authorised. `where` is what the caller proved: the document must belong to
 * this clinic AND to this patient's result (and, for doctors, to a result that is finalised and was verified after the document was
 * added). The bytes are checked against the stored sha256; a mismatch is an error, never a download.
 */
export async function readLabDocument(
  clinicId: string,
  documentId: string,
  where: { patientId?: string; finalisedOnly: boolean },
): Promise<DownloadedDocument & { patientId: string; resultId: string }> {
  const db = createAdminClient();
  const { data: doc } = await db
    .from("lab_result_attachments")
    .select("id, storage_path, content_type, sha256, created_at, result_id, lab_results!inner(id, patient_id, order_item_id)")
    .eq("id", documentId)
    .eq("clinic_id", clinicId)
    .maybeSingle();
  const result = doc?.lab_results as unknown as { id: string; patient_id: string } | null;
  if (!doc || !result || (where.patientId && result.patient_id !== where.patientId)) throw new ApiError(404, "Hujjat topilmadi", "document_not_found");

  if (where.finalisedOnly) {
    // Only a document that was part of the finalised result: added before the standing verified version was verified.
    const { data: verified } = await db
      .from("lab_result_versions")
      .select("verified_at")
      .eq("clinic_id", clinicId)
      .eq("result_id", result.id)
      .eq("status", "verified")
      .maybeSingle();
    if (!verified?.verified_at || doc.created_at > verified.verified_at) throw new ApiError(404, "Hujjat topilmadi", "document_not_found");
  }

  const { data: file, error } = await db.storage.from(BUCKET).download(doc.storage_path);
  if (error || !file) {
    logger.error("lab document download failed", { message: error?.message });
    throw new ApiError(500, "Hujjatni o‘qib bo‘lmadi", "lab_document_failed");
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (createHash("sha256").update(bytes).digest("hex") !== doc.sha256) {
    logger.error("lab document integrity check failed", { documentId });
    throw new ApiError(500, "Hujjat butunligi tekshiruvdan o‘tmadi", "lab_document_corrupt");
  }
  return { id: doc.id, bytes, contentType: doc.content_type, patientId: result.patient_id, resultId: result.id };
}

/** The response for a stored document: never cached, never sniffed, never run as a page. */
export function documentResponse(doc: { bytes: Uint8Array; contentType: string; id: string }): Response {
  const extension = doc.contentType === "application/pdf" ? "pdf" : doc.contentType === "image/png" ? "png" : "jpg";
  return new Response(doc.bytes as unknown as BodyInit, {
    headers: {
      "Content-Type": doc.contentType,
      "Content-Length": String(doc.bytes.length),
      "Content-Disposition": `inline; filename="lab-document-${doc.id.slice(0, 8)}.${extension}"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    },
  });
}

export async function auditDocumentRead(
  clinicId: string,
  actor: { profileId: string },
  doc: { id: string; patientId: string; resultId: string },
  via: "doctor" | "laboratory",
): Promise<void> {
  await recordAudit({
    clinicId,
    action: "lab_document_downloaded",
    entityType: "lab_result_attachments",
    entityId: doc.id,
    patientId: doc.patientId,
    actor: { actorId: actor.profileId, actorType: "staff" },
    metadata: { result_id: doc.resultId, via },
    strict: true,
  });
}

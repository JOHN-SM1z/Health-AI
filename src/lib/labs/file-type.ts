/**
 * What a lab document file really is, from its first bytes (Phase 11). The
 * name and the type the browser declares are never trusted: a renamed
 * executable or HTML page is refused however it is labelled.
 */

export type LabDocumentMime = "application/pdf" | "image/jpeg" | "image/png" | "image/webp";

/** The bucket's and the table's limit (20 MiB). */
export const LAB_DOCUMENT_MAX_BYTES = 20 * 1024 * 1024;

export function sniffLabDocumentType(bytes: Uint8Array): LabDocumentMime | null {
  const starts = (...sig: number[]) => sig.every((b, i) => bytes[i] === b);
  if (starts(0x25, 0x50, 0x44, 0x46, 0x2d)) return "application/pdf"; // %PDF-
  if (starts(0xff, 0xd8, 0xff)) return "image/jpeg";
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  if (starts(0x52, 0x49, 0x46, 0x46) && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
    return "image/webp"; // RIFF....WEBP
  }
  return null;
}

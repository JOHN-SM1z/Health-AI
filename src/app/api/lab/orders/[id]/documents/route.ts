import type { NextRequest } from "next/server";
import { z } from "zod";
import { ApiError, handleApiError, ok } from "@/lib/api/errors";
import { uuidSchema } from "@/lib/api/validate";
import { requireLabCapability } from "@/lib/labs/guards";
import { DOCUMENT_KINDS, listOrderDocuments, uploadLabDocument } from "@/lib/labs/documents";
import { LAB_DOCUMENT_MAX_BYTES } from "@/lib/labs/file-type";
import { sharedRateLimit } from "@/lib/rate-limit-shared";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

async function orderIdOf(ctx: RouteContext): Promise<string> {
  const { id } = await ctx.params;
  if (!uuidSchema.safeParse(id).success) throw new ApiError(404, "Buyurtma topilmadi", "order_not_found");
  return id;
}

/** The order's documents (metadata only; withdrawn ones marked). Lab staff. */
export async function GET(_request: NextRequest, ctx: RouteContext) {
  try {
    const staff = await requireLabCapability("document.upload");
    return ok({ documents: await listOrderDocuments(staff, await orderIdOf(ctx)) });
  } catch (e) {
    return handleApiError(e);
  }
}

const fieldsSchema = z.object({
  kind: z.enum(DOCUMENT_KINDS),
  resultId: uuidSchema.nullable(),
});

/**
 * Uploads one document (multipart: file, kind, resultId?). The type is read
 * from the file's bytes; the browser's name and type are ignored. Lab staff.
 */
export async function POST(request: NextRequest, ctx: RouteContext) {
  try {
    const staff = await requireLabCapability("document.upload");
    const limit = await sharedRateLimit({ key: `lab-document-upload:${staff.profileId}`, limit: 30, windowMs: 60_000 });
    if (!limit.ok) throw new ApiError(429, "Juda ko‘p so‘rov, birozdan keyin urinib ko‘ring", "rate_limited");
    const orderId = await orderIdOf(ctx);

    // A multipart POST is the one request a foreign page can send without
    // CORS: refuse any Origin other than this site's own.
    const origin = request.headers.get("origin");
    const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
    const originHost = (() => {
      try {
        return origin ? new globalThis.URL(origin).host : null;
      } catch {
        return ""; // "null" or garbage: never this site
      }
    })();
    if (origin && (!host || originHost !== host)) {
      throw new ApiError(403, "So‘rov boshqa saytdan yuborilgan", "cross_site_request");
    }

    // Refuse an oversized body before reading it (multipart overhead allowed).
    const declared = Number(request.headers.get("content-length") ?? "0");
    if (declared > LAB_DOCUMENT_MAX_BYTES + 64 * 1024) throw new ApiError(413, "Fayl 20 MB dan katta", "file_too_large");

    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      throw new ApiError(400, "Fayl yuborilmadi", "invalid_form");
    }
    const file = form.get("file");
    if (!(file instanceof Blob)) throw new ApiError(400, "Fayl yuborilmadi", "invalid_form");
    if (file.size > LAB_DOCUMENT_MAX_BYTES) throw new ApiError(413, "Fayl 20 MB dan katta", "file_too_large");
    const fields = fieldsSchema.safeParse({ kind: form.get("kind"), resultId: form.get("resultId") || null });
    if (!fields.success) throw new ApiError(400, "Hujjat turi yoki natija noto‘g‘ri", "invalid_form");

    const result = await uploadLabDocument(staff, orderId, {
      kind: fields.data.kind,
      resultId: fields.data.resultId,
      bytes: new Uint8Array(await file.arrayBuffer()),
    });
    return ok(result, { status: 201 });
  } catch (e) {
    return handleApiError(e);
  }
}
